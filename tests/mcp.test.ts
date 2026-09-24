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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAdapter } from "../src/mcp.js";
import { startService } from "../src/service.js";
import { parseConfig } from "../src/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
it("negotiates native MCP, exposes channel capabilities, and routes tools to the shared service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-mcp-"));
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
  const server = createAdapter(
      { address: service.address, token: service.ownerToken },
      true,
    ),
    client = new Client({ name: "test-host", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(left);
    await client.connect(right);
    expect(client.getServerCapabilities()?.experimental).toHaveProperty(
      "claude/channel",
    );
    const tools = await client.listTools();
    expect(tools.tools.some((t) => t.name === "bridge_channel_claim")).toBe(
      true,
    );
    const result = await client.callTool({
      name: "bridge_submit",
      arguments: { prompt: "hello" },
    });
    expect(result.isError).not.toBe(true);
    const content = result.content as { text: string }[];
    const job = JSON.parse(content[0]!.text);
    await expect.poll(() => service.store.get(job.id).status).toBe("succeeded");
  } finally {
    await client.close();
    await server.close();
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
