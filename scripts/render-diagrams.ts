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

import { chromium } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 730 },
    deviceScaleFactor: 1,
  });
  for (const name of readdirSync("assets/diagrams").filter((n) =>
    n.endsWith(".svg"),
  )) {
    await page.setContent(
      '<html><body style="margin:0">' +
        readFileSync("assets/diagrams/" + name, "utf8") +
        "</body></html>",
    );
    await page.screenshot({
      path: "assets/diagrams/" + name.replace(".svg", ".png"),
      fullPage: true,
    });
  }
} finally {
  await browser.close();
}
console.log("Rendered SVG diagrams to PNG.");
