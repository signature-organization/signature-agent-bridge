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

import { randomUUID } from "node:crypto";
const base = process.env.BRIDGE_URL ?? "http://127.0.0.1:8766",
  token = process.env.BRIDGE_TOKEN;
if (!token) throw new Error("Set BRIDGE_TOKEN to a scoped client token.");
const headers = {
  Authorization: "Bearer " + token,
  "Content-Type": "application/json",
};
const prompt =
  process.argv.slice(2).join(" ") ||
  "Explain the purpose of this local bridge in one paragraph.";
const response = await fetch(base + "/v1/jobs", {
  method: "POST",
  headers: { ...headers, "Idempotency-Key": randomUUID() },
  body: JSON.stringify({ prompt }),
});
if (!response.ok) throw new Error(await response.text());
const job = await response.json();
console.log("Queued job:", job.id);
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
let cursor = 0,
  finished = false,
  delay = 1000;
while (!finished && !controller.signal.aborted) {
  try {
    const stream = await fetch(base + "/v1/events", {
      headers: { ...headers, "Last-Event-ID": String(cursor) },
      signal: controller.signal,
    });
    if (stream.status === 409) {
      const status = await (
        await fetch(base + "/v1/status", { headers })
      ).json();
      cursor = status.eventCursorFloor;
      const current = await (
        await fetch(base + "/v1/jobs/" + job.id, { headers })
      ).json();
      console.log("Refreshed state:", current.status);
      if (
        [
          "succeeded",
          "failed",
          "canceled",
          "interrupted",
          "timed_out",
          "paused",
        ].includes(current.status)
      ) {
        console.log(current.result ?? current.error ?? "");
        break;
      }
      continue;
    }
    if (!stream.ok) throw new Error("Event connection: HTTP " + stream.status);
    delay = 1000;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const eventId = Number(frame.match(/^id: (\d+)/m)?.[1]),
          raw = frame.match(/^data: (.+)$/m)?.[1];
        if (!raw || !eventId || eventId <= cursor) continue;
        const event = JSON.parse(raw);
        cursor = eventId;
        if (event.jobId !== job.id) continue;
        console.log(event.type, event.data.text ?? event.data.error ?? "");
        if (
          [
            "job.succeeded",
            "job.failed",
            "job.canceled",
            "job.interrupted",
            "job.timed_out",
            "job.paused",
          ].includes(event.type)
        ) {
          const current = await (
            await fetch(base + "/v1/jobs/" + job.id, { headers })
          ).json();
          console.log(current.result ?? current.error ?? current.status);
          finished = true;
          controller.abort();
          break;
        }
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) console.error(error.message);
  }
  if (!finished && !controller.signal.aborted) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 15000);
  }
}
