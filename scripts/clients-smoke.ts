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

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { startService } from "../src/service.js";
import { parseConfig } from "../src/config.js";
import { initialize } from "../src/lifecycle.js";
import type { Job } from "../src/contracts.js";
const directory = mkdtempSync(join(tmpdir(), "bridge-sdk-"));
const live = process.env.BRIDGE_LIVE_TEST === "1";
const config = live
  ? await initialize(directory)
  : parseConfig({
      dataDir: directory,
      workspace: join(directory, "jobs"),
      claudePath: process.execPath,
      port: 0,
    });
config.port = 0;
config.openai.timeoutMs = 180000;
config.profiles.default!.maxTurns = 8;
const service = await startService(
  config,
  live
    ? {}
    : {
        worker: () => ({
          ready: async () => ({ ready: true }),
          run: async ({ job }: { job: Job }) => {
            const request = job.completion!;
            const names = request.tools.map((t) => t.function.name);
            const seenTool = request.messages.some((m) => m.role === "tool");
            let content: string | null = "BRIDGE_CLIENT_OK";
            let tool_calls: { name: string; arguments: string }[] = [];
            if (names.includes("add") && !seenTool) {
              content = null;
              tool_calls = [{ name: "add", arguments: '{"a":2,"b":5}' }];
            } else if (seenTool) content = "The total is 7.";
            else if (names.length) {
              content = null;
              tool_calls = [
                {
                  name: names[0]!,
                  arguments: '{"total":7,"label":"verified"}',
                },
              ];
            } else if (request.response_format.type !== "text")
              content = '{"total":7,"label":"verified"}';
            return {
              status: "succeeded",
              result: JSON.stringify({ content, tool_calls }),
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
              },
            };
          },
        }),
      },
);
try {
  const child = spawn(
    process.env.BRIDGE_PYTHON ?? "python3",
    [resolve("tests/clients/openai_clients.py"), "-v"],
    {
      env: {
        ...process.env,
        BRIDGE_URL: service.address,
        BRIDGE_TOKEN: service.ownerToken,
      },
      stdio: "inherit",
    },
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) throw new Error("Python SDK compatibility tests failed");
  mkdirSync("dist", { recursive: true });
  writeFileSync(
    live ? "dist/openai-live-smoke.json" : "dist/openai-client-smoke.json",
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        live,
        clients: { openai: "3.19.2", pydanticAi: "2.49.0" },
        jobs: service.store
          .list()
          .map((j) => ({ id: j.id, status: j.status, usage: j.usage })),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    live
      ? "Live official Claude Code compatibility passed."
      : "Real Python SDKs passed over HTTP with a deterministic worker.",
  );
} finally {
  await service.close();
  rmSync(directory, { recursive: true, force: true });
}
