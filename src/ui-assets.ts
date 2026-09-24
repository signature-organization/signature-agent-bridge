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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// The release builder embeds these same files, so native installations need no asset directory.
const directory = fileURLToPath(new URL("./ui/", import.meta.url));
export const uiAssets = {
  html: readFileSync(directory + "index.html", "utf8"),
  css: readFileSync(directory + "app.css", "utf8"),
  auditJs: readFileSync(directory + "audit.js", "utf8"),
  js: readFileSync(directory + "app.js", "utf8"),
  brand: readFileSync(
    fileURLToPath(new URL("../assets/logo.png", import.meta.url)),
  ).toString("base64"),
};
