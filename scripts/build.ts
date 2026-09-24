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

import { build } from "esbuild";
import {
  mkdirSync,
  readFileSync,
  chmodSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
mkdirSync("dist", { recursive: true });
const uiAssets = {
  html: readFileSync("src/ui/index.html", "utf8"),
  css: readFileSync("src/ui/app.css", "utf8"),
  auditJs: readFileSync("src/ui/audit.js", "utf8"),
  js: readFileSync("src/ui/app.js", "utf8"),
  brand: readFileSync("assets/logo.png").toString("base64"),
};
const assets = {
  name: "embedded-ui",
  setup(builder: import("esbuild").PluginBuild) {
    builder.onLoad({ filter: /ui-assets\.ts$/ }, () => ({
      contents: "export const uiAssets=" + JSON.stringify(uiAssets),
      loader: "js",
    }));
  },
};
const result = await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  minify: false,
  legalComments: "inline",
  plugins: [assets],
  metafile: true,
});
// A single-file executable still redistributes its dependencies. Carry complete upstream notices.
const packages = new Set<string>();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (match) packages.add(match[1]!);
}
let notices = "Third-party software bundled with Signature Agent Bridge\n\n";
for (const name of [...packages].sort()) {
  const directory = resolve("node_modules", name),
    pkg = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  const licenses = readdirSync(directory).filter((file) =>
    /^(license|licence|copying|notice)(\.|$)/i.test(file),
  );
  notices +=
    "=".repeat(72) +
    "\n" +
    name +
    " " +
    pkg.version +
    " (" +
    String(pkg.license) +
    ")\n\n";
  if (!licenses.length) {
    const fallback = resolve(
      "vendor-licenses",
      name.replaceAll("/", "-") + ".txt",
    );
    if (!existsSync(fallback))
      throw new Error("Missing redistributable license: " + name);
    notices += readFileSync(fallback, "utf8") + "\n\n";
  }
  for (const license of licenses)
    notices += readFileSync(resolve(directory, license), "utf8") + "\n\n";
}
if (!existsSync("vendor-licenses/node.txt"))
  throw new Error("Node runtime license is missing");
notices +=
  "=".repeat(72) +
  "\nNode.js runtime 26.3.0 and its bundled dependencies\n\n" +
  readFileSync("vendor-licenses/node.txt", "utf8");
writeFileSync("dist/THIRD_PARTY_NOTICES.txt", notices);
chmodSync("dist/cli.cjs", 0o755);
writeFileSync(
  "dist/sea-config.json",
  JSON.stringify({
    main: resolve("dist/cli.cjs"),
    output: resolve(
      "dist",
      process.platform === "win32"
        ? "signature-agent-bridge.exe"
        : "signature-agent-bridge",
    ),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
    execArgvExtension: "none",
  }),
);
console.log("Built CLI and embedded dashboard.");
