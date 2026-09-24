/*!
 * Copyright (c) 2026 Signature Management Consultants SLU
 * Author: @ancongui (https://github.com/ancongui)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  BridgeError,
  terminal,
  type Job,
  type Principal,
} from "./contracts.js";
import {
  prepareCompletion,
  parseCompletionResult,
  type ChatRequest,
} from "./completion-protocol.js";
import type { HttpDependencies } from "./http.js";

export class CompletionError extends BridgeError {
  constructor(
    code: string,
    message: string,
    status: number,
    public retryAfter?: number,
  ) {
    super(code, message, status);
  }
}
export function openAIError(
  error: BridgeError,
  requestId?: string,
  jobId?: string,
) {
  return {
    error: {
      message: error.message,
      type:
        error.status === 401
          ? "authentication_error"
          : error.status === 429
            ? "rate_limit_error"
            : error.status >= 500
              ? "server_error"
              : "invalid_request_error",
      param: null,
      code: error.code,
      ...(requestId ? { requestId } : {}),
      ...(jobId ? { job_id: jobId } : {}),
    },
  };
}
function paused(reason: string, retryAt?: number) {
  const quota = reason.startsWith("quota_exhausted");
  return new CompletionError(
    quota ? "quota_exhausted" : "execution_paused",
    reason,
    quota ? 429 : 503,
    retryAt ? Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)) : undefined,
  );
}
function completed(job: Job, request: ChatRequest) {
  const output = job.completion
    ? parseCompletionResult(job.result ?? "", request)
    : { content: job.result ?? "", toolCalls: [] };
  return {
    id: "chatcmpl-" + job.id,
    object: "chat.completion",
    created: Math.floor(Date.parse(job.createdAt) / 1000),
    model: request.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: output.content,
          ...(output.toolCalls.length
            ? {
                tool_calls: output.toolCalls.map((c, index) => ({
                  id: "call_" + job.id.replaceAll("-", "") + "_" + index,
                  type: "function",
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        },
        finish_reason: output.toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    ...(job.usage ? { usage: job.usage } : {}),
  };
}
export function registerOpenAI(
  app: FastifyInstance,
  d: HttpDependencies,
  scope: (req: FastifyRequest, scope: string) => Principal,
) {
  const waiters = new Map<
    AbortController,
    { principal: string; job: string; settled: Promise<void> }
  >();
  let stopping = false;
  app.addHook("preClose", async () => {
    stopping = true;
    const settled = [...waiters.values()].map((w) => w.settled);
    for (const c of waiters.keys())
      c.abort(
        new BridgeError(
          "service_stopping",
          "Bridge is stopping; inspect the durable job before retrying",
          503,
        ),
      );
    // Flush small terminal errors, then let Fastify close all remaining TCP sockets.
    // Canceled HTTP clients can open idle replacement sockets without a request.
    await Promise.race([Promise.allSettled(settled), delay(200)]);
  });
  app.get("/v1/models", async (req) => {
    const p = scope(req, "read");
    return {
      object: "list",
      data: Object.keys(d.config.profiles)
        .filter((n) => p.owner || p.profiles.includes(n))
        .map((n) => ({
          id: "bridge/" + n,
          object: "model",
          created: 0,
          owned_by: "signature-organization",
        })),
    };
  });
  app.post("/v1/chat/completions", async (req, reply) => {
    scope(req, "read");
    const p = scope(req, "submit");
    const { request, prompt } = prepareCompletion(req.body);
    const profile = request.model.slice("bridge/".length);
    if (
      !d.config.profiles[profile] ||
      (!p.owner && !p.profiles.includes(profile))
    )
      throw new BridgeError(
        "model_not_found",
        "Model is unavailable to this client",
        404,
      );
    if (stopping)
      throw new BridgeError("service_stopping", "Bridge is stopping", 503);
    if (
      !request.bridge.background &&
      (waiters.size >= d.config.openai.maxConnections ||
        [...waiters.values()].filter((w) => w.principal === p.id).length >= 4)
    )
      throw new BridgeError(
        "connections_full",
        "Too many active completion requests",
        429,
      );
    const key = req.headers["idempotency-key"];
    if (Array.isArray(key))
      throw new BridgeError("invalid_header", "Use one idempotency key");
    const job = d.store.idempotent(
      p,
      "chat/completions",
      key,
      request,
      () => {
        const gate = d.scheduler.controlState;
        if (gate.paused)
          throw paused(gate.reason ?? "operator_pause", gate.retryAt);
        return d.store.submit(
          {
            prompt,
            profile,
            mode: request.bridge.execution === "channel" ? "channel" : "cli",
          },
          p,
          undefined,
          request.bridge.execution === "inference" ? request : undefined,
        );
      },
      (id) => d.store.get(id, p),
    );
    reply.header("X-Bridge-Job-Id", job.id);
    d.scheduler.wake();
    if (request.bridge.background) return reply.code(202).send(job);
    const controller = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    waiters.set(controller, { principal: p.id, job: job.id, settled });
    const signal = controller.signal;
    const timeout = setTimeout(
      () =>
        controller.abort(
          new BridgeError(
            "completion_timeout",
            "Completion deadline exceeded; inspect X-Bridge-Job-Id",
            504,
          ),
        ),
      d.config.openai.timeoutMs,
    );
    const disconnected = () => {
      if (!reply.raw.writableEnded)
        controller.abort(
          new BridgeError("client_disconnected", "Client disconnected", 499),
        );
    };
    reply.raw.on("close", disconnected);
    const bearer = req.headers.authorization!.slice(7);
    let retained = false,
      heartbeat: ReturnType<typeof setInterval> | undefined;
    async function write(data: unknown) {
      if (signal.aborted) throw signal.reason;
      if (
        !reply.raw.write(
          "data: " +
            (typeof data === "string" ? data : JSON.stringify(data)) +
            "\n\n",
        )
      )
        await once(reply.raw, "drain", { signal });
    }
    try {
      if (request.stream) {
        reply
          .header("Content-Type", "text/event-stream; charset=utf-8")
          .header("Cache-Control", "no-store")
          .header("X-Accel-Buffering", "no");
        reply.hijack();
        for (const [name, value] of Object.entries(reply.getHeaders()))
          if (value !== undefined) reply.raw.setHeader(name, value);
        reply.raw.writeHead(200);
        reply.raw.write(": waiting for validated completion\n\n");
        heartbeat = setInterval(() => {
          if (!reply.raw.write(": waiting\n\n"))
            controller.abort(
              new BridgeError(
                "slow_client",
                "Client is not consuming the response",
                499,
              ),
            );
        }, 5000);
      }
      let current: Job;
      for (;;) {
        if (signal.aborted) throw signal.reason;
        d.auth.verify(bearer);
        current = d.store.get(job.id, p);
        if (current.status === "succeeded") break;
        if (
          current.status === "paused" ||
          current.status === "pause_requested"
        ) {
          retained = true;
          throw paused(current.error ?? "operator_pause", current.retryAt);
        }
        if (terminal.has(current.status))
          throw new BridgeError(
            current.error?.startsWith("invalid_completion")
              ? "invalid_completion"
              : "execution_failed",
            current.error ?? "Execution did not complete",
            current.status === "timed_out" ? 504 : 502,
          );
        if (
          !d.scheduler.readiness.ready &&
          d.scheduler.readiness.reason &&
          !d.scheduler.readiness.reason.startsWith("Checking")
        )
          throw new BridgeError(
            "execution_unavailable",
            d.scheduler.readiness.reason,
            503,
          );
        await delay(25, undefined, { signal }).catch(() => {
          throw signal.reason;
        });
      }
      const result = completed(current, request);
      if (!request.stream) return reply.send(result);
      const chunk = (delta: unknown, finish_reason: string | null = null) => ({
        ...result,
        object: "chat.completion.chunk",
        usage: null,
        choices: [{ index: 0, delta, finish_reason }],
      });
      await write(chunk({ role: "assistant", content: "" }));
      const message = result.choices[0]!.message;
      if (message.content !== null)
        await write(chunk({ content: message.content }));
      if (message.tool_calls)
        await write(
          chunk({
            tool_calls: message.tool_calls.map((c, index) => ({ ...c, index })),
          }),
        );
      await write(chunk({}, result.choices[0]!.finish_reason));
      if (request.stream_options?.include_usage && current.usage)
        await write({
          ...result,
          object: "chat.completion.chunk",
          choices: [],
          usage: current.usage,
        });
      await write("[DONE]");
      reply.raw.end();
      return reply;
    } catch (caught) {
      const error =
        caught instanceof BridgeError
          ? caught
          : new BridgeError(
              "internal_error",
              "Completion could not be delivered",
              500,
            );
      if (error.code === "service_stopping") retained = true;
      if (request.stream) {
        if (!reply.raw.destroyed) {
          reply.raw.end(
            "data: " +
              JSON.stringify(openAIError(error, req.id, job.id)) +
              "\n\ndata: [DONE]\n\n",
          );
        }
        return reply;
      }
      if (error instanceof CompletionError && error.retryAfter)
        reply.header("Retry-After", error.retryAfter);
      return reply
        .code(error.status === 499 ? 400 : error.status)
        .send(openAIError(error, req.id, job.id));
    } finally {
      clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      reply.raw.removeListener("close", disconnected);
      waiters.delete(controller);
      settle();
      // An idempotency key may have several attached HTTP waiters. Only the last
      // detached waiter owns cleanup; durable operator/provider pauses are retained.
      if (!retained && ![...waiters.values()].some((w) => w.job === job.id)) {
        const current = d.store.get(job.id, p);
        if (
          !terminal.has(current.status) &&
          current.status !== "paused" &&
          current.status !== "pause_requested"
        ) {
          d.store.cancel(job.id, p);
          d.scheduler.wake();
        }
      }
    }
  });
}
