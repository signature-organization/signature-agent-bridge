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

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const version = JSON.parse(readFileSync("package.json", "utf8"))
  .version as string;
const binaryName =
  "signature-agent-bridge" + (process.platform === "win32" ? ".exe" : "");
const builder = process.env.BRIDGE_SEA_NODE ?? process.execPath;
execFileSync(builder, ["--build-sea", "dist/sea-config.json"], {
  stdio: "inherit",
});
if (process.platform === "darwin")
  execFileSync("codesign", ["--force", "--sign", "-", "dist/" + binaryName], {
    stdio: "inherit",
  });
chmodSync("dist/" + binaryName, 0o755);
if (
  execFileSync(resolve("dist", binaryName), ["--version"], {
    encoding: "utf8",
  }).trim() !== version
)
  throw new Error("Native executable smoke test failed");
const stem =
  "signature-agent-bridge-" +
  version +
  "-" +
  process.platform +
  "-" +
  process.arch;
const staging = join("release", stem),
  desktop = join(staging, "desktop"),
  portable = join(staging, "portable");
mkdirSync(join(desktop, "server"), { recursive: true });
mkdirSync(join(desktop, "assets"), { recursive: true });
mkdirSync(portable, { recursive: true });
copyFileSync("dist/" + binaryName, join(desktop, "server", binaryName));
copyFileSync("dist/" + binaryName, join(portable, binaryName));
for (const file of ["LICENSE", "NOTICE"]) {
  copyFileSync(file, join(desktop, file));
  copyFileSync(file, join(portable, file));
}
for (const target of [desktop, portable])
  copyFileSync(
    "dist/THIRD_PARTY_NOTICES.txt",
    join(target, "THIRD_PARTY_NOTICES.txt"),
  );
copyFileSync("assets/logo.png", join(desktop, "assets", "logo.png"));
copyFileSync(
  "assets/screenshots/dashboard-desktop.png",
  join(desktop, "assets", "dashboard.png"),
);
const manifest = JSON.parse(
  readFileSync("integrations/desktop/manifest.json", "utf8"),
);
manifest.server.entry_point = "server/" + binaryName;
manifest.server.mcp_config.command = "${__dirname}/server/" + binaryName;
manifest.compatibility.platforms = [process.platform];
writeFileSync(
  join(desktop, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
copyFileSync(
  "integrations/desktop/manifest.json.license",
  join(desktop, "manifest.json.license"),
);
const cli = resolve("node_modules/@anthropic-ai/mcpb/dist/cli/cli.js");
execFileSync(process.execPath, [cli, "validate", desktop], {
  stdio: "inherit",
});
execFileSync(
  "tar",
  ["-czf", resolve("release", stem + ".tar.gz"), "-C", portable, "."],
  { stdio: "inherit" },
);
if (process.platform !== "linux")
  execFileSync(
    process.execPath,
    [cli, "pack", desktop, resolve("release", stem + ".mcpb")],
    { stdio: "inherit" },
  );
const assets = readdirSync("release").filter(
  (p) => p.endsWith(".tar.gz") || p.endsWith(".mcpb"),
);
writeFileSync(
  "release/SHA256SUMS",
  assets
    .sort()
    .map(
      (p) =>
        createHash("sha256")
          .update(readFileSync(join("release", p)))
          .digest("hex") +
        "  " +
        p,
    )
    .join("\n") + "\n",
);
console.log("Packaged " + stem);
