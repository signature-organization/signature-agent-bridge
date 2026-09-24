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

import { afterEach, beforeEach, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "../src/store.js";
import { Workflows } from "../src/workflows.js";
let dir: string, store: QueueStore;
const owner = { id: "owner", owner: true, profiles: ["default"] };
const template = {
  id: "brief",
  inputs: ["text"],
  steps: [
    { id: "summary", prompt: "Summarize {{input.text}}", profile: "default" },
    { id: "polish", prompt: "Improve {{steps.summary}}", profile: "default" },
  ],
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-flow-"));
  store = new QueueStore(join(dir, "db.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
it("snapshots templates, advances with prior output, and deduplicates run submissions", () => {
  const flows = new Workflows(store, [template]);
  const run = flows.start("brief", { text: "hello" }, owner, "key");
  expect(flows.start("brief", { text: "hello" }, owner, "key").id).toBe(run.id);
  const a = store.claim("w", "cli")!;
  expect(store.get(a.jobId).prompt).toBe("Summarize hello");
  store.finish(a, { status: "succeeded", result: "A summary" });
  flows.advance();
  const b = store.claim("w", "cli")!;
  expect(store.get(b.jobId).prompt).toBe("Improve A summary");
  store.finish(b, { status: "succeeded", result: "Polished" });
  flows.advance();
  expect(flows.get(run.id, owner).status).toBe("succeeded");
  expect(store.list()).toHaveLength(2);
});
it("blocks successors after failure and retries the failed step without replaying predecessors", () => {
  const flows = new Workflows(store, [template]);
  const run = flows.start("brief", { text: "hello" }, owner);
  const first = store.claim("w", "cli")!;
  store.finish(first, { status: "succeeded", result: "one" });
  flows.advance();
  const second = store.claim("w", "cli")!;
  store.finish(second, { status: "failed", error: "fail" });
  flows.advance();
  expect(flows.get(run.id, owner).status).toBe("failed");
  flows.retryJob(second.jobId, owner);
  flows.advance();
  const retry = store.claim("w", "cli")!;
  expect(retry.jobId).toBe(second.jobId);
  store.finish(retry, { status: "succeeded", result: "two" });
  flows.advance();
  expect(flows.get(run.id, owner).status).toBe("succeeded");
  expect(store.attempts(first.jobId, owner)).toHaveLength(1);
});
it("validates references and prevents recursive substitution from user content", () => {
  expect(
    () =>
      new Workflows(store, [
        {
          ...template,
          steps: [
            { id: "bad", profile: "default", prompt: "{{steps.future}}" },
          ],
        },
      ]),
  ).toThrow();
  const flows = new Workflows(store, [template]);
  flows.start("brief", { text: "{{steps.future}}" }, owner);
  expect(store.pending("cli")[0]?.prompt).toBe("Summarize {{steps.future}}");
});
it("persists cancellation and rejects cross-client access", () => {
  const flows = new Workflows(store, [template]);
  const run = flows.start("brief", { text: "hello" }, owner);
  expect(() =>
    flows.get(run.id, { id: "other", owner: false, profiles: [] }),
  ).toThrow(/not found/i);
  flows.cancel(run.id, owner);
  flows.advance();
  expect(store.claim("w", "cli")).toBeNull();
  expect(flows.get(run.id, owner).status).toBe("canceled");
});
