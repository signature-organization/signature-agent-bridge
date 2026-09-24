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
import { Channels } from "../src/channels.js";
import { QueueStore } from "../src/store.js";
const owner = { id: "owner", owner: true, profiles: ["default"] };
it("fences channel delivery and interrupts orphaned claims without rerunning side effects", () => {
  const s = new QueueStore(":memory:"),
    c = new Channels(s);
  const job = s.submit({ prompt: "channel work", mode: "channel" }, owner);
  c.heartbeat("desktop");
  const claim = c.claim("desktop", job.id);
  expect(claim.job.id).toBe(job.id);
  c.heartbeat("code");
  expect(() => c.claim("code", job.id)).toThrow();
  expect(() =>
    c.complete("code", claim.attempt.id, claim.attempt.fence, "success"),
  ).toThrow();
  c.progress("desktop", claim.attempt.id, claim.attempt.fence, "Working");
  c.reap(Date.now() + 8000);
  expect(s.get(job.id).status).toBe("interrupted");
  expect(() =>
    c.complete("desktop", claim.attempt.id, claim.attempt.fence, "late"),
  ).toThrow();
  expect(s.pending("channel")).toHaveLength(0);
  s.close();
});

it("allows only one outstanding claim per host conversation", () => {
  const s = new QueueStore(":memory:"),
    c = new Channels(s);
  try {
    const first = s.submit({ prompt: "first", mode: "channel" }, owner),
      second = s.submit({ prompt: "second", mode: "channel" }, owner);
    c.heartbeat("host");
    const a = c.claim("host", first.id).attempt;
    expect(() => c.claim("host", second.id)).toThrow(/outstanding/);
    c.complete("host", a.id, a.fence, "done");
    expect(c.claim("host", second.id).job.id).toBe(second.id);
  } finally {
    s.close();
  }
});
