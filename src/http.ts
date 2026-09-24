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

import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import { BridgeError, terminal, type Principal } from "./contracts.js";
import { parseConfig, templateSchema, type BridgeConfig } from "./config.js";
import { QueueStore } from "./store.js";
import { Tokens } from "./auth.js";
import { Scheduler } from "./scheduler.js";
import { Workflows } from "./workflows.js";
import { EventStreams } from "./events.js";
import { Channels } from "./channels.js";
import { uiAssets } from "./ui-assets.js";
import { registerOpenAI, CompletionError, openAIError } from "./openai.js";
export type HttpDependencies = {
  store: QueueStore;
  auth: Tokens;
  scheduler: Scheduler;
  flows: Workflows;
  config: BridgeConfig;
  diagnostics?: () => Record<string, unknown>;
  heartbeat?: (id: string) => void;
  disconnect?: (id: string) => void;
  shutdown?: () => void;
  persistConfig?: (config: BridgeConfig) => void;
};
export function createHttpService(d: HttpDependencies) {
  const app = Fastify({
    logger: false,
    bodyLimit: 120000,
    requestTimeout: 30000,
    trustProxy: false,
    forceCloseConnections: true,
  });
  const streams = new EventStreams(d.store, d.auth),
    principals = new WeakMap<FastifyRequest, Principal>();
  const channels = new Channels(d.store);
  const reaper = setInterval(() => channels.reap(), 1000);
  reaper.unref();
  const rate = new Map<string, { count: number; since: number }>();
  const identity = (req: FastifyRequest): Principal => principals.get(req)!;
  const owner = (req: FastifyRequest) => {
    const p = identity(req);
    if (!p.owner)
      throw new BridgeError(
        "forbidden",
        "Owner authentication is required",
        403,
      );
    return p;
  };
  const requireScope = (req: FastifyRequest, scope: string) => {
    const p = identity(req);
    if (!p.owner && !p.scopes?.includes(scope))
      throw new BridgeError(
        "forbidden",
        "This token does not permit this operation",
        403,
      );
    return p;
  };
  const key = (req: FastifyRequest) => {
    const value = req.headers["idempotency-key"];
    if (Array.isArray(value))
      throw new BridgeError("invalid_header", "Use one idempotency key");
    return value;
  };
  const id = (req: FastifyRequest) =>
    z.strictObject({ id: z.string().uuid() }).parse(req.params).id;
  app.setErrorHandler((error, req, reply) => {
    const status =
      error instanceof BridgeError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : typeof error === "object" && error && "statusCode" in error
            ? Number(error.statusCode)
            : 500;
    const code =
      error instanceof BridgeError
        ? error.code
        : status === 400
          ? "invalid_request"
          : status === 413
            ? "body_too_large"
            : status === 429
              ? "rate_limited"
              : "internal_error";
    if (error instanceof CompletionError && error.retryAfter)
      reply.header("Retry-After", error.retryAfter);
    return reply
      .code(status)
      .send(
        openAIError(
          new BridgeError(
            code,
            error instanceof BridgeError
              ? error.message
              : status < 500
                ? "Request validation failed"
                : "Request could not be completed",
            status,
          ),
          req.id,
        ),
      );
  });
  app.setNotFoundHandler(() => {
    throw new BridgeError("not_found", "Endpoint not found", 404);
  });
  registerOpenAI(app, d, requireScope);
  app.addHook("onRequest", async (req, reply) => {
    let hostname: string;
    try {
      hostname = new URL("http://" + req.headers.host).hostname;
    } catch {
      throw new BridgeError("invalid_host", "Invalid Host header", 403);
    }
    if (!d.config.allowedHosts.includes(hostname))
      throw new BridgeError("invalid_host", "Host is not allowed", 403);
    const origin = req.headers.origin;
    if (
      origin &&
      origin !== "http://" + req.headers.host &&
      !d.config.allowedOrigins.includes(origin)
    )
      throw new BridgeError("invalid_origin", "Origin is not allowed", 403);
    if (!req.url.startsWith("/v1/")) return;
    // Browser preflight carries no bearer token. Only approved origins receive CORS headers;
    // the subsequent command still passes the normal authentication and scope checks.
    if (origin)
      reply
        .header("Access-Control-Allow-Origin", origin)
        .header("Access-Control-Expose-Headers", "X-Bridge-Job-Id, Retry-After")
        .header("Vary", "Origin");
    if (req.method === "OPTIONS" && origin) {
      reply
        .header(
          "Access-Control-Allow-Methods",
          "GET, POST, PUT, DELETE, OPTIONS",
        )
        .header(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, Idempotency-Key, Last-Event-ID",
        )
        .header("Access-Control-Max-Age", "600");
      return reply.code(204).send();
    }
    if (new URL(req.url, "http://localhost").searchParams.has("token"))
      throw new BridgeError(
        "invalid_auth",
        "Query-string tokens are not accepted",
      );
    const match = req.headers.authorization?.match(
      /^Bearer (sab_[A-Za-z0-9_-]+)$/,
    );
    if (!match)
      throw new BridgeError(
        "unauthorized",
        "Bearer authentication is required",
        401,
      );
    const principal = d.auth.verify(match[1]!);
    principals.set(req, principal);
    // Polling must never starve leases or an operator's stop request.
    const path = req.url.split("?")[0]!;
    const traffic =
      req.method === "POST" && path.startsWith("/v1/bridge/hosts/")
        ? "lease"
        : req.method === "POST" &&
            /\/(?:cancel|pause|resume|stop|stopped)$/.test(path)
          ? "control"
          : "requests";
    const bucket = principal.id + ":" + traffic;
    const now = Date.now();
    let entry = rate.get(bucket);
    if (!entry || now - entry.since >= 60000) {
      entry = { count: 0, since: now };
      rate.set(bucket, entry);
    }
    if (++entry.count > 240)
      throw new BridgeError("rate_limited", "Request rate limit reached", 429);
    if (rate.size > 1000)
      for (const [k, v] of rate) if (now - v.since >= 60000) rate.delete(k);
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "no-store")
      .header(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
    return payload;
  });
  app.addHook("preClose", async () => {
    clearInterval(reaper);
    streams.close();
  });
  app.get("/v1/bridge/status", async (req) => {
    const p = requireScope(req, "read");
    return {
      version: "0.1.0",
      protocolVersion: 2,
      eventCursorFloor: d.store.eventFloor(),
      permissionMode: "bypassPermissions",
      execution: "local-claude-code",
      activeJobs: d.scheduler.activeCount,
      readiness: d.scheduler.readiness,
      scheduler: d.scheduler.controlState,
      eventConnections: streams.count,
      profiles: Object.keys(d.config.profiles).filter(
        (name) => p.owner || p.profiles.includes(name),
      ),
      templates: d.flows.templates
        .filter(
          (t) =>
            p.owner || t.steps.every((s) => p.profiles.includes(s.profile)),
        )
        .map((t) => ({ id: t.id, inputs: t.inputs, steps: t.steps.length })),
      ...(p.owner ? d.diagnostics?.() : {}),
    };
  });
  app.get("/v1/bridge/jobs", async (req) => {
    const p = requireScope(req, "read");
    const q = z
      .strictObject({
        limit: z.coerce.number().int().min(1).max(200).default(100),
        after: z.string().default(""),
        order: z.enum(["asc", "desc"]).default("asc"),
      })
      .parse(req.query);
    const jobs = d.store.list(p, q.limit, q.after, q.order);
    return {
      jobs,
      nextCursor: jobs.length === q.limit ? jobs.at(-1)?.id : null,
    };
  });
  app.get("/v1/bridge/jobs/:id", async (req) =>
    d.store.get(id(req), requireScope(req, "read")),
  );
  app.get("/v1/bridge/jobs/:id/attempts", async (req) => ({
    attempts: d.store.attempts(id(req), requireScope(req, "read")).map((a) => ({
      id: a.id,
      jobId: a.jobId,
      status: a.status,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    })),
  }));
  app.post("/v1/bridge/jobs/:id/pause", async (req) => {
    const job = d.store.pause(id(req), requireScope(req, "control"));
    d.scheduler.wake();
    return job;
  });
  app.post("/v1/bridge/jobs/:id/resume", async (req) => {
    const p = requireScope(req, "control"),
      job = d.store.get(id(req), p);
    if (job.workflowRunId && d.flows.get(job.workflowRunId, p).pauseRequested)
      throw new BridgeError(
        "workflow_paused",
        "Resume the workflow first",
        409,
      );
    const resumed = d.store.resume(job.id, p);
    d.scheduler.wake();
    return resumed;
  });
  app.get("/v1/bridge/jobs/:id/result", async (req, reply) => {
    const job = d.store.get(id(req), requireScope(req, "read"));
    return reply.code(terminal.has(job.status) ? 200 : 202).send({
      id: job.id,
      status: job.status,
      result: job.result,
      error: job.error,
    });
  });
  app.get("/v1/bridge/jobs/:id/messages", async (req) => {
    const job = d.store.get(id(req), requireScope(req, "read"));
    return { messages: job.messages, pending: job.pendingMessages ?? [] };
  });
  app.post("/v1/bridge/jobs/:id/messages", async (req, reply) => {
    const p = requireScope(req, "submit");
    const { text } = z
      .strictObject({ text: z.string().trim().min(1).max(100000) })
      .parse(req.body);
    const job = d.store.get(id(req), p);
    if (!p.owner && !p.profiles.includes(job.profile))
      throw new BridgeError("profile_forbidden", "Profile is unavailable", 403);
    const updated = d.store.sendMessage(job.id, text, p, key(req));
    d.scheduler.wake();
    return reply.code(202).send(updated);
  });
  app.post("/v1/bridge/jobs/:id/cancel", async (req) => {
    const job = d.store.cancel(id(req), requireScope(req, "control"));
    d.scheduler.wake();
    return job;
  });
  app.post("/v1/bridge/jobs/:id/retry", async (req, reply) => {
    const p = requireScope(req, "control");
    const job = d.store.get(id(req), p);
    if (!p.owner && !p.profiles.includes(job.profile))
      throw new BridgeError("profile_forbidden", "Profile is unavailable", 403);
    const updated = d.flows.retryJob(job.id, p);
    d.scheduler.wake();
    return reply.code(202).send(updated);
  });
  app.get("/v1/bridge/events", async (req, reply) => {
    const p = requireScope(req, "read");
    const raw = req.headers["last-event-id"] ?? String(d.store.eventFloor());
    const cursor = z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .parse(raw);
    streams.open(reply, p, req.headers.authorization!.slice(7), cursor);
  });
  app.post("/v1/bridge/workflow-runs", async (req, reply) => {
    const p = requireScope(req, "workflows");
    const input = z
      .strictObject({
        templateId: z.string(),
        inputs: z.record(z.string(), z.string()),
      })
      .parse(req.body);
    const run = d.flows.start(input.templateId, input.inputs, p, key(req));
    d.scheduler.wake();
    return reply.code(202).send(run);
  });
  app.get("/v1/bridge/workflow-runs", async (req) => ({
    runs: d.flows.list(requireScope(req, "read")),
  }));
  app.get("/v1/bridge/workflow-runs/:id", async (req) =>
    d.flows.get(id(req), requireScope(req, "read")),
  );
  app.post("/v1/bridge/workflow-runs/:id/cancel", async (req) => {
    const run = d.flows.cancel(id(req), requireScope(req, "control"));
    d.scheduler.wake();
    return run;
  });
  app.post("/v1/bridge/workflow-runs/:id/pause", async (req) => {
    const run = d.flows.pause(id(req), requireScope(req, "control"));
    d.scheduler.wake();
    return run;
  });
  app.post("/v1/bridge/workflow-runs/:id/resume", async (req) => {
    const run = d.flows.resume(id(req), requireScope(req, "control"));
    d.scheduler.wake();
    return run;
  });
  app.post("/v1/bridge/admin/pause", async (req) => {
    owner(req);
    d.scheduler.pause();
    return d.scheduler.controlState;
  });
  app.post("/v1/bridge/admin/resume", async (req) => {
    owner(req);
    if ((d.scheduler.controlState.retryAt ?? 0) > Date.now())
      throw new BridgeError(
        "reset_pending",
        "Wait for the provider reset time",
        409,
      );
    d.scheduler.resume();
    return d.scheduler.controlState;
  });
  app.post("/v1/bridge/admin/stop", async (req) => {
    owner(req);
    d.shutdown?.();
    return { stopping: true };
  });
  app.get("/v1/bridge/admin/tokens", async (req) => {
    owner(req);
    return { tokens: d.auth.list() };
  });
  app.post("/v1/bridge/admin/tokens", async (req) => {
    owner(req);
    const input = z
      .strictObject({
        id: z
          .string()
          .regex(/^[a-zA-Z0-9_-]{1,64}$/)
          .refine((x) => x !== "owner"),
        profiles: z.array(z.string()).min(1),
        scopes: z
          .array(z.enum(["read", "submit", "control", "workflows"]))
          .min(1),
      })
      .parse(req.body);
    if (input.profiles.some((p) => !d.config.profiles[p]))
      throw new BridgeError("profile_unknown", "Unknown profile");
    return d.auth.create({ ...input, owner: false });
  });
  app.post("/v1/bridge/admin/tokens/revoke", async (req) => {
    owner(req);
    const input = z
      .strictObject({ id: z.string().refine((x) => x !== "owner") })
      .parse(req.body);
    d.auth.revoke(input.id);
    return { revoked: true };
  });
  app.post("/v1/bridge/hosts/heartbeat", async (req) => {
    owner(req);
    const input = z
      .strictObject({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) })
      .parse(req.body);
    d.heartbeat?.(input.id);
    channels.heartbeat(input.id);
    return { expiresInMs: 7000 };
  });
  app.post("/v1/bridge/hosts/disconnect", async (req) => {
    owner(req);
    const input = z.strictObject({ id: z.string().max(100) }).parse(req.body);
    d.disconnect?.(input.id);
    channels.disconnect(input.id);
    return { disconnected: true };
  });
  app.get("/v1/bridge/channel/pending", async (req) => {
    owner(req);
    return {
      jobs: d.scheduler.controlState.paused ? [] : d.store.pending("channel"),
    };
  });
  app.post("/v1/bridge/channel/claim", async (req) => {
    owner(req);
    if (d.scheduler.controlState.paused)
      throw new BridgeError("scheduler_paused", "The scheduler is paused", 409);
    const b = z
      .strictObject({ hostId: z.string(), jobId: z.string().uuid() })
      .parse(req.body);
    return channels.claim(b.hostId, b.jobId);
  });
  const receipt = {
    hostId: z.string().max(100),
    attemptId: z.string().uuid(),
    fence: z.string().uuid(),
  };
  const updateTemplates = (templates: unknown[]) => {
    let next: BridgeConfig;
    try {
      next = parseConfig({ ...d.config, workflows: templates });
      new Workflows(d.store, next.workflows);
    } catch (error) {
      throw new BridgeError(
        "invalid_template",
        error instanceof Error ? error.message : "Invalid workflow template",
      );
    }
    if (!d.persistConfig)
      throw new BridgeError(
        "configuration_unavailable",
        "Persistent configuration is unavailable",
        503,
      );
    d.persistConfig(next);
    d.flows.replaceTemplates(next.workflows);
    d.config.workflows = next.workflows;
  };
  app.get("/v1/bridge/admin/templates", async (req) => {
    owner(req);
    return { templates: d.flows.templates };
  });
  app.put("/v1/bridge/admin/templates/:templateId", async (req) => {
    owner(req);
    const { templateId } = z
      .strictObject({ templateId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) })
      .parse(req.params);
    const template = templateSchema.parse(req.body);
    if (template.id !== templateId)
      throw new BridgeError(
        "invalid_template",
        "Template ID must match the URL",
      );
    const next = d.flows.templates.filter((t) => t.id !== templateId);
    next.push(template);
    updateTemplates(next);
    return template;
  });
  app.delete("/v1/bridge/admin/templates/:templateId", async (req) => {
    owner(req);
    const { templateId } = z
      .strictObject({ templateId: z.string() })
      .parse(req.params);
    if (!d.flows.templates.some((t) => t.id === templateId))
      throw new BridgeError("not_found", "Template not found", 404);
    updateTemplates(d.flows.templates.filter((t) => t.id !== templateId));
    return { deleted: true };
  });
  app.post("/v1/bridge/channel/progress", async (req) => {
    owner(req);
    const b = z
      .strictObject({ ...receipt, text: z.string().max(16000) })
      .parse(req.body);
    return channels.progress(b.hostId, b.attemptId, b.fence, b.text);
  });
  app.post("/v1/bridge/channel/complete", async (req) => {
    owner(req);
    const b = z
      .strictObject({ ...receipt, result: z.string().max(100000) })
      .parse(req.body);
    return channels.complete(b.hostId, b.attemptId, b.fence, b.result);
  });
  app.post("/v1/bridge/channel/stopped", async (req) => {
    owner(req);
    const b = z.strictObject(receipt).parse(req.body);
    return channels.acknowledgeStop(b.hostId, b.attemptId, b.fence);
  });
  app.get("/", async (_req, reply) =>
    reply.type("text/html; charset=utf-8").send(uiAssets.html),
  );
  app.get("/brand.png", async (_req, reply) =>
    reply.type("image/png").send(Buffer.from(uiAssets.brand, "base64")),
  );
  app.get("/app.css", async (_req, reply) =>
    reply.type("text/css; charset=utf-8").send(uiAssets.css),
  );
  app.get("/app.js", async (_req, reply) =>
    reply.type("text/javascript; charset=utf-8").send(uiAssets.js),
  );
  return app;
}
