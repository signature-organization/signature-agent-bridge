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
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startService } from "../src/service.js";
import { parseConfig } from "../src/config.js";
it("validates and persists owner templates while preserving existing run snapshots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-template-"));
  const service = await startService(
    parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      claudePath: process.execPath,
      port: 0,
    }),
    {
      worker: () => ({
        ready: async () => ({ ready: true }),
        run: async () => ({ status: "succeeded", result: "done" }),
      }),
    },
  );
  const headers = {
    authorization: "Bearer " + service.ownerToken,
    "content-type": "application/json",
  };
  const put = (body: unknown) =>
    fetch(service.address + "/v1/bridge/admin/templates/review", {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
  try {
    service.scheduler.pause();
    const original = {
      id: "review",
      description: "Review a topic",
      inputs: ["topic"],
      steps: [
        { id: "draft", prompt: "Draft {{input.topic}}", profile: "default" },
      ],
    };
    expect((await put(original)).status).toBe(200);
    expect(
      JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).workflows[0]
        .id,
    ).toBe("review");
    const start = () =>
      fetch(service.address + "/v1/bridge/workflow-runs", {
        method: "POST",
        headers: { ...headers, "idempotency-key": "workflow-request" },
        body: JSON.stringify({
          templateId: "review",
          inputs: { topic: "one" },
        }),
      });
    const run = (await (await start()).json()) as { id: string };
    expect(
      (
        await put({
          ...original,
          steps: [{ id: "a", prompt: "{{steps.future}}" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await put({
          ...original,
          steps: [{ id: "draft", prompt: "A different prompt" }],
        })
      ).status,
    ).toBe(200);
    const saved = (await (
      await fetch(service.address + "/v1/bridge/workflow-runs/" + run.id, {
        headers,
      })
    ).json()) as { template: typeof original };
    expect(saved.template.steps[0]!.prompt).toBe(original.steps[0]!.prompt);
    expect(
      (
        await fetch(service.address + "/v1/bridge/admin/templates/review", {
          method: "DELETE",
          headers,
          body: "{}",
        })
      ).status,
    ).toBe(200);
    expect(((await (await start()).json()) as { id: string }).id).toBe(run.id);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
