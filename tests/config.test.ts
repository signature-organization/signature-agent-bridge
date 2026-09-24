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

import { expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { resolve } from "node:path";
const config = {
  dataDir: resolve("work/data"),
  workspace: resolve("work/jobs"),
  claudePath: process.execPath,
};
it("validates local paths, limits and the default bypass configuration", () => {
  expect(parseConfig(config).profiles.default?.tools).toContain("Bash");
  expect(() => parseConfig({ ...config, claudePath: "relative" })).toThrow();
  expect(() => parseConfig({ ...config, concurrency: 0 })).toThrow();
  expect(() => parseConfig({ ...config, port: 70000 })).toThrow();
  expect(() => parseConfig({ ...config, unknown: true })).toThrow();
});
