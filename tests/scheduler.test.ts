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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "../src/store.js";
import { Scheduler } from "../src/scheduler.js";
import { Workflows } from "../src/workflows.js";
import type { Worker } from "../src/worker.js";
it("honors a pause that arrives during asynchronous readiness", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-gate-"));
  const store = new QueueStore(join(dir, "db.sqlite"));
  const owner = { id: "owner", owner: true, profiles: ["default"] };
  let complete!: (r: { ready: boolean }) => void;
  let ran = false;
  const worker: Worker = {
    ready: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
    run: async () => {
      ran = true;
      return { status: "succeeded" };
    },
  };
  const job = store.submit({ prompt: "stay queued" }, owner);
  const scheduler = new Scheduler(
    store,
    new Workflows(store, []),
    () => worker,
    dir,
    1,
  );
  try {
    scheduler.start();
    await expect.poll(() => typeof complete).toBe("function");
    scheduler.pause();
    complete({ ready: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(ran).toBe(false);
    expect(store.get(job.id).status).toBe("queued");
  } finally {
    await scheduler.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("bounds concurrency, propagates cancellation and shuts down all active attempts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-scheduler-"));
  const store = new QueueStore(join(dir, "db.sqlite"));
  const owner = { id: "owner", owner: true, profiles: ["default"] };
  let active = 0,
    peak = 0;
  const worker: Worker = {
    ready: async () => ({ ready: true }),
    run: async (_input, _emit, signal) => {
      active++;
      peak = Math.max(peak, active);
      return await new Promise((resolve) => {
        const finish = () => {
          active--;
          resolve({ status: "canceled" });
        };
        if (signal.aborted) finish();
        else signal.addEventListener("abort", finish, { once: true });
      });
    },
  };
  const first = store.submit({ prompt: "first" }, owner);
  store.submit({ prompt: "second" }, owner);
  const scheduler = new Scheduler(
    store,
    new Workflows(store, []),
    () => worker,
    dir,
    1,
  );
  scheduler.start();
  await expect.poll(() => store.get(first.id).status).toBe("running");
  store.cancel(first.id, owner);
  await expect.poll(() => store.get(first.id).status).toBe("canceled");
  await scheduler.stop();
  expect(peak).toBe(1);
  expect(active).toBe(0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
