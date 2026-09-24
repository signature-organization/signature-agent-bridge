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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseConfig } from "../src/config.js";
const binary = resolve(
  process.argv[2] ??
    "dist/signature-agent-bridge" +
      (process.platform === "win32" ? ".exe" : ""),
);
const directory = mkdtempSync(join(tmpdir(), "bridge-native-"));
const config = parseConfig({
  dataDir: directory,
  workspace: join(directory, "jobs"),
  claudePath: process.execPath,
  port: 0,
});
writeFileSync(join(directory, "config.json"), JSON.stringify(config), {
  mode: 0o600,
});
const clients: Client[] = [];
let address = "",
  token = "";
try {
  for (let i = 0; i < 2; i++) {
    const client = new Client({ name: "package-smoke-" + i, version: "1" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: binary,
        args: ["mcp", "--data-dir", directory],
        cwd: directory,
        stderr: "pipe",
      }),
    );
    const tools = await client.listTools();
    if (!tools.tools.some((t) => t.name === "bridge_template_save"))
      throw new Error("Packaged MCP tools are missing");
    const status = await client.callTool({
      name: "bridge_status",
      arguments: {},
    });
    if (status.isError) throw new Error("Packaged MCP status failed");
    const current = JSON.parse(
      readFileSync(join(directory, "service.json"), "utf8"),
    );
    if (address && current.address !== address)
      throw new Error("Adapters started duplicate services");
    address = current.address;
    token = readFileSync(join(directory, "owner.token"), "utf8").trim();
  }
  const status = await fetch(address + "/v1/status", {
    headers: { Authorization: "Bearer " + token },
  });
  if (!status.ok) throw new Error("Packaged API failed");
  const page = await (await fetch(address)).text();
  if (
    !page.includes("Signature Agent Bridge") ||
    !page.includes("template-dialog")
  )
    throw new Error("Embedded console is missing");
  if ((await fetch(address + "/v1/jobs")).status !== 401)
    throw new Error("Packaged API lost authentication");
  console.log(
    "Native package: two stdio hosts share one authenticated service; embedded console and template tools passed.",
  );
} finally {
  if (address && token)
    await fetch(address + "/v1/admin/stop", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: "{}",
    }).catch(() => {});
  await Promise.allSettled(clients.map((c) => c.close()));
  // The shutdown endpoint replies before it closes SQLite and releases its lock.
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(address + "/v1/status", { signal: AbortSignal.timeout(200) });
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      break;
    }
  }
  rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
