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

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("2.1.260 (Claude Code)");
  process.exit(0);
}
if (process.argv.includes("status")) {
  console.log(
    JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      subscriptionType: "max",
    }),
  );
  process.exit(0);
}
let prompt = "";
for await (const part of process.stdin) prompt += part;
if (process.argv.includes("--json-schema")) {
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      structured_output: {
        content: JSON.stringify({ args: process.argv.slice(2) }),
        tool_calls: [],
      },
      usage: {
        input_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
        output_tokens: 7,
      },
    }),
  );
} else if (prompt === "fixture:tools") {
  for (const message of [
    {
      type: "system",
      subtype: "init",
      session_id: "11111111-1111-4111-8111-111111111111",
    },
    {
      type: "assistant",
      parent_tool_use_id: "agent-parent",
      session_id: "22222222-2222-4222-8222-222222222222",
      message: {
        content: [
          {
            type: "tool_use",
            id: "native-write",
            name: "Write",
            input: { file_path: "notes.md", content: "PRIVATE_CONTENT" },
          },
        ],
      },
    },
    {
      type: "user",
      parent_tool_use_id: "agent-parent",
      session_id: "22222222-2222-4222-8222-222222222222",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "native-write",
            content: "PRIVATE_RESULT",
          },
        ],
      },
    },
    { type: "result", subtype: "success", is_error: false, result: "done" },
  ])
    console.log(JSON.stringify(message));
} else if (prompt === "fixture:events") {
  for (const message of [
    {
      type: "system",
      subtype: "init",
      session_id: "11111111-1111-4111-8111-111111111111",
    },
    { type: "system", subtype: "status", status: "compacting" },
    {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 120000 },
    },
    {
      type: "system",
      subtype: "task_started",
      task_id: "child",
      description: "Research",
    },
    {
      type: "system",
      subtype: "task_notification",
      task_id: "child",
      status: "completed",
      summary: "Done",
    },
    {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 2000000000 },
    },
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["rate_limit"],
    },
  ])
    console.log(JSON.stringify(message));
  process.exitCode = 1;
} else if (prompt === "fixture:hang") {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  writeFileSync("child.pid", String(child.pid));
  setInterval(() => {}, 1000);
} else if (prompt === "fixture:bad") {
  console.log("{not-json");
} else if (prompt === "fixture:huge") {
  console.log("x".repeat(100000));
} else if (prompt === "fixture:error") {
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["rate_limit_error"],
    }),
  );
} else if (prompt === "fixture:partial") {
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "split result",
  });
  process.stdout.write(line.slice(0, 15));
  setTimeout(() => process.stdout.write(line.slice(15) + "\n"), 10);
} else {
  const bypass = process.argv.includes("--dangerously-skip-permissions");
  console.log(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "working" }] },
    }),
  );
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify({ bypass, prompt, args: process.argv.slice(2) }),
      session_id: "fixture-session",
    }),
  );
}
