#!/usr/bin/env node
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

import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  defaultDataDir,
  initialize,
  ensureService,
  connect,
  request,
} from "./lifecycle.js";
import { startService } from "./service.js";
import { createAdapter } from "./mcp.js";
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      managed: { type: "boolean" },
      channel: { type: "boolean" },
      id: { type: "string" },
      profiles: { type: "string" },
      scopes: { type: "string" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
  });
  if (values.version) {
    console.log("0.1.0");
    return;
  }
  const command = positionals[0] ?? "help",
    dataDir = resolve(values["data-dir"] ?? defaultDataDir());
  if (command === "help" || values.help) {
    console.log(`Signature Agent Bridge 0.1.0
Usage: signature-agent-bridge <command> [--data-dir PATH]
  init        Initialize local configuration
  serve       Run the service (--managed follows host leases)
  mcp         Start the native stdio adapter (--channel enables Code notifications)
  status      Inspect the running service
  panel       Open the diagnostic dashboard
  pause       Pause dispatch and active CLI jobs
  resume      Resume dispatch; resume individual paused jobs in the panel
  stop        Stop the local service gracefully
  token       Create a scoped client token (--id NAME --profiles default --scopes read,submit,control)
  revoke      Revoke a client's tokens (--id NAME)
  --version   Print the release version`);
    return;
  }
  if (command === "init") {
    const config = await initialize(dataDir);
    console.log(
      JSON.stringify(
        { dataDir: config.dataDir, config: join(dataDir, "config.json") },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "serve") {
    const service = await startService(await initialize(dataDir), {
      managed: values.managed,
    });
    console.error("Signature Agent Bridge listening at " + service.address);
    const close = () => {
      void service.close().then(() => process.exit(0));
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
    return;
  }
  if (command === "mcp") {
    const server = createAdapter(
      await ensureService(dataDir),
      Boolean(values.channel),
    );
    await server.connect(new StdioServerTransport());
    process.stdin.once("end", () => {
      void server.close();
    });
    return;
  }
  const connection =
    command === "panel" ? await ensureService(dataDir) : await connect(dataDir);
  if (command === "panel") {
    console.log(
      "Dashboard: " +
        connection.address +
        "\nOwner token file: " +
        join(dataDir, "owner.token"),
    );
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "rundll32.exe"
          : "xdg-open";
    const args =
      process.platform === "win32"
        ? ["url.dll,FileProtocolHandler", connection.address]
        : [connection.address];
    const child = spawn(opener, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return;
  }
  let result: unknown;
  if (command === "status") result = await request(connection, "/v1/status");
  else if (["pause", "resume", "stop"].includes(command))
    result = await request(connection, "/v1/admin/" + command, {});
  else if (command === "token") {
    if (!values.id) throw new Error("token requires --id NAME");
    result = await request(connection, "/v1/admin/tokens", {
      id: values.id,
      profiles: (values.profiles ?? "default").split(","),
      scopes: (values.scopes ?? "read,submit,control,workflows").split(","),
    });
  } else if (command === "revoke") {
    if (!values.id) throw new Error("revoke requires --id NAME");
    result = await request(connection, "/v1/admin/tokens/revoke", {
      id: values.id,
    });
  } else throw new Error("Unknown command: " + command);
  console.log(JSON.stringify(result, null, 2));
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Bridge failed");
  process.exitCode = 1;
});
