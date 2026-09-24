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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "../src/store.js";

const owner = { id: "owner", owner: true, profiles: ["default"] };
const alice = { id: "alice", owner: false, profiles: ["default"] };
const bob = { id: "bob", owner: false, profiles: ["default"] };
const input = {
  prompt: "Summarize hello",
  profile: "default",
  mode: "cli" as const,
};
let dir: string;
let store: QueueStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-store-"));
  store = new QueueStore(join(dir, "queue.sqlite"));
});
afterEach(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("durable queue", () => {
  it("persists waiting work and interrupts active work without replaying it", () => {
    const active = store.submit(input, alice);
    const waiting = store.submit(input, alice);
    store.claim("worker", "cli");
    store.close();
    store = new QueueStore(join(dir, "queue.sqlite"));
    expect(store.recover()).toBe(1);
    expect(store.get(active.id, alice).status).toBe("interrupted");
    expect(store.get(waiting.id, alice).status).toBe("queued");
    expect(store.claim("next", "cli")?.jobId).toBe(waiting.id);
  });
  it("deduplicates scoped requests and rejects changed bodies", () => {
    const first = store.submit(input, alice, "same");
    expect(store.submit(input, alice, "same").id).toBe(first.id);
    expect(() =>
      store.submit({ ...input, prompt: "changed" }, alice, "same"),
    ).toThrow(/idempotency/i);
    expect(store.submit(input, bob, "same").id).not.toBe(first.id);
    expect(store.list(alice)).toHaveLength(1);
  });
  it("atomically claims once across connections and fences stale completion", () => {
    const job = store.submit(input, alice);
    const other = new QueueStore(join(dir, "queue.sqlite"));
    const attempt = store.claim("one", "cli")!;
    expect(other.claim("two", "cli")).toBeNull();
    expect(() =>
      store.finish(
        { ...attempt, fence: "stale" },
        { status: "succeeded", result: "bad" },
      ),
    ).toThrow(/attempt/i);
    store.finish(attempt, { status: "succeeded", result: "done" });
    expect(other.get(job.id, alice).result).toBe("done");
    other.close();
  });
  it("hides other clients resources and filters durable events", () => {
    const job = store.submit(input, alice);
    store.submit(input, bob);
    expect(() => store.get(job.id, bob)).toThrow(/not found/i);
    expect(
      store.events(alice, 0).every((e) => e.principalId === alice.id),
    ).toBe(true);
    expect(store.events(owner, 0)).toHaveLength(2);
  });
  it("cancels queued work before a claim and fences completion after cancellation", () => {
    const first = store.submit(input, alice);
    store.cancel(first.id, alice);
    expect(store.claim("one", "cli")).toBeNull();
    const second = store.submit(input, alice);
    const attempt = store.claim("one", "cli")!;
    expect(store.cancel(second.id, alice).status).toBe("cancel_requested");
    expect(() => store.finish(attempt, { status: "succeeded" })).toThrow(
      /cancel/i,
    );
    store.finish(attempt, { status: "canceled" });
    expect(store.get(second.id, alice).status).toBe("canceled");
  });
  it("retries failed work while retaining attempt history and invalidating old owners", () => {
    const job = store.submit(input, alice);
    const previous = store.claim("one", "cli")!;
    store.finish(previous, { status: "failed", error: "fixture failure" });
    store.retry(job.id, alice);
    expect(() => store.retry(job.id, alice)).toThrow(/retry/i);
    const current = store.claim("two", "cli")!;
    expect(current.fence).not.toBe(previous.fence);
    expect(() => store.finish(previous, { status: "succeeded" })).toThrow(
      /attempt/i,
    );
    store.finish(current, { status: "succeeded", result: "recovered" });
    expect(store.attempts(job.id, alice)).toHaveLength(2);
  });
  it("rejects empty prompts, unknown fields, unavailable profiles and full queues", () => {
    expect(() => store.submit({ ...input, prompt: "" }, alice)).toThrow();
    expect(() => store.submit({ ...input, cwd: "/" }, alice)).toThrow();
    expect(() => store.submit({ ...input, profile: "admin" }, alice)).toThrow(
      /profile/i,
    );
    store.close();
    store = new QueueStore(join(dir, "queue.sqlite"), 1);
    store.submit(input, alice);
    expect(() => store.submit(input, alice)).toThrow(/capacity/i);
  });
});
