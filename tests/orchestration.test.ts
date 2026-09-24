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

import { it, expect } from "vitest";
import { QueueStore } from "../src/store.js";
import { Scheduler } from "../src/scheduler.js";
import { Workflows } from "../src/workflows.js";
import type { Worker } from "../src/worker.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const owner = { id: "owner", owner: true, profiles: ["default"] };
it("persists paused work, preserves compacted sessions, and resumes without replaying completed steps", () => {
  const s = new QueueStore(":memory:");
  const j = s.submit({ prompt: "work" }, owner);
  const a = s.claim("worker", "cli", j.id)!;
  s.observe(a, {
    kind: "session",
    text: "session",
    data: { sessionId: "11111111-1111-4111-8111-111111111111" },
  });
  s.observe(a, {
    kind: "compaction",
    text: "compacted",
    data: { trigger: "auto", pre_tokens: 120000 },
  });
  s.pause(j.id, owner);
  s.finish(a, {
    status: "paused",
    sessionId: s.get(j.id).sessionId,
    error: "operator_pause",
  });
  expect(s.get(j.id).status).toBe("paused");
  expect(s.get(j.id).compactions).toBe(1);
  expect(s.resume(j.id, owner).sessionId).toBe(
    "11111111-1111-4111-8111-111111111111",
  );
  expect(s.get(j.id).resumePending).toBe(true);
  expect(s.events(owner, 0).some((e) => e.type === "job.compaction")).toBe(
    true,
  );
  s.close();
});
it("latches quota limits across scheduler restarts and resumes only after the reset gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-pause-"));
  const s = new QueueStore(join(dir, "db"));
  let calls = 0;
  const worker: Worker = {
    ready: async () => ({ ready: true }),
    run: async () => {
      calls++;
      return {
        status: "paused",
        error: "quota_exhausted",
        sessionId: "11111111-1111-4111-8111-111111111111",
        retryAt: Date.now() + 60000,
      };
    },
  };
  const j = s.submit({ prompt: "first" }, owner);
  const second = s.submit({ prompt: "second" }, owner);
  let scheduler = new Scheduler(s, new Workflows(s, []), () => worker, dir, 1);
  scheduler.start();
  await expect.poll(() => s.get(j.id).status).toBe("paused");
  await new Promise((r) => setTimeout(r, 250));
  expect(calls).toBe(1);
  expect(s.get(second.id).status).toBe("queued");
  await scheduler.stop();
  scheduler = new Scheduler(s, new Workflows(s, []), () => worker, dir, 1);
  scheduler.start();
  await new Promise((r) => setTimeout(r, 250));
  expect(calls).toBe(1);
  expect(scheduler.controlState.reason).toMatch(/quota/);
  await scheduler.stop();
  s.close();
  rmSync(dir, { recursive: true, force: true });
});
it("holds a workflow at its current step and resumes it exactly once", () => {
  const s = new QueueStore(":memory:");
  const f = new Workflows(s, [
    {
      id: "flow",
      steps: [
        { id: "a", prompt: "A" },
        { id: "b", prompt: "B" },
      ],
    },
  ]);
  const run = f.start("flow", {}, owner);
  f.pause(run.id, owner);
  f.advance();
  expect(f.get(run.id, owner).status).toBe("paused");
  expect(s.get(run.jobIds[0]!).status).toBe("paused");
  f.resume(run.id, owner);
  const a = s.claim("w", "cli")!;
  s.finish(a, { status: "succeeded", result: "ok" });
  f.advance();
  f.advance();
  expect(f.get(run.id, owner).jobIds).toHaveLength(2);
  s.close();
});

it("preserves a follow-up queued before a resumed turn is claimed", () => {
  const s = new QueueStore(":memory:");
  try {
    const job = s.submit({ prompt: "original" }, owner);
    const a = s.claim("w", "cli")!;
    s.finish(a, {
      status: "paused",
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
    s.resume(job.id, owner);
    s.sendMessage(job.id, "next turn", owner);
    expect(s.get(job.id).pendingMessages?.map((m) => m.text)).toEqual([
      "next turn",
    ]);
    const continuation = s.claim("w", "cli")!;
    s.finish(continuation, { status: "succeeded", result: "continued" });
    const queued = s.get(job.id);
    expect(queued.status).toBe("queued");
    expect(
      queued.messages
        .filter((m) => m.role === "user")
        .slice(queued.resumedTurns)
        .map((m) => m.text),
    ).toEqual(["next turn"]);
    s.finish(s.claim("w", "cli")!, {
      status: "succeeded",
      result: "followed up",
    });
    expect(s.get(job.id).status).toBe("succeeded");
    expect(s.get(job.id).resumedTurns).toBe(2);
  } finally {
    s.close();
  }
});
it("rejects a retry while the workflow pause barrier is active", () => {
  const s = new QueueStore(":memory:");
  try {
    const f = new Workflows(s, [
      { id: "flow", steps: [{ id: "a", prompt: "A" }] },
    ]);
    const run = f.start("flow", {}, owner);
    s.finish(s.claim("w", "cli")!, { status: "failed" });
    f.advance();
    f.pause(run.id, owner);
    expect(() => f.retryJob(run.jobIds[0]!, owner)).toThrow(/paused/i);
    expect(s.claim("w", "cli")).toBeNull();
    f.resume(run.id, owner);
    f.retryJob(run.jobIds[0]!, owner);
    expect(s.claim("w", "cli")).not.toBeNull();
  } finally {
    s.close();
  }
});
