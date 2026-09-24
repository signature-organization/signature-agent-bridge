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

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n");
const read = (path: string) => readFileSync(path, "utf8");
const version = JSON.parse(read("package.json")).version;
for (const file of [
  "integrations/desktop/manifest.json",
  "integrations/claude-code/.claude-plugin/plugin.json",
])
  assert.equal(JSON.parse(read(file)).version, version, file + " version");
assert.equal(
  JSON.parse(read(".claude-plugin/marketplace.json")).plugins[0].version,
  version,
);
assert(
  read("integrations/claude-code/scripts/bootstrap.sh").includes(
    'version="' + version + '"',
  ),
);
assert(read("src/cli.ts").includes('console.log("' + version + '")'));
for (const file of files) {
  if (file.startsWith("vendor-licenses/")) continue;
  if (/\.(ts|js|mjs|css|svg|html|sh|yml)$/.test(file)) {
    const start = read(file).slice(0, 1800);
    for (const notice of [
      "Signature Management Consultants SLU",
      "@ancongui",
      "SPDX-License-Identifier: Apache-2.0",
      "https://www.apache.org/licenses/LICENSE-2.0",
    ])
      assert(start.includes(notice), file + " lacks " + notice);
  }
  if (file.endsWith(".json"))
    assert(
      existsSync(file + ".license"),
      file + " lacks its JSON license sidecar",
    );
  if (file.endsWith(".md")) {
    for (const match of read(file).matchAll(
      /!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g,
    )) {
      const link = match[1]!;
      if (/^(https?:|mailto:|#)/.test(link)) continue;
      assert(
        existsSync(
          resolve(dirname(file), decodeURIComponent(link.split("#")[0]!)),
        ),
        file + " has a broken link: " + link,
      );
    }
  }
}
const api = JSON.parse(read("docs/openapi.json"));
for (const match of read("src/http.ts").matchAll(
  /app\.(get|post|put|delete)\(\s*["'](\/v1\/[^"']+)["']/g,
)) {
  const path = match[2]!.replace(/:([A-Za-z]+)/g, "{$1}");
  assert(
    api.paths[path]?.[match[1]!],
    match[1] + " " + path + " missing from OpenAPI",
  );
}
const privatePaths = [
  ".codex/plan.md",
  ".superpowers/plan.md",
  "outputs/design.md",
  ".env",
  "queue.sqlite",
  "node_modules/test",
  "release/test.mcpb",
];
for (const path of privatePaths)
  execFileSync("git", ["check-ignore", "--quiet", path]);
console.log(
  "Repository notices, documentation links, versions, OpenAPI coverage, and private-file exclusions passed.",
);
