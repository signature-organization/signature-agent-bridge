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

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService } from "../src/service.js";
import { initialize } from "../src/lifecycle.js";
import { parseConfig } from "../src/config.js";
import type { Job } from "../src/contracts.js";
if (process.env.BRIDGE_LIVE_TEST !== "1")
  throw new Error(
    "Set BRIDGE_LIVE_TEST=1 to explicitly allow this smoke test to use your Claude subscription.",
  );
const directory = mkdtempSync(join(tmpdir(), "bridge-live-"));
const config = await initialize(directory);
config.port = 0;
const service = await startService(
  parseConfig({
    ...config,
    profiles: {
      ...config.profiles,
      delegation: {
        tools: ["Read", "Write", "Agent"],
        agents: {
          checker: {
            description: "Read the requested file and return its number.",
            prompt:
              "Use Read to read the requested file. Return only its number.",
            tools: ["Read"],
          },
        },
        maxSubagents: 2,
        timeoutMs: 120000,
      },
    },
  }),
);
const headers = {
  Authorization: "Bearer " + service.ownerToken,
  "Content-Type": "application/json",
};
async function call(path: string, body?: unknown) {
  const response = await fetch(service.address + path, {
    headers,
    method: body ? "POST" : "GET",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return (await response.json()) as Job;
}
async function finish(id: string) {
  for (let i = 0; i < 120; i++) {
    const job = await call("/v1/bridge/jobs/" + id);
    if (
      [
        "succeeded",
        "failed",
        "paused",
        "canceled",
        "interrupted",
        "timed_out",
      ].includes(job.status)
    ) {
      if (job.status !== "succeeded") throw new Error(job.error ?? job.status);
      return job;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Live smoke timed out");
}
const submit = (body: { prompt: string; profile?: string; mode?: string }) =>
  call("/v1/chat/completions", {
    model: "bridge/" + (body.profile ?? "default"),
    messages: [{ role: "user", content: body.prompt }],
    bridge: { execution: "agent", background: true },
  });
try {
  const job = await submit({
    prompt:
      "Use Write to create bridge-smoke.txt containing exactly BRIDGE_START. Read it with Read, then use Edit to replace BRIDGE_START with BRIDGE_OK. Use Bash to run printf AUDIT_SHELL_OK. Reply exactly BRIDGE_OK.",
    mode: "cli",
  });
  const first = await finish(job.id);
  if (
    readFileSync(
      join(config.workspace, job.id, "bridge-smoke.txt"),
      "utf8",
    ).trim() !== "BRIDGE_OK"
  )
    throw new Error("Expected real file was not created");
  await call("/v1/bridge/jobs/" + job.id + "/messages", {
    text: "Continue this same session: use Read to read bridge-smoke.txt, then use Write to create resumed.txt containing exactly RESUMED_OK. Reply exactly RESUMED_OK.",
  });
  const resumed = await finish(job.id);
  if (first.sessionId !== resumed.sessionId)
    throw new Error("The native session was not resumed");
  if (
    readFileSync(
      join(config.workspace, job.id, "resumed.txt"),
      "utf8",
    ).trim() !== "RESUMED_OK"
  )
    throw new Error("Continuation did not create the expected file");
  const child = await submit({
    prompt:
      "Use Write to create delegation-input.txt containing exactly 7. Use Agent to ask the checker subagent to read delegation-input.txt with Read and return the number. Then use Write to save child-smoke.txt containing exactly 7. Reply exactly CHILD_OK.",
    profile: "delegation",
  });
  const delegated = await finish(child.id);
  if (!Object.keys(delegated.subagents ?? {}).length)
    throw new Error("Claude did not report a native child task");
  const owner = { id: "owner", owner: true, profiles: [] };
  const observations = service.store
    .tools(job.id, owner, {})
    .tools.map((t) => service.store.tool(job.id, t.id, owner));
  for (const name of ["Write", "Read", "Edit", "Bash"])
    if (!observations.some((t) => t.name === name && t.status === "succeeded"))
      throw new Error("Missing successful audited tool: " + name);
  if (
    !observations.some((t) => JSON.stringify(t.input).includes("BRIDGE_START"))
  )
    throw new Error("Write content absent from audit");
  if (
    !observations.some(
      (t) =>
        t.name === "Bash" &&
        JSON.stringify(t.output).includes("AUDIT_SHELL_OK"),
    )
  )
    throw new Error("Shell output absent from audit");
  const audit = service.store.audit(job.id, owner, { includePayloads: "true" });
  if (audit.summary.changedFiles < 2)
    throw new Error(
      "Reported file changes missing: " +
        JSON.stringify(
          observations.map((t) => ({
            name: t.name,
            status: t.status,
            file: t.file,
          })),
        ),
    );
  const childTools = service.store.tools(child.id, owner, {}).tools;
  if (!childTools.some((t) => t.name === "Agent"))
    throw new Error("Agent invocation missing from audit");
  if (
    !childTools.some(
      (t) => t.name === "Read" && t.parentToolUseId && t.status === "succeeded",
    )
  )
    throw new Error(
      "Nested subagent tool observation missing: " +
        JSON.stringify(
          childTools.map((t) => ({
            name: t.name,
            parent: t.parentToolUseId,
            status: t.status,
          })),
        ),
    );
  const evidence = {
    nestedSubagentTool: true,
    completeToolPayloads: true,
    reportedFileChanges: audit.summary.changedFiles,
    auditedTools: observations.map((t) => ({
      name: t.name,
      status: t.status,
      hasInput: t.input !== undefined,
      hasOutput: t.output !== undefined,
    })),
    testedAt: new Date().toISOString(),
    cliPath: config.claudePath,
    nativeBypass: true,
    realFile: true,
    sameSessionResume: true,
    nativeSubagent: true,
    jobEvents: service.store
      .events({ id: "owner", owner: true, profiles: [] }, 0)
      .map((e) => e.type),
  };
  mkdirSync("dist", { recursive: true });
  writeFileSync(
    "dist/live-smoke.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  await service.close();
  rmSync(directory, { recursive: true, force: true });
}
