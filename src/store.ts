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

import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { migrate } from "./migrations.js";
import type { WorkerEvent } from "./worker.js";
import {
  BridgeError,
  jobInputSchema,
  terminal,
  type Attempt,
  type BridgeEvent,
  type Job,
  type JobInput,
  type Outcome,
  type Principal,
} from "./contracts.js";
const system: Principal = { id: "system", owner: true, profiles: [] };
const stamp = () => new Date().toISOString();
export class QueueStore {
  readonly db: DatabaseSync;
  private depth = 0;
  private closed = false;
  constructor(
    path: string,
    private capacity = 1000,
  ) {
    this.db = new DatabaseSync(path);
    try {
      migrate(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  atomic<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }
  private save(job: Job): void {
    job.updatedAt = stamp();
    this.db
      .prepare("UPDATE jobs SET status=?,data=? WHERE id=?")
      .run(job.status, JSON.stringify(job), job.id);
  }
  addEvent(job: Job, type: string, data: unknown): void {
    this.db
      .prepare(
        "INSERT INTO events(principal_id,job_id,type,data,created_at) VALUES(?,?,?,?,?)",
      )
      .run(job.principalId, job.id, type, JSON.stringify(data), stamp());
  }
  idempotent<T>(
    p: Principal,
    route: string,
    key: string | undefined,
    input: unknown,
    create: () => T & { id: string },
    get: (id: string) => T,
  ): T {
    return this.atomic(() => {
      if (key !== undefined && (key.length < 1 || key.length > 128))
        throw new BridgeError(
          "invalid_idempotency_key",
          "Idempotency key must contain 1–128 characters",
        );
      const digest = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      if (key) {
        const row = this.db
          .prepare(
            "SELECT fingerprint,resource_id FROM idempotency WHERE principal_id=? AND route=? AND key=?",
          )
          .get(p.id, route, key) as
          { fingerprint: string; resource_id: string } | undefined;
        if (row) {
          if (row.fingerprint !== digest)
            throw new BridgeError(
              "idempotency_conflict",
              "Idempotency key used with a different request",
              409,
            );
          return get(row.resource_id);
        }
      }
      const result = create();
      if (key)
        this.db
          .prepare("INSERT INTO idempotency VALUES(?,?,?,?,?)")
          .run(p.id, route, key, digest, result.id);
      return result;
    });
  }
  private checkCapacity(): void {
    const row = this.db
      .prepare(
        "SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running','cancel_requested')",
      )
      .get() as { n: number };
    if (row.n >= this.capacity)
      throw new BridgeError("queue_full", "Queue capacity reached", 429);
  }
  submit(raw: unknown, p: Principal, key?: string): Job {
    const input = jobInputSchema.parse(raw);
    if (!p.owner && !p.profiles.includes(input.profile))
      throw new BridgeError(
        "profile_forbidden",
        "Profile unavailable to this client",
        403,
      );
    return this.idempotent(
      p,
      "jobs",
      key,
      input,
      () => {
        this.checkCapacity();
        const now = stamp();
        const job: Job = {
          ...input,
          id: randomUUID(),
          principalId: p.id,
          status: "queued",
          createdAt: now,
          updatedAt: now,
          messages: [
            {
              id: randomUUID(),
              role: "user",
              text: input.prompt,
              createdAt: now,
            },
          ],
        };
        this.db
          .prepare("INSERT INTO jobs VALUES(?,?,?,?,?)")
          .run(job.id, p.id, job.mode, job.status, JSON.stringify(job));
        this.addEvent(job, "job.queued", { status: job.status });
        return job;
      },
      (id) => this.get(id, p),
    );
  }
  get(id: string, p: Principal = system): Job {
    const row = this.db.prepare("SELECT data FROM jobs WHERE id=?").get(id) as
      { data: string } | undefined;
    const job = row ? (JSON.parse(row.data) as Job) : null;
    if (!job || (!p.owner && job.principalId !== p.id))
      throw new BridgeError("not_found", "Job not found", 404);
    return job;
  }
  list(
    p: Principal = system,
    limit = 100,
    after = "",
    order: "asc" | "desc" = "asc",
  ): Job[] {
    return (
      this.db
        .prepare(
          order === "desc"
            ? "SELECT data FROM jobs WHERE (?=1 OR principal_id=?) AND rowid<COALESCE((SELECT rowid FROM jobs WHERE id=?),9223372036854775807) ORDER BY rowid DESC LIMIT ?"
            : "SELECT data FROM jobs WHERE (?=1 OR principal_id=?) AND rowid>COALESCE((SELECT rowid FROM jobs WHERE id=?),0) ORDER BY rowid LIMIT ?",
        )
        .all(
          p.owner ? 1 : 0,
          p.id,
          after,
          Math.min(Math.max(limit, 1), 200),
        ) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as Job);
  }
  pending(mode: JobInput["mode"]): Job[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM jobs WHERE status='queued' AND mode=? ORDER BY rowid LIMIT 100",
        )
        .all(mode) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as Job);
  }
  claim(owner: string, mode: JobInput["mode"], jobId?: string): Attempt | null {
    return this.atomic(() => {
      const row = this.db
        .prepare(
          "SELECT data FROM jobs WHERE status='queued' AND mode=? AND (? IS NULL OR id=?) ORDER BY rowid LIMIT 1",
        )
        .get(mode, jobId ?? null, jobId ?? null) as
        { data: string } | undefined;
      if (!row) return null;
      const job = JSON.parse(row.data) as Job;
      const now = stamp();
      const attempt: Attempt = {
        id: randomUUID(),
        jobId: job.id,
        owner,
        fence: randomUUID(),
        status: "running",
        createdAt: now,
        updatedAt: now,
      };
      job.status = "running";
      this.save(job);
      this.db
        .prepare("INSERT INTO attempts VALUES(?,?,?)")
        .run(attempt.id, job.id, JSON.stringify(attempt));
      this.addEvent(job, "job.running", { status: job.status });
      return attempt;
    });
  }
  validateAttempt(attempt: Attempt): Job {
    const row = this.db
      .prepare("SELECT data FROM attempts WHERE id=? AND job_id=?")
      .get(attempt.id, attempt.jobId) as { data: string } | undefined;
    const current = row ? (JSON.parse(row.data) as Attempt) : null;
    if (
      !current ||
      current.fence !== attempt.fence ||
      current.owner !== attempt.owner ||
      current.status !== "running"
    )
      throw new BridgeError(
        "stale_attempt",
        "Attempt no longer belongs to this worker",
        409,
      );
    return this.get(attempt.jobId);
  }
  progress(attempt: Attempt, text: string): void {
    this.atomic(() => {
      const job = this.validateAttempt(attempt);
      this.addEvent(job, "job.progress", { text: text.slice(0, 16000) });
    });
  }
  /** Persist observations before forwarding them: reconnecting consumers replay the same facts. */
  observe(attempt: Attempt, event: WorkerEvent): void {
    this.atomic(() => {
      const job = this.validateAttempt(attempt);
      const data = event.data ?? {};
      if (event.kind === "session" && typeof data.sessionId === "string")
        job.sessionId = data.sessionId;
      if (event.kind === "compaction") {
        job.compactions = (job.compactions ?? 0) + 1;
        job.activity = "running";
      }
      if (event.kind === "activity" && typeof data.status === "string")
        job.activity = data.status;
      if (event.kind === "subagent" && typeof data.taskId === "string") {
        const agents = (job.subagents ??= {});
        if (Object.keys(agents).length < 128 || agents[data.taskId])
          agents[data.taskId] = {
            status: String(data.status ?? "running"),
            description: String(data.description ?? "").slice(0, 1000),
          };
      }
      this.save(job);
      this.addEvent(
        job,
        event.kind === "output" ? "job.progress" : "job." + event.kind,
        { text: event.text, ...data },
      );
    });
  }
  pause(id: string, p: Principal): Job {
    return this.atomic(() => {
      const job = this.get(id, p);
      if (job.status === "queued") job.status = "paused";
      else if (job.status === "running") job.status = "pause_requested";
      else return job;
      job.error = "operator_pause";
      this.save(job);
      this.addEvent(job, "job." + job.status, { reason: job.error });
      return job;
    });
  }
  resume(id: string, p: Principal): Job {
    return this.atomic(() => {
      const job = this.get(id, p);
      if (job.status !== "paused")
        throw new BridgeError(
          "invalid_resume",
          "Only paused jobs can resume",
          409,
        );
      if (job.retryAt && job.retryAt > Date.now())
        throw new BridgeError(
          "reset_pending",
          "The provider reset time has not arrived",
          409,
        );
      if (!p.owner && !p.profiles.includes(job.profile))
        throw new BridgeError(
          "profile_forbidden",
          "Profile is unavailable",
          403,
        );
      this.checkCapacity();
      job.resumePending = Boolean(job.sessionId);
      job.status = "queued";
      delete job.error;
      delete job.retryAt;
      this.save(job);
      this.addEvent(job, "job.resumed", { sessionId: job.sessionId });
      return job;
    });
  }
  finish(attempt: Attempt, outcome: Outcome): void {
    this.atomic(() => {
      const job = this.validateAttempt(attempt);
      if (
        job.status === "cancel_requested" &&
        !["canceled", "interrupted"].includes(outcome.status)
      )
        throw new BridgeError(
          "cancel_pending",
          "Cancellation requires reconciliation",
          409,
        );
      Object.assign(job, outcome);
      job.activity = outcome.status;
      if (outcome.status === "succeeded") {
        job.resumePending = false;
        job.resumedTurns = job.messages.filter((m) => m.role === "user").length;
      }
      for (const agent of Object.values(job.subagents ?? {}))
        if (["running", "started"].includes(agent.status))
          agent.status =
            outcome.status === "succeeded" ? "unknown" : "interrupted";
      if (outcome.status === "succeeded" && outcome.result !== undefined)
        job.messages.push({
          id: randomUUID(),
          role: "assistant",
          text: outcome.result,
          createdAt: stamp(),
        });
      const pending =
        outcome.status === "paused" ? [] : (job.pendingMessages ?? []);
      job.messages.push(...pending);
      if (outcome.status !== "paused") delete job.pendingMessages;
      if (pending.length && outcome.status === "succeeded") {
        job.status = "queued";
        delete job.result;
      }
      this.save(job);
      this.db.prepare("UPDATE attempts SET data=? WHERE id=?").run(
        JSON.stringify({
          ...attempt,
          status: outcome.status,
          updatedAt: stamp(),
        }),
        attempt.id,
      );
      this.addEvent(job, "job." + outcome.status, {
        status: outcome.status,
        error: outcome.error,
      });
      if (job.status === "queued")
        this.addEvent(job, "job.queued", { followUp: true });
    });
  }
  cancel(id: string, p: Principal): Job {
    return this.atomic(() => {
      const job = this.get(id, p);
      if (terminal.has(job.status) || job.status === "cancel_requested")
        return job;
      job.status = ["queued", "paused"].includes(job.status)
        ? "canceled"
        : "cancel_requested";
      this.save(job);
      this.addEvent(job, "job." + job.status, { status: job.status });
      return job;
    });
  }
  retry(id: string, p: Principal): Job {
    return this.atomic(() => {
      const job = this.get(id, p);
      if (
        !["failed", "interrupted", "timed_out", "canceled"].includes(job.status)
      )
        throw new BridgeError(
          "invalid_retry",
          "Only terminal unsuccessful jobs can retry",
          409,
        );
      this.checkCapacity();
      job.status = "queued";
      delete job.result;
      delete job.error;
      delete job.sessionId;
      delete job.resumePending;
      delete job.resumedTurns;
      delete job.retryAt;
      this.save(job);
      this.addEvent(job, "job.queued", { retry: true });
      return job;
    });
  }
  sendMessage(id: string, text: string, p: Principal, key?: string): Job {
    if (!text.trim() || text.length > 100000)
      throw new BridgeError(
        "invalid_message",
        "Message must contain 1–100000 characters",
      );
    return this.idempotent(
      p,
      "messages:" + id,
      key,
      { text },
      () => {
        const job = this.get(id, p);
        if (job.workflowRunId)
          throw new BridgeError(
            "workflow_message",
            "Send follow-ups to standalone jobs; workflow prompts are fixed",
            409,
          );
        if (
          ["cancel_requested", "pause_requested", "paused"].includes(job.status)
        )
          throw new BridgeError(
            "execution_paused",
            "Resume the job before adding another turn",
            409,
          );
        const messages = [...job.messages, ...(job.pendingMessages ?? [])];
        if (
          messages.length >= 64 ||
          messages.reduce((n, m) => n + m.text.length, text.length) > 200000
        )
          throw new BridgeError(
            "conversation_limit",
            "Conversation limit reached; submit a new job",
            413,
          );
        const message = {
          id: randomUUID(),
          role: "user" as const,
          text,
          createdAt: stamp(),
        };
        // A resumed native turn must finish before new instructions become another turn.
        if (job.status === "running" || job.resumePending)
          (job.pendingMessages ??= []).push(message);
        else {
          if (terminal.has(job.status)) this.checkCapacity();
          job.messages.push(message);
          job.status = "queued";
          delete job.result;
          delete job.error;
        }
        this.save(job);
        this.addEvent(job, "job.message", { message, queued: true });
        return job;
      },
      (resourceId) => this.get(resourceId, p),
    );
  }
  recover(): number {
    return this.atomic(() => {
      let n = 0;
      for (const row of this.db.prepare("SELECT data FROM attempts").all() as {
        data: string;
      }[]) {
        const a = JSON.parse(row.data) as Attempt;
        if (a.status === "running") {
          this.finish(a, {
            status: "interrupted",
            error: "Worker ownership lost; explicit retry required",
          });
          n++;
        }
      }
      return n;
    });
  }
  attempts(id: string, p: Principal): Attempt[] {
    this.get(id, p);
    return (
      this.db
        .prepare("SELECT data FROM attempts WHERE job_id=? ORDER BY rowid")
        .all(id) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as Attempt);
  }
  events(p: Principal, after: number, limit = 200): BridgeEvent[] {
    if (after < this.eventFloor())
      throw new BridgeError(
        "event_cursor_expired",
        "Event cursor expired; refresh job state",
        409,
      );
    return (
      this.db
        .prepare(
          "SELECT * FROM events WHERE id>? AND (?=1 OR principal_id=?) ORDER BY id LIMIT ?",
        )
        .all(after, p.owner ? 1 : 0, p.id, limit) as {
        id: number;
        principal_id: string;
        job_id: string;
        type: string;
        data: string;
        created_at: string;
      }[]
    ).map((r) => ({
      id: r.id,
      principalId: r.principal_id,
      jobId: r.job_id,
      type: r.type,
      data: JSON.parse(r.data) as unknown,
      createdAt: r.created_at,
    }));
  }
  eventFloor(): number {
    return Number(
      (
        this.db
          .prepare("SELECT value FROM metadata WHERE key='event_floor'")
          .get() as { value: string } | undefined
      )?.value ?? 0,
    );
  }
  pruneEvents(id: number): void {
    this.atomic(() => {
      this.db.prepare("DELETE FROM events WHERE id<=?").run(id);
      this.db
        .prepare("INSERT OR REPLACE INTO metadata VALUES('event_floor',?)")
        .run(String(Math.max(id, this.eventFloor())));
    });
  }
  linkWorkflow(id: string, runId: string, stepId: string): void {
    const job = this.get(id);
    Object.assign(job, { workflowRunId: runId, stepId });
    this.save(job);
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
