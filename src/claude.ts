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

import { nativeToolObservations } from "./audit.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Outcome } from "./contracts.js";
import type { Execution, Worker, WorkerEvent } from "./worker.js";
import {
  completionEnvelopeSchema,
  completionSystemPrompt,
  parseCompletionResult,
} from "./completion-protocol.js";
const execute = promisify(execFile);
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export type ClaudeOptions = {
  path: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  tools: string[];
  model?: string;
  agents?: Record<
    string,
    { description: string; prompt: string; tools: string[] }
  >;
  maxSubagents?: number;
  maxTurns?: number;
};
export class ClaudeWorker implements Worker {
  constructor(private options: ClaudeOptions) {}
  private environment(): NodeJS.ProcessEnv {
    const env = { ...(this.options.env ?? process.env) };
    delete env.CLAUDECODE;
    return env;
  }
  async ready(): Promise<{ ready: boolean; reason?: string }> {
    const env = this.environment();
    const conflicts = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ];
    if (conflicts.some((key) => env[key] && env[key] !== "0"))
      return {
        ready: false,
        reason:
          "subscription_configuration: remove API/provider overrides from the service environment",
      };
    try {
      const version = await execute(
        this.options.path,
        [...(this.options.args ?? []), "--version"],
        { env, timeout: 10000, maxBuffer: 20000 },
      );
      const match = version.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
      if (
        !match ||
        Number(match[1]) < 2 ||
        (Number(match[1]) === 2 &&
          (Number(match[2]) < 1 ||
            (Number(match[2]) === 1 && Number(match[3]) < 260)))
      )
        return {
          ready: false,
          reason: "unsupported_cli: Claude Code 2.1.260 or later is required",
        };
      const result = await execute(
        this.options.path,
        [...(this.options.args ?? []), "auth", "status"],
        { env, timeout: 10000, maxBuffer: 20000 },
      );
      const auth = JSON.parse(result.stdout) as {
        loggedIn?: boolean;
        authMethod?: string;
        subscriptionType?: string;
      };
      return auth.loggedIn &&
        auth.authMethod === "claude.ai" &&
        Boolean(auth.subscriptionType)
        ? { ready: true }
        : {
            ready: false,
            reason:
              "authentication_required: sign in using the official Claude Code subscription login",
          };
    } catch {
      return {
        ready: false,
        reason:
          "authentication_required: verify the Claude executable and its subscription login",
      };
    }
  }
  async run(
    input: Execution,
    emit: (event: WorkerEvent) => void,
    signal: AbortSignal,
  ): Promise<Outcome> {
    if (signal.aborted) return { status: "canceled" };
    const readiness = await this.ready();
    if (!readiness.ready) return { status: "failed", error: readiness.reason };
    if (signal.aborted) return { status: "canceled" };
    const args = [
      ...(this.options.args ?? []),
      "--safe-mode",
      "--dangerously-skip-permissions",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--tools",
      input.job.completion ? "" : this.options.tools.join(","),
      "--disable-slash-commands",
    ];
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.maxTurns)
      args.push("--max-turns", String(this.options.maxTurns));
    if (
      !input.job.completion &&
      this.options.agents &&
      Object.keys(this.options.agents).length
    )
      args.push("--agents", JSON.stringify(this.options.agents));
    if (input.job.completion)
      args.push(
        "--json-schema",
        JSON.stringify(completionEnvelopeSchema),
        "--system-prompt",
        completionSystemPrompt,
      );
    if (input.job.sessionId) args.push("--resume", input.job.sessionId);
    // Claude owns transcript compaction. Reconstructing its history would lose tool state and repeat work.
    const prompt = input.job.sessionId
      ? input.job.resumePending
        ? "Continue the interrupted turn from its saved state. Check the state of prior tool actions before repeating any side effect."
        : input.job.messages
            .filter((m) => m.role === "user")
            .slice(input.job.resumedTurns ?? 1)
            .map((m) => m.text)
            .join("\n\n")
      : input.job.messages.length === 1
        ? input.job.prompt
        : "Continue this conversation. Prior messages are quoted context. Respond to the final user message.\n" +
          JSON.stringify(
            input.job.messages.map(({ role, text }) => ({ role, text })),
          );
    return new Promise<Outcome>((resolve) => {
      const child = spawn(this.options.path, args, {
        cwd: input.cwd,
        env: this.environment(),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const subagents = new Set<string>();
      let bytes = 0,
        buffer = "",
        stderr = "",
        fault: string | undefined,
        result: Outcome | undefined,
        stop: Outcome["status"] | undefined,
        settled = false,
        sessionId = input.job.sessionId,
        retryAt: number | undefined,
        quota = false,
        killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (force: boolean) => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          void execute("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            timeout: 5000,
          }).catch(() => {
            child.kill();
          });
        } else {
          try {
            process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH")
              fault = "process_cleanup_failed";
          }
        }
      };
      const stopWork = (why: Outcome["status"]) => {
        if (stop) return;
        stop = why;
        kill(false);
        // Give Claude time to record killed tools and flush its resumable transcript.
        killTimer = setTimeout(() => kill(true), 2000);
      };
      const parse = (line: string) => {
        if (!line.trim()) return;
        try {
          const message = JSON.parse(line) as {
            type?: string;
            subtype?: string;
            is_error?: boolean;
            result?: string;
            structured_output?: unknown;
            usage?: {
              input_tokens: number;
              output_tokens: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            errors?: string[];
            session_id?: string;
            parent_tool_use_id?: string | null;
            status?: string | null;
            compact_result?: string;
            compact_metadata?: Record<string, unknown>;
            rate_limit_info?: {
              status?: string;
              resetsAt?: number;
              [key: string]: unknown;
            };
            task_id?: string;
            description?: string;
            summary?: string;
            spawn_depth?: number;
            error?: string;
            message?: { content?: { type: string; text?: string }[] };
          };
          if (
            !message.parent_tool_use_id &&
            message.session_id &&
            /^[0-9a-f-]{36}$/i.test(message.session_id) &&
            message.session_id !== sessionId
          ) {
            sessionId = message.session_id;
            emit({
              kind: "session",
              text: "Claude session attached",
              data: { sessionId },
            });
          }
          if (!input.job.completion)
            for (const tool of nativeToolObservations(message))
              emit({ kind: "tool", text: "Tool activity observed", tool });
          if (message.type === "rate_limit_event") {
            const info = message.rate_limit_info ?? {};
            emit({
              kind: "rate_limit",
              text: "Subscription limit updated",
              data: info,
            });
            if (info.status === "rejected") {
              quota = true;
              if (
                typeof info.resetsAt === "number" &&
                Number.isFinite(info.resetsAt) &&
                info.resetsAt * 1000 > Date.now()
              )
                retryAt = info.resetsAt * 1000 + 5000;
            }
          }
          if (
            message.type === "system" &&
            message.subtype === "compact_boundary"
          )
            emit({
              kind: "compaction",
              text: "Claude compacted the conversation",
              data: message.compact_metadata,
            });
          if (message.type === "system" && message.subtype === "status") {
            emit({
              kind: "activity",
              text: message.status ?? "running",
              data: {
                status: message.status ?? "running",
                compactResult: message.compact_result,
              },
            });
            if (message.compact_result === "failed") {
              fault = "compaction_failed: session needs operator review";
              stopWork("paused");
            }
          }
          if (
            message.type === "system" &&
            message.subtype?.startsWith("task_") &&
            message.task_id
          ) {
            subagents.add(message.task_id);
            emit({
              kind: "subagent",
              text: message.description ?? message.summary ?? "Task updated",
              data: {
                taskId: message.task_id,
                status: message.status ?? "running",
                description: message.description ?? message.summary,
                depth: message.spawn_depth,
              },
            });
            if (subagents.size > (this.options.maxSubagents ?? 8)) {
              fault = "subagent_limit: child-task limit reached";
              stopWork("paused");
            }
          }
          if (message.error === "rate_limit") quota = true;
          if (message.type === "result" && !message.parent_tool_use_id) {
            if (
              input.job.completion &&
              message.subtype === "success" &&
              !message.is_error
            ) {
              const encoded = JSON.stringify(message.structured_output);
              try {
                parseCompletionResult(encoded, input.job.completion);
                message.result = encoded;
              } catch {
                fault =
                  "invalid_completion: Claude returned invalid structured output";
                return;
              }
            }
            if (
              message.is_error ||
              message.subtype !== "success" ||
              typeof message.result !== "string"
            ) {
              const detail = JSON.stringify(
                message.errors ?? message.result ?? message.subtype,
              );
              result = {
                status: /rate.?limit|quota|usage limit/i.test(detail)
                  ? "paused"
                  : "failed",
                error: /rate.?limit|quota|usage limit/i.test(detail)
                  ? "quota_exhausted: Claude subscription limit reached"
                  : "claude_execution_failed: " + detail.slice(0, 500),
              };
            } else
              result = {
                status: "succeeded",
                result: message.result,
                sessionId: message.session_id,
              };
            if (result && message.usage) {
              const usage = message.usage;
              const counts = [
                usage.input_tokens,
                usage.output_tokens,
                usage.cache_read_input_tokens ?? 0,
                usage.cache_creation_input_tokens ?? 0,
              ] as const;
              if (
                counts.every(
                  (n) =>
                    typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
                )
              ) {
                const promptTokens = counts[0] + counts[2] + counts[3];
                result.usage = {
                  prompt_tokens: promptTokens,
                  completion_tokens: counts[1],
                  total_tokens: promptTokens + counts[1],
                };
              }
            }
          } else if (message.type === "assistant")
            for (const block of message.message?.content ?? [])
              if (block.type === "text" && block.text)
                emit({ kind: "output", text: block.text.slice(0, 16000) });
        } catch {
          fault = "invalid_output: Claude returned malformed structured output";
          stopWork("failed");
        }
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (text: string) => {
        bytes += Buffer.byteLength(text);
        if (bytes > this.options.maxOutputBytes) {
          fault = "output_limit: Claude output exceeds the configured limit";
          stopWork("failed");
          return;
        }
        buffer += text;
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
        }
      });
      child.stderr.on("data", (text: string) => {
        stderr = (stderr + text).slice(-1000);
      });
      child.stdin.on("error", () => {});
      child.on("error", () => {
        fault =
          "spawn_failed: unable to start the configured Claude executable";
      });
      const abort = () =>
        stopWork(signal.reason === "pause" ? "paused" : "canceled");
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () => stopWork("timed_out"),
        this.options.timeoutMs,
      );
      child.once("close", async (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener("abort", abort);
        if (buffer) parse(buffer);
        kill(true);
        await pause(30);
        if (fault)
          return resolve({
            status: stop === "paused" ? "paused" : "failed",
            error: fault,
            sessionId,
          });
        if (stop)
          return resolve({
            status: stop,
            error:
              stop === "timed_out"
                ? "execution_timeout"
                : stop === "paused"
                  ? "operator_pause"
                  : undefined,
            sessionId,
          });
        if (quota || result?.error?.startsWith("quota_exhausted"))
          return resolve({
            status: "paused",
            error: "quota_exhausted: Claude subscription limit reached",
            sessionId,
            retryAt,
          });
        if (result?.status === "failed")
          return resolve({ ...result, sessionId });
        if (code !== 0)
          return resolve({
            status: "failed",
            error: /bypass|permission|interactive/i.test(stderr)
              ? "execution_policy: native bypass was rejected or interaction is required"
              : "claude_process_failed: executable exited unsuccessfully",
          });
        resolve(
          result
            ? { ...result, sessionId: sessionId ?? result.sessionId }
            : {
                status: "failed",
                error:
                  "missing_result: Claude exited without a terminal result",
              },
        );
      });
      child.stdin.end(prompt);
    });
  }
}
