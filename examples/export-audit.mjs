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

import { open, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const {
  BRIDGE_URL = "http://127.0.0.1:8766",
  BRIDGE_TOKEN,
  JOB_ID,
} = process.env;
if (!BRIDGE_TOKEN || !JOB_ID || !/^[0-9a-f-]{36}$/i.test(JOB_ID))
  throw new Error("Set BRIDGE_TOKEN and JOB_ID. BRIDGE_URL is optional.");
const destination = process.argv[2] ?? `bridge-audit-${JOB_ID}.json`;
// Exclusive creation protects an existing export. The file may contain source code and secrets.
const file = await open(destination, "wx", 0o600);
let complete = false;
try {
  let after = 0,
    through,
    first = true;
  do {
    const url = new URL(`/v1/bridge/jobs/${JOB_ID}/audit`, BRIDGE_URL);
    url.search = new URLSearchParams({
      after: String(after),
      limit: "200",
      includePayloads: "true",
      ...(through === undefined ? {} : { through: String(through) }),
    }).toString();
    let response;
    for (let retry = 0; retry < 4; retry++) {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
        signal: AbortSignal.timeout(30000),
      });
      if (response.status !== 429) break;
      await response.body?.cancel();
      if (retry < 3) await delay(60000);
    }
    if (!response.ok)
      throw new Error(`Audit export failed: HTTP ${response.status}`);
    const page = await response.json();
    if (through === undefined) {
      through = page.through;
      await file.writeFile(
        JSON.stringify({
          schemaVersion: 1,
          jobId: JOB_ID,
          through,
          exportedAt: new Date().toISOString(),
        }).slice(0, -1) + ',"entries":[',
      );
    }
    for (const entry of page.entries) {
      await file.writeFile((first ? "" : ",") + JSON.stringify(entry));
      first = false;
    }
    after = page.nextCursor;
  } while (after !== null);
  await file.writeFile("]}\n");
  await file.sync();
  complete = true;
  console.log(`Saved ${destination}`);
} finally {
  await file.close();
  if (!complete) await unlink(destination);
}
