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

import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClaudeWorker } from "../src/claude.js";
import { prepareCompletion } from "../src/completion-protocol.js";
import type { Job, Attempt } from "../src/contracts.js";
let dir: string;
const fixture = resolve("tests/fixtures/claude-process.mjs");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-worker-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
function worker(overrides: Record<string, unknown> = {}) {
  return new ClaudeWorker({
    path: process.execPath,
    args: [fixture],
    env: { PATH: process.env.PATH },
    timeoutMs: 2000,
    maxOutputBytes: 20000,
    tools: ["Read", "Write", "Bash"],
    ...overrides,
  });
}
function input(prompt: string) {
  const job: Job = {
    id: "job",
    principalId: "owner",
    status: "running",
    prompt,
    mode: "cli",
    profile: "default",
    createdAt: "now",
    updatedAt: "now",
    messages: [{ id: "m", role: "user", text: prompt, createdAt: "now" }],
  };
  const attempt: Attempt = {
    id: "attempt",
    jobId: job.id,
    owner: "test",
    fence: "fence",
    status: "running",
    createdAt: "now",
    updatedAt: "now",
  };
  return { job, attempt, cwd: dir };
}
describe("official CLI boundary", () => {
  it("runs completion jobs without native tools or agents and persists structured output and observed usage", async () => {
    const execution = input("completion");
    execution.job.completion = prepareCompletion({
      model: "bridge/default",
      messages: [{ role: "user", content: "Hello" }],
    }).request;
    const outcome = await worker({
      agents: {
        danger: { description: "agent", prompt: "test", tools: ["Bash"] },
      },
    }).run(execution, () => {}, new AbortController().signal);
    expect(outcome.status).toBe("succeeded");
    const envelope = JSON.parse(outcome.result!);
    const args = JSON.parse(envelope.content).args as string[];
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--agents");
    expect(args).toContain("--json-schema");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!).$schema).toBe(
      "http://json-schema.org/draft-07/schema#",
    );
    expect(args).toContain("--system-prompt");
    expect(outcome.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 7,
      total_tokens: 17,
    });
  });
  it("surfaces native compaction and child-task events and preserves rate-limit resets even on nonzero exit", async () => {
    const events: string[] = [];
    const outcome = await worker().run(
      input("fixture:events"),
      (e) => events.push(e.kind),
      new AbortController().signal,
    );
    expect(events).toEqual(
      expect.arrayContaining([
        "session",
        "compaction",
        "subagent",
        "rate_limit",
      ]),
    );
    expect(outcome).toMatchObject({
      status: "paused",
      sessionId: "11111111-1111-4111-8111-111111111111",
      retryAt: 2000000005000,
    });
  });
  it("resumes the exact native session instead of replaying the transcript after compaction", async () => {
    const execution = input("original");
    execution.job.sessionId = "11111111-1111-4111-8111-111111111111";
    execution.job.resumePending = true;
    const outcome = await worker().run(
      execution,
      () => {},
      new AbortController().signal,
    );
    const result = JSON.parse(outcome.result!);
    expect(result.args).toContain("--resume");
    expect(result.args).toContain(execution.job.sessionId);
    expect(result.args).not.toContain("--no-session-persistence");
    expect(result.prompt).not.toContain("original");
  });
  it("preflights subscription authentication and rejects alternate billing environments", async () => {
    expect((await worker().ready()).ready).toBe(true);
    expect(
      (await worker({ env: { ANTHROPIC_API_KEY: "not-a-real-key" } }).ready())
        .ready,
    ).toBe(false);
  });
  it("passes prompts over stdin and preserves native bypass and configuration isolation", async () => {
    const events: string[] = [];
    const prompt = "Hello $(touch must-not-exist)";
    const result = await worker().run(
      input(prompt),
      (e) => events.push(e.text),
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    const parsed = JSON.parse(result.result!);
    expect(parsed.bypass).toBe(true);
    expect(parsed.prompt).toBe(prompt);
    expect(parsed.args).toContain("--safe-mode");
    expect(parsed.args).not.toContain("--bare");
    expect(parsed.args).not.toContain(prompt);
    expect(existsSync(join(dir, "must-not-exist"))).toBe(false);
    expect(events).toContain("working");
  });
  it("parses split output and does not confuse process exit with successful completion", async () => {
    expect(
      (
        await worker().run(
          input("fixture:partial"),
          () => {},
          new AbortController().signal,
        )
      ).result,
    ).toBe("split result");
    expect(
      (
        await worker().run(
          input("fixture:bad"),
          () => {},
          new AbortController().signal,
        )
      ).status,
    ).toBe("failed");
  });
  it("bounds output and reports quota failures as actionable errors", async () => {
    expect(
      (
        await worker().run(
          input("fixture:huge"),
          () => {},
          new AbortController().signal,
        )
      ).error,
    ).toMatch(/output/i);
    expect(
      (
        await worker().run(
          input("fixture:error"),
          () => {},
          new AbortController().signal,
        )
      ).error,
    ).toMatch(/quota/);
  });
  it("terminates the owned process group on timeout", async () => {
    const outcome = await worker({ timeoutMs: 300 }).run(
      input("fixture:hang"),
      () => {},
      new AbortController().signal,
    );
    expect(outcome.status).toBe("timed_out");
    if (process.platform !== "win32") {
      const pid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
      await expect
        .poll(
          () => {
            try {
              process.kill(pid, 0);
              return false;
            } catch {
              return true;
            }
          },
          { timeout: 3000 },
        )
        .toBe(true);
    }
  });
  it("aborts active work without waiting for the execution timeout", async () => {
    const controller = new AbortController();
    const run = worker().run(
      input("fixture:hang"),
      () => {},
      controller.signal,
    );
    setTimeout(() => controller.abort(), 200);
    expect((await run).status).toBe("canceled");
  });
});
