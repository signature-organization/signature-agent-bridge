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

import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "../src/store.js";
import { nativeToolObservations } from "../src/audit.js";
import { prepareCompletion } from "../src/completion-protocol.js";
const alice = { id: "alice", owner: false, profiles: ["default"] };
const bob = { ...alice, id: "bob" };
let dir: string, store: QueueStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-audit-"));
  store = new QueueStore(join(dir, "queue.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const request = (id = "tool-1", name = "Write") =>
  nativeToolObservations({
    type: "assistant",
    parent_tool_use_id: "parent-1",
    message: {
      content: [
        {
          type: "tool_use",
          id,
          name,
          input: {
            file_path: "src/example.ts",
            content: "SECRET_CONTENT",
            command: "SECRET_COMMAND",
          },
        },
      ],
    },
  })[0]!;
const result = (id = "tool-1", error = false) =>
  nativeToolObservations({
    type: "user",
    parent_tool_use_id: "parent-1",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: error,
          content: "SECRET_RESULT",
        },
      ],
    },
  })[0]!;
it("retains complete native inputs and outputs while classifying only known file tools", () => {
  expect(request()).toMatchObject({
    toolId: "tool-1",
    name: "Write",
    phase: "requested",
    parentToolUseId: "parent-1",
    file: { path: "src/example.ts", operation: "write" },
  });
  expect(request().input).toMatchObject({
    content: "SECRET_CONTENT",
    command: "SECRET_COMMAND",
  });
  expect(result().output).toMatchObject({ content: "SECRET_RESULT" });
  expect(request("shell", "Bash").file).toBeUndefined();
  expect(request("custom", "mcp__files__Write").file).toBeUndefined();
  expect(
    nativeToolObservations({
      type: "user",
      message: { content: "not an array" },
    }),
  ).toEqual([]);
  expect(
    nativeToolObservations({
      type: "assistant",
      message: {
        content: [
          null,
          { type: "tool_use", id: "x", name: 7 },
          {
            type: "tool_use",
            id: "y",
            name: "Write",
            input: { file_path: "x".repeat(2000) },
          },
        ],
      },
    })[0]?.file,
  ).toBeUndefined();
});
it("persists correlated outcomes, deduplicates replay, and keeps audit after SSE pruning and restart", () => {
  const job = store.submit({ prompt: "test" }, alice),
    attempt = store.claim("worker", "cli")!;
  store.observe(attempt, {
    kind: "session",
    text: "session",
    data: { sessionId: "session-1" },
  });
  for (const tool of [request(), request(), result(), result()])
    store.observe(attempt, { kind: "tool", text: "tool", tool });
  store.finish(attempt, { status: "succeeded", result: "done" });
  const tools = store.tools(job.id, alice, {}).tools;
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({
    status: "succeeded",
    sessionId: "session-1",
    attemptId: attempt.id,
    parentToolUseId: "parent-1",
  });
  expect(tools[0]!.durationMs).toBeGreaterThanOrEqual(0);
  const audit = store.audit(job.id, alice, {});
  expect(audit.entries.filter((e) => e.type.startsWith("tool."))).toHaveLength(
    2,
  );
  expect(audit.summary).toMatchObject({ tools: 1, files: 1, changedFiles: 1 });
  store.pruneEvents(99999);
  store.close();
  store = new QueueStore(join(dir, "queue.sqlite"));
  expect(store.audit(job.id, alice, {}).entries).toEqual(audit.entries);
  expect(() => store.audit(job.id, bob, {})).toThrow(/not found/i);
  expect(() => store.tools(job.id, bob, {})).toThrow(/not found/i);
});
it("fences stale observations and closes pending calls as unknown without asserting file changes", () => {
  const job = store.submit({ prompt: "test" }, alice),
    attempt = store.claim("worker", "cli")!;
  store.observe(attempt, { kind: "tool", text: "tool", tool: request() });
  expect(() =>
    store.observe(
      { ...attempt, fence: "wrong" },
      { kind: "tool", text: "tool", tool: result() },
    ),
  ).toThrow(/attempt/i);
  store.recover();
  const page = store.tools(job.id, alice, {});
  expect(page.tools[0]!.status).toBe("unknown");
  expect(store.audit(job.id, alice, {}).summary.changedFiles).toBe(0);
  expect(() =>
    store.observe(attempt, { kind: "tool", text: "tool", tool: result() }),
  ).toThrow(/attempt/i);
  store.retry(job.id, alice);
  const retry = store.claim("worker", "cli")!;
  for (const tool of [request(), result("tool-1", true)])
    store.observe(retry, { kind: "tool", text: "tool", tool });
  expect(store.tools(job.id, alice, {}).tools.map((t) => t.status)).toEqual([
    "unknown",
    "failed",
  ]);
});
it("retains out-of-order results and stable export boundaries as new entries arrive", () => {
  const job = store.submit({ prompt: "test" }, alice),
    a = store.claim("worker", "cli")!;
  store.observe(a, { kind: "tool", text: "tool", tool: result() });
  store.observe(a, { kind: "tool", text: "tool", tool: request() });
  expect(store.tools(job.id, alice, {}).tools[0]!.status).toBe("succeeded");
  const first = store.audit(job.id, alice, { limit: 2 });
  expect(first.nextCursor).not.toBeNull();
  store.observe(a, { kind: "tool", text: "tool", tool: request("later") });
  let after = first.nextCursor!;
  const entries = [...first.entries];
  for (;;) {
    const p = store.audit(job.id, alice, {
      after,
      through: first.through,
      limit: 2,
    });
    entries.push(...p.entries);
    if (!p.nextCursor) break;
    after = p.nextCursor;
  }
  expect(entries.at(-1)!.id).toBe(first.through);
  expect(JSON.stringify(entries)).not.toContain('"later"');
  expect(store.audit(job.id, alice, {}).summary.tools).toBe(2);
});
it("records external functions as client history or requests, never as native file changes", () => {
  const completion = prepareCompletion({
    model: "bridge/default",
    messages: [
      { role: "user", content: "test" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-old",
            type: "function",
            function: {
              name: "Write",
              arguments: '{"file_path":"secret.txt"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-old",
        content: "SECRET_CLIENT_RESULT",
      },
    ],
  }).request;
  const job = store.submit({ prompt: "test" }, alice, undefined, completion),
    a = store.claim("worker", "cli")!;
  store.finish(a, {
    status: "succeeded",
    result: JSON.stringify({
      content: null,
      tool_calls: [{ name: "Write", arguments: '{"file_path":"new.txt"}' }],
    }),
  });
  const entries = store.audit(job.id, alice, {}).entries;
  expect(entries.map((e) => e.type)).toEqual(
    expect.arrayContaining([
      "client.tool_request_reported",
      "client.tool_result_reported",
      "client.tool_requested",
    ]),
  );
  expect(
    JSON.stringify(
      store.audit(job.id, alice, { includePayloads: "true" }).entries,
    ),
  ).toContain("SECRET_CLIENT_RESULT");
  expect(JSON.stringify(entries)).not.toContain("secret.txt");
  expect(store.tools(job.id, alice, {}).tools).toHaveLength(0);
});

it("keeps payloads out of list responses but returns complete authorized tool details and exports", () => {
  const job = store.submit({ prompt: "test" }, alice),
    a = store.claim("worker", "cli")!;
  for (const tool of [request(), result()])
    store.observe(a, { kind: "tool", text: "tool", tool });
  expect(JSON.stringify(store.audit(job.id, alice, {}))).not.toContain(
    "SECRET",
  );
  expect(JSON.stringify(store.tools(job.id, alice, {}))).not.toContain(
    "SECRET",
  );
  const id = store.tools(job.id, alice, {}).tools[0]!.id;
  expect(store.tool(job.id, id, alice)).toMatchObject({
    input: { content: "SECRET_CONTENT" },
    output: { content: "SECRET_RESULT" },
  });
  expect(() => store.tool(job.id, id, bob)).toThrow(/not found/i);
  expect(
    JSON.stringify(store.audit(job.id, alice, { includePayloads: "true" })),
  ).toContain("SECRET_CONTENT");
});

it("paginates complete payloads by byte budget without dropping records or truncating data", () => {
  const job = store.submit({ prompt: "test" }, alice),
    a = store.claim("worker", "cli")!;
  for (let n = 0; n < 3; n++)
    store.observe(a, {
      kind: "tool",
      text: "tool",
      tool: {
        toolId: "big-" + n,
        name: "Write",
        phase: "requested",
        input: { content: "a".repeat(2_100_000) },
      },
    });
  let after = 0,
    through: number | undefined,
    calls = 0,
    count = 0;
  do {
    const page = store.audit(job.id, alice, {
      includePayloads: "true",
      after,
      through,
      limit: 200,
    });
    through ??= page.through;
    calls++;
    for (const entry of page.entries)
      if (entry.type === "tool.requested") {
        count++;
        expect((entry.data.input as { content: string }).content.length).toBe(
          2_100_000,
        );
      }
    if (page.nextCursor === null) break;
    after = page.nextCursor;
  } while (calls < 10);
  expect(count).toBe(3);
  expect(calls).toBe(3);
});
