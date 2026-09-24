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

import { beforeEach, afterEach, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService } from "../src/service.js";
import { parseConfig } from "../src/config.js";
import { Tokens } from "../src/auth.js";
import type { Outcome } from "../src/contracts.js";
let dir: string,
  service: Awaited<ReturnType<typeof startService>>,
  token: string,
  delay: number,
  readyDelay: number,
  outcome: Outcome;
const base = {
  model: "bridge/default",
  messages: [{ role: "user", content: "Hello" }],
};
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bridge-completions-"));
  delay = 10;
  readyDelay = 0;
  outcome = {
    status: "succeeded",
    result: JSON.stringify({ content: "Hello!", tool_calls: [] }),
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
  service = await startService(
    parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      claudePath: process.execPath,
      port: 0,
      openai: { timeoutMs: 700, maxConnections: 8 },
    }),
    {
      worker: () => ({
        ready: async () => {
          await new Promise((r) => setTimeout(r, readyDelay));
          return { ready: true };
        },
        run: async (_input, _emit, signal) => {
          await new Promise<void>((r) => {
            const timer = setTimeout(done, delay);
            function done() {
              clearTimeout(timer);
              signal.removeEventListener("abort", done);
              r();
            }
            signal.addEventListener("abort", done, { once: true });
          });
          return signal.aborted ? { status: "canceled" } : outcome;
        },
      }),
    },
  );
  token = new Tokens(service.store).create({
    id: "client",
    owner: false,
    profiles: ["default"],
    scopes: ["read", "submit", "control"],
  }).token;
});
afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});
function post(body: unknown = base, extra: Record<string, string> = {}) {
  return fetch(service.address + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      ...extra,
    },
    body: JSON.stringify(body),
  });
}
it("lists authorized model aliases and returns a persisted OpenAI response and usage", async () => {
  const models = await fetch(service.address + "/v1/models", {
    headers: { authorization: "Bearer " + token },
  });
  expect(models.status).toBe(200);
  expect((await models.json()).data.map((m: { id: string }) => m.id)).toEqual([
    "bridge/default",
  ]);
  const response = await post();
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({
    object: "chat.completion",
    model: "bridge/default",
    choices: [
      {
        message: { role: "assistant", content: "Hello!" },
        finish_reason: "stop",
      },
    ],
    usage: { total_tokens: 7 },
  });
  expect(
    service.store.get(response.headers.get("x-bridge-job-id")!).completion,
  ).toBeDefined();
});
it("streams only validated final output with standard deltas, usage, and DONE", async () => {
  const response = await post({
    ...base,
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const chunks = (await response.text())
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6));
  expect(chunks.at(-1)).toBe("[DONE]");
  const data = chunks.slice(0, -1).map((x) => JSON.parse(x));
  expect(data[0].choices[0].delta.role).toBe("assistant");
  expect(
    data.flatMap((x) => x.choices).some((x) => x.delta.content === "Hello!"),
  ).toBe(true);
  expect(data.at(-1)).toMatchObject({
    choices: [],
    usage: { total_tokens: 7 },
  });
});
it("returns client function calls with stable IDs across idempotent replays", async () => {
  const body = {
    ...base,
    tools: [
      {
        type: "function",
        function: {
          name: "add",
          parameters: {
            type: "object",
            properties: { a: { type: "integer" } },
            required: ["a"],
          },
        },
      },
    ],
    tool_choice: "required",
  };
  outcome.result = JSON.stringify({
    content: null,
    tool_calls: [{ name: "add", arguments: '{"a":2}' }],
  });
  const a = await (await post(body, { "idempotency-key": "same" })).json();
  const b = await (await post(body, { "idempotency-key": "same" })).json();
  expect(a).toEqual(b);
  expect(a.choices[0].finish_reason).toBe("tool_calls");
  expect(a.choices[0].message.tool_calls[0]).toMatchObject({
    type: "function",
    function: { name: "add", arguments: '{"a":2}' },
  });
  expect(service.store.list()).toHaveLength(1);
  expect(
    (
      await post(
        { ...body, messages: [{ role: "user", content: "changed" }] },
        { "idempotency-key": "same" },
      )
    ).status,
  ).toBe(409);
});
it("uses one admission endpoint and scopes management routes to the bridge namespace", async () => {
  const response = await post({
    ...base,
    bridge: { execution: "agent", background: true },
  });
  expect(response.status).toBe(202);
  const job = await response.json();
  expect(job.prompt).toBe("Hello");
  expect(job.completion).toBeUndefined();
  expect(
    (
      await fetch(service.address + "/v1/bridge/jobs/" + job.id, {
        headers: { authorization: "Bearer " + token },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await fetch(service.address + "/v1/jobs", {
        headers: { authorization: "Bearer " + token },
      })
    ).status,
  ).toBe(404);
});
it("uses OpenAI-shaped authentication, model, validation, and schema errors before execution", async () => {
  token = "invalid";
  const r = await post();
  expect(r.status).toBe(401);
  expect((await r.json()).error.type).toBe("authentication_error");
  token = service.ownerToken;
  expect((await post({ ...base, temperature: 0.5 })).status).toBe(400);
  expect((await post({ ...base, model: "bridge/absent" })).status).toBe(404);
  expect(service.store.list()).toHaveLength(0);
});
it("rejects quota gates without admission and retains paused jobs with recovery IDs", async () => {
  service.scheduler.pause("quota_exhausted", Date.now() + 60000);
  const gated = await post();
  expect(gated.status).toBe(429);
  expect(Number(gated.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(service.store.list()).toHaveLength(0);
});
it("cancels timed-out and disconnected synchronous inference work", async () => {
  delay = 5000;
  const timed = await post();
  expect(timed.status).toBe(504);
  const id = timed.headers.get("x-bridge-job-id")!;
  await expect.poll(() => service.store.get(id).status).toBe("canceled");
  const stream = await post({ ...base, stream: true });
  const streamId = stream.headers.get("x-bridge-job-id")!;
  await stream.body!.cancel();
  await expect.poll(() => service.store.get(streamId).status).toBe("canceled");
});
it("does not let one disconnected idempotent waiter cancel another", async () => {
  delay = 300;
  const body = { ...base, stream: true };
  const first = await post(body, { "idempotency-key": "shared" });
  const second = await post(body, { "idempotency-key": "shared" });
  await first.body!.cancel();
  expect(await second.text()).toContain("[DONE]");
  expect(service.store.get(second.headers.get("x-bridge-job-id")!).status).toBe(
    "succeeded",
  );
});
it("rechecks token revocation during a response and shuts down pending streams", async () => {
  delay = 5000;
  const stream = await post({ ...base, stream: true });
  new Tokens(service.store).revoke("client");
  expect(await stream.text()).toContain("unauthorized");
  token = service.ownerToken;
  const pending = await post({ ...base, stream: true });
  await service.close();
  expect(await pending.text()).toContain("service_stopping");
});
it("reports invalid structured output as an error and never emits a fabricated success chunk", async () => {
  outcome.result = "invalid";
  const response = await post();
  expect(response.status).toBe(502);
  const stream = await post({ ...base, stream: true });
  const body = await stream.text();
  expect(body).toContain("invalid_completion");
  expect(body).not.toContain('"finish_reason":"stop"');
});

it.each([
  [false, "quota_exhausted", 429],
  [true, "quota_exhausted", 429],
  [false, "operator_pause", 503],
  [true, "operator_pause", 503],
] as const)(
  "retains queued work when the global gate closes after admission (stream=%s, %s)",
  async (stream, reason, status) => {
    readyDelay = 200;
    const body = { ...base, stream };
    const pending = post(body, { "idempotency-key": "gated" });
    await expect.poll(() => service.store.list().length).toBe(1);
    const id = service.store.list()[0]!.id;
    expect(service.store.get(id).status).toBe("queued");
    service.scheduler.pause(
      reason,
      reason === "quota_exhausted" ? Date.now() + 60000 : undefined,
    );
    const response = await pending;
    const data = await response.text();
    expect(data).toContain(
      reason === "quota_exhausted" ? "quota_exhausted" : "execution_paused",
    );
    expect(data).toContain(id);
    if (!stream) {
      expect(response.status).toBe(status);
      if (reason === "quota_exhausted")
        expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    expect(service.store.get(id).status).toBe("queued");
    service.scheduler.pause(reason);
    service.scheduler.resume();
    const resumed = await post(body, { "idempotency-key": "gated" });
    expect(await resumed.text()).toContain("Hello!");
    expect(service.store.get(id).status).toBe("succeeded");
    expect(service.store.list()).toHaveLength(1);
  },
);
