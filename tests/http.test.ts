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
import { QueueStore } from "../src/store.js";
import { Workflows } from "../src/workflows.js";
import { Scheduler } from "../src/scheduler.js";
import { Tokens } from "../src/auth.js";
import { createHttpService } from "../src/http.js";
import { parseConfig } from "../src/config.js";
let dir: string,
  store: QueueStore,
  auth: Tokens,
  app: ReturnType<typeof createHttpService>,
  token: string,
  other: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-http-"));
  store = new QueueStore(join(dir, "db.sqlite"));
  auth = new Tokens(store);
  token = auth.create({
    id: "alice",
    owner: false,
    profiles: ["default"],
    scopes: ["read", "submit", "control", "workflows"],
  }).token;
  other = auth.create({
    id: "bob",
    owner: false,
    profiles: ["default"],
    scopes: ["read", "submit"],
  }).token;
  const flows = new Workflows(store, []);
  const scheduler = new Scheduler(
    store,
    flows,
    () => {
      throw new Error("not started");
    },
    dir,
    1,
  );
  app = createHttpService({
    store,
    auth,
    flows,
    scheduler,
    config: parseConfig({
      dataDir: dir,
      workspace: dir,
      claudePath: process.execPath,
      allowedOrigins: ["https://console.example"],
    }),
  });
});
afterEach(async () => {
  await app?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});
const headers = () => ({ authorization: "Bearer " + token });
it("permits explicit browser origins without bypassing authentication on commands", async () => {
  const origin = "https://console.example";
  const preflight = await app.inject({
    method: "OPTIONS",
    url: "/v1/jobs",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type",
    },
  });
  expect(preflight.statusCode).toBe(204);
  expect(preflight.headers["access-control-allow-origin"]).toBe(origin);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { origin },
        payload: { prompt: "hello" },
      })
    ).statusCode,
  ).toBe(401);
  const result = await app.inject({
    url: "/v1/status",
    headers: { ...headers(), origin },
  });
  expect(result.statusCode).toBe(200);
  expect(result.headers["access-control-allow-origin"]).toBe(origin);
  expect(
    (
      await app.inject({
        method: "OPTIONS",
        url: "/v1/jobs",
        headers: { origin: "https://attacker.example" },
      })
    ).statusCode,
  ).toBe(403);
});
it("authenticates admission and prevents cross-client reads and revocation reuse", async () => {
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/jobs",
        payload: { prompt: "hello" },
      })
    ).statusCode,
  ).toBe(401);
  const response = await app.inject({
    method: "POST",
    url: "/v1/jobs",
    headers: headers(),
    payload: { prompt: "hello" },
  });
  expect(response.statusCode).toBe(202);
  const id = response.json().id;
  expect(
    (
      await app.inject({
        url: "/v1/jobs/" + id,
        headers: { authorization: "Bearer " + other },
      })
    ).statusCode,
  ).toBe(404);
  auth.revoke("alice");
  expect(
    (await app.inject({ url: "/v1/jobs", headers: headers() })).statusCode,
  ).toBe(401);
});
it("validates input, scope, origin and host before a job can execute", async () => {
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: headers(),
        payload: { prompt: "hello", cwd: "/" },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: headers(),
        payload: { prompt: "hello", profile: "unconfigured" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        url: "/v1/status",
        headers: { ...headers(), host: "attacker.example" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        url: "/v1/status",
        headers: { ...headers(), origin: "https://attacker.example" },
      })
    ).statusCode,
  ).toBe(403);
  const id = (
    await app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { authorization: "Bearer " + other },
      payload: { prompt: "hello" },
    })
  ).json().id;
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/jobs/" + id + "/cancel",
        headers: { authorization: "Bearer " + other },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
});
it("supports idempotent bidirectional messages, terminal results and retry control", async () => {
  const id = (
    await app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: headers(),
      payload: { prompt: "hello" },
    })
  ).json().id;
  const attempt = store.claim("fixture", "cli")!;
  const follow = {
    method: "POST" as const,
    url: "/v1/jobs/" + id + "/messages",
    headers: { ...headers(), "idempotency-key": "follow" },
    payload: { text: "Make it shorter" },
  };
  expect((await app.inject(follow)).statusCode).toBe(202);
  expect((await app.inject(follow)).statusCode).toBe(202);
  store.finish(attempt, { status: "succeeded", result: "Long answer" });
  expect(store.get(id).status).toBe("queued");
  const second = store.claim("fixture", "cli")!;
  store.finish(second, { status: "succeeded", result: "Short" });
  const messages = (
    await app.inject({
      url: "/v1/jobs/" + id + "/messages",
      headers: headers(),
    })
  ).json().messages;
  expect(messages.map((m: { text: string }) => m.text)).toEqual([
    "hello",
    "Long answer",
    "Make it shorter",
    "Short",
  ]);
  expect(
    (
      await app.inject({
        url: "/v1/jobs/" + id + "/result",
        headers: headers(),
      })
    ).json().result,
  ).toBe("Short");
});
it("replays SSE by event ID, isolates events and rejects expired cursors", async () => {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as { port: number };
  const base = "http://127.0.0.1:" + address.port;
  const alice = auth.verify(token);
  store.submit({ prompt: "hello" }, alice);
  store.submit({ prompt: "secret" }, auth.verify(other));
  const controller = new AbortController();
  const response = await fetch(base + "/v1/events", {
    headers: { ...headers(), origin: "https://console.example" },
    signal: controller.signal,
  });
  expect(response.headers.get("access-control-allow-origin")).toBe(
    "https://console.example",
  );
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  let text = "";
  while (!text.includes("job.queued"))
    text += new TextDecoder().decode((await reader.read()).value);
  expect(text).toContain('"principalId":"alice"');
  expect(text).not.toContain("bob");
  controller.abort();
  const newest = store.submit({ prompt: "next" }, alice);
  const replay = new AbortController();
  const r = await fetch(base + "/v1/events", {
    headers: { ...headers(), "Last-Event-ID": "1" },
    signal: replay.signal,
  });
  const rd = r.body!.getReader();
  let replayText = "";
  while (!replayText.includes(newest.id))
    replayText += new TextDecoder().decode((await rd.read()).value);
  expect(replayText).not.toContain("id: 1\n");
  replay.abort();
  store.pruneEvents(2);
  expect(
    (
      await app.inject({
        url: "/v1/events",
        headers: { ...headers(), "last-event-id": "1" },
      })
    ).statusCode,
  ).toBe(409);
});

it("keeps host leases and job controls available when polling is rate limited", async () => {
  const owned = auth.create({
    id: "owner",
    owner: true,
    profiles: ["default"],
  }).token;
  const h = { authorization: "Bearer " + owned };
  const job = store.submit(
    { prompt: "stop this" },
    { id: "owner", owner: true, profiles: [] },
  );
  for (let i = 0; i < 240; i++)
    await app.inject({ url: "/v1/status", headers: h });
  expect((await app.inject({ url: "/v1/status", headers: h })).statusCode).toBe(
    429,
  );
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/hosts/heartbeat",
        headers: h,
        payload: { id: "active-host" },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/jobs/" + job.id + "/cancel",
        headers: h,
        payload: {},
      })
    ).statusCode,
  ).toBe(200);
  expect(store.get(job.id).status).toBe("canceled");
});
