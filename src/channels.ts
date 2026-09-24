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

import { QueueStore } from "./store.js";
import { BridgeError, type Attempt } from "./contracts.js";
export class Channels {
  private hosts = new Map<string, number>();
  constructor(private store: QueueStore) {}
  heartbeat(host: string): void {
    this.hosts.set(host, Date.now());
  }
  private live(host: string): void {
    if ((this.hosts.get(host) ?? 0) < Date.now() - 7000)
      throw new BridgeError("host_expired", "Host lease expired", 409);
  }
  claim(host: string, id: string) {
    this.live(host);
    const outstanding = this.store.db
      .prepare(
        "SELECT 1 FROM attempts WHERE json_extract(data,'$.owner')=? AND json_extract(data,'$.status')='running' LIMIT 1",
      )
      .get("channel:" + host);
    if (outstanding)
      throw new BridgeError(
        "host_busy",
        "The host already has an outstanding claim",
        409,
      );
    // Delivery is only a notification. The fenced claim is the sole authority to execute a job.
    const attempt = this.store.claim("channel:" + host, "channel", id);
    if (!attempt)
      throw new BridgeError("already_claimed", "Job is not available", 409);
    return { attempt, job: this.store.get(id) };
  }
  private attempt(host: string, id: string, fence: string): Attempt {
    this.live(host);
    const row = this.store.db
      .prepare("SELECT data FROM attempts WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new BridgeError("not_found", "Attempt not found", 404);
    const attempt = JSON.parse(row.data) as Attempt;
    if (attempt.owner !== "channel:" + host || attempt.fence !== fence)
      throw new BridgeError(
        "stale_attempt",
        "Host does not own this attempt",
        409,
      );
    this.store.validateAttempt(attempt);
    return attempt;
  }
  progress(host: string, id: string, fence: string, text: string) {
    const attempt = this.attempt(host, id, fence);
    this.store.progress(attempt, text);
    return { status: this.store.get(attempt.jobId).status };
  }
  complete(host: string, id: string, fence: string, result: string) {
    const attempt = this.attempt(host, id, fence),
      job = this.store.get(attempt.jobId);
    if (["pause_requested", "cancel_requested"].includes(job.status))
      throw new BridgeError(
        "control_pending",
        "Acknowledge the requested stop before completing",
        409,
      );
    this.store.finish(attempt, { status: "succeeded", result });
    return this.store.get(job.id);
  }
  acknowledgeStop(host: string, id: string, fence: string) {
    const attempt = this.attempt(host, id, fence),
      job = this.store.get(attempt.jobId);
    if (!["pause_requested", "cancel_requested"].includes(job.status))
      throw new BridgeError("invalid_stop", "No stop was requested", 409);
    this.store.finish(attempt, {
      status: job.status === "pause_requested" ? "paused" : "canceled",
      error: "Host acknowledged that its work stopped",
    });
    return this.store.get(job.id);
  }
  disconnect(host: string): void {
    this.hosts.delete(host);
    this.reap();
  }
  reap(now = Date.now()): void {
    for (const [id, seen] of this.hosts)
      if (now - seen > 7000) this.hosts.delete(id);
    for (const row of this.store.db
      .prepare("SELECT data FROM attempts")
      .all() as { data: string }[]) {
      const a = JSON.parse(row.data) as Attempt;
      if (
        a.status === "running" &&
        a.owner.startsWith("channel:") &&
        !this.hosts.has(a.owner.slice(8))
      )
        this.store.finish(a, {
          status: "interrupted",
          error:
            "Channel host disconnected; external actions need reconciliation",
        });
    }
  }
}
