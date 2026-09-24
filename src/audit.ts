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

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { BridgeError, type Attempt, type Job } from "./contracts.js";

export const auditQuery = z.strictObject({
  includePayloads: z.enum(["true", "false"]).default("false"),
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  through: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const toolsQuery = auditQuery
  .omit({ through: true, includePayloads: true })
  .extend({ filesOnly: z.enum(["true", "false"]).default("false") });
export type AuditQuery = z.input<typeof auditQuery>;
export type ToolsQuery = z.input<typeof toolsQuery>;
export type ToolObservation = {
  input?: unknown;
  output?: unknown;
  toolId: string;
  phase: "requested" | "succeeded" | "failed";
  name?: string;
  parentToolUseId?: string;
  sessionId?: string;
  file?: { path: string; operation: "read" | "write" | "edit" };
};
export type ToolRecord = Omit<ToolObservation, "phase"> & {
  id: number;
  jobId: string;
  attemptId: string;
  sessionId?: string;
  status: ToolObservation["phase"] | "unknown";
  requestedAt?: string;
  completedAt?: string;
  durationMs?: number;
};
export type AuditEntry = {
  id: number;
  jobId: string;
  attemptId?: string;
  sessionId?: string;
  type: string;
  source: "claude" | "bridge" | "client";
  createdAt: string;
  data: Record<string, unknown>;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const identifier = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value)
    ? value
    : undefined;
const toolName = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(value)
    ? value
    : undefined;
/** Preserve emitted payloads; classify file targets separately so custom tools never masquerade as filesystem evidence. */
export function nativeToolObservations(raw: unknown): ToolObservation[] {
  const message = object(raw),
    content = object(message.message).content;
  if (
    !Array.isArray(content) ||
    !["assistant", "user"].includes(String(message.type))
  )
    return [];
  const observations: ToolObservation[] = [];
  for (const item of content) {
    const block = object(item),
      parentToolUseId = identifier(message.parent_tool_use_id),
      sessionId = identifier(message.session_id);
    if (message.type === "assistant" && block.type === "tool_use") {
      const toolId = identifier(block.id),
        name = toolName(block.name);
      if (!toolId || !name) continue;
      const input = object(block.input),
        path = name === "NotebookEdit" ? input.notebook_path : input.file_path;
      const operation =
        name === "Read"
          ? "read"
          : name === "Write"
            ? "write"
            : ["Edit", "NotebookEdit"].includes(name)
              ? "edit"
              : undefined;
      // Do not infer paths from shell commands, search scopes, or third-party tool names.
      const file: ToolObservation["file"] =
        operation &&
        typeof path === "string" &&
        path.length > 0 &&
        path.length <= 1024 &&
        !/[\u0000-\u001f\u007f]/.test(path)
          ? { path, operation }
          : undefined;
      observations.push({
        ...(sessionId ? { sessionId } : {}),
        input: block.input,
        toolId,
        name,
        phase: "requested",
        ...(parentToolUseId ? { parentToolUseId } : {}),
        ...(file ? { file } : {}),
      });
    } else if (message.type === "user" && block.type === "tool_result") {
      const toolId = identifier(block.tool_use_id);
      if (toolId)
        observations.push({
          ...(sessionId ? { sessionId } : {}),
          output: {
            content: block.content,
            isError: block.is_error === true,
            ...(message.tool_use_result === undefined
              ? {}
              : { result: message.tool_use_result }),
          },
          toolId,
          phase: block.is_error === true ? "failed" : "succeeded",
          ...(parentToolUseId ? { parentToolUseId } : {}),
        });
    }
  }
  return observations;
}

/** Writes share the queue transaction: a committed state and its audit cannot disagree. */
export class AuditLog {
  constructor(private db: DatabaseSync) {}
  append(
    job: Job,
    type: string,
    source: AuditEntry["source"],
    data: Record<string, unknown>,
    attemptId?: string,
  ): void {
    const entry = {
      jobId: job.id,
      attemptId,
      sessionId: job.sessionId,
      type,
      source,
      createdAt: new Date().toISOString(),
      data,
    };
    this.db
      .prepare("INSERT INTO audit_entries(job_id,data) VALUES(?,?)")
      .run(job.id, JSON.stringify(entry));
  }
  lifecycle(job: Job, type: string, raw: unknown, attemptId?: string): void {
    if (["job.progress", "job.activity", "job.tool"].includes(type)) return;
    const input = object(raw),
      data: Record<string, unknown> = {};
    // Prompts, progress, descriptions, and provider error messages stay out of the metadata audit.
    for (const key of [
      "status",
      "taskId",
      "sessionId",
      "actor",
      "trigger",
      "compactResult",
      "reason",
    ])
      if (identifier(input[key])) data[key] = input[key];
    for (const key of ["pre_tokens", "depth", "resetsAt"])
      if (typeof input[key] === "number" && Number.isFinite(input[key]))
        data[key] = input[key];
    for (const key of ["retry", "followUp", "queued"])
      if (typeof input[key] === "boolean") data[key] = input[key];
    this.append(
      job,
      type,
      [
        "job.session",
        "job.compaction",
        "job.subagent",
        "job.rate_limit",
      ].includes(type)
        ? "claude"
        : "bridge",
      data,
      attemptId,
    );
  }
  observe(job: Job, attempt: Attempt, event: ToolObservation): boolean {
    const row = this.db
      .prepare(
        "SELECT id,data FROM audit_tools WHERE job_id=? AND attempt_id=? AND tool_id=?",
      )
      .get(job.id, attempt.id, event.toolId) as
      { id: number; data: string } | undefined;
    const tool: ToolRecord = row
      ? { ...(JSON.parse(row.data) as ToolRecord), id: row.id }
      : {
          id: 0,
          jobId: job.id,
          attemptId: attempt.id,
          sessionId: event.sessionId ?? job.sessionId,
          toolId: event.toolId,
          status: "requested",
        };
    const now = new Date().toISOString();
    // Native messages can be replayed or arrive out of order. The first observed result is authoritative.
    if (event.phase === "requested") {
      if (tool.requestedAt) return false;
      tool.requestedAt = now;
      tool.name = event.name;
      tool.file = event.file;
      tool.input = event.input;
    } else {
      if (tool.completedAt) return false;
      tool.status = event.phase;
      tool.completedAt = now;
      tool.output = event.output;
    }
    tool.parentToolUseId ??= event.parentToolUseId;
    if (
      tool.completedAt &&
      tool.requestedAt &&
      tool.completedAt >= tool.requestedAt
    )
      tool.durationMs =
        Date.parse(tool.completedAt) - Date.parse(tool.requestedAt);
    if (row)
      this.db
        .prepare("UPDATE audit_tools SET data=? WHERE id=?")
        .run(JSON.stringify(tool), row.id);
    else
      tool.id = Number(
        this.db
          .prepare(
            "INSERT INTO audit_tools(job_id,attempt_id,tool_id,data) VALUES(?,?,?,?)",
          )
          .run(job.id, attempt.id, event.toolId, JSON.stringify(tool))
          .lastInsertRowid,
      );
    this.append(job, "tool." + event.phase, "claude", { ...tool }, attempt.id);
    return true;
  }
  closeAttempt(job: Job, attempt: Attempt): void {
    for (const row of this.db
      .prepare(
        "SELECT id,data FROM audit_tools WHERE job_id=? AND attempt_id=? AND json_extract(data,'$.status')='requested'",
      )
      .all(job.id, attempt.id) as { id: number; data: string }[]) {
      const tool = {
        ...(JSON.parse(row.data) as ToolRecord),
        id: row.id,
        status: "unknown" as const,
      };
      // Process termination says nothing about whether a side effect already happened.
      this.db
        .prepare("UPDATE audit_tools SET data=? WHERE id=?")
        .run(JSON.stringify(tool), row.id);
      this.append(job, "tool.unknown", "bridge", { ...tool }, attempt.id);
    }
  }
  clientHistory(job: Job): void {
    for (const message of job.completion?.messages ?? []) {
      for (const call of message.tool_calls ?? [])
        this.append(job, "client.tool_request_reported", "client", {
          toolId: call.id,
          name: call.function.name,
          input: call.function.arguments,
        });
      if (message.role === "tool")
        this.append(job, "client.tool_result_reported", "client", {
          toolId: message.tool_call_id,
          output: message.content,
        });
    }
  }
  clientResult(job: Job, attempt: Attempt): void {
    if (!job.completion || !job.result) return;
    let value: Record<string, unknown>;
    try {
      value = object(JSON.parse(job.result));
    } catch {
      return;
    }
    if (!Array.isArray(value.tool_calls)) return;
    for (const [index, raw] of value.tool_calls.slice(0, 16).entries()) {
      const name = toolName(object(raw).name);
      if (name)
        this.append(
          job,
          "client.tool_requested",
          "claude",
          {
            toolId: "call_" + job.id.replaceAll("-", "") + "_" + index,
            name,
            input: object(raw).arguments,
          },
          attempt.id,
        );
    }
  }
  summary(job: Job) {
    const counts = this.db
      .prepare(
        `SELECT count(*) AS tools,
      count(DISTINCT json_extract(data,'$.file.path')) AS files,
      count(DISTINCT CASE WHEN json_extract(data,'$.status')='succeeded' AND json_extract(data,'$.file.operation') IN ('write','edit') THEN json_extract(data,'$.file.path') END) AS changedFiles,
      coalesce(sum(json_extract(data,'$.status')='failed'),0) AS failedTools,
      coalesce(sum(json_extract(data,'$.status')='unknown'),0) AS unknownTools
      FROM audit_tools WHERE job_id=?`,
      )
      .get(job.id) as {
      tools: number;
      files: number;
      changedFiles: number;
      failedTools: number;
      unknownTools: number;
    };
    const { events } = this.db
      .prepare("SELECT count(*) AS events FROM audit_entries WHERE job_id=?")
      .get(job.id) as { events: number };
    return {
      ...counts,
      events,
      coverage: job.completion
        ? "client_functions"
        : job.mode === "channel"
          ? "host_lifecycle"
          : "native_tools",
    };
  }
  page(job: Job, raw: AuditQuery) {
    const query = auditQuery.parse(raw);
    const { last } = this.db
      .prepare(
        "SELECT coalesce(max(id),0) AS last FROM audit_entries WHERE job_id=?",
      )
      .get(job.id) as { last: number };
    const through = Math.min(query.through ?? last, last);
    // Iterate within a byte budget; a single complete native payload is never silently truncated.
    const selection =
      query.includePayloads === "true"
        ? "data"
        : "json_remove(data,'$.data.input','$.data.output')";
    const entries: AuditEntry[] = [];
    let bytes = 0,
      more = false;
    for (const rawRow of this.db
      .prepare(
        `SELECT id,${selection} AS data FROM audit_entries WHERE job_id=? AND id>? AND id<=? ORDER BY id LIMIT ?`,
      )
      .iterate(job.id, query.after, through, query.limit + 1)) {
      const row = rawRow as { id: number; data: string };
      const size = Buffer.byteLength(row.data);
      if (
        entries.length &&
        (entries.length === query.limit || bytes + size > 4_000_000)
      ) {
        more = true;
        break;
      }
      entries.push({ ...(JSON.parse(row.data) as AuditEntry), id: row.id });
      bytes += size;
    }
    return {
      entries,
      through,
      nextCursor: more ? entries.at(-1)!.id : null,
      summary: this.summary(job),
    };
  }
  tool(job: Job, id: number): ToolRecord {
    const row = this.db
      .prepare("SELECT id,data FROM audit_tools WHERE job_id=? AND id=?")
      .get(job.id, id) as { id: number; data: string } | undefined;
    if (!row)
      throw new BridgeError("not_found", "Tool observation not found", 404);
    return { ...(JSON.parse(row.data) as ToolRecord), id: row.id };
  }
  tools(job: Job, raw: ToolsQuery) {
    const query = toolsQuery.parse(raw);
    const rows = this.db
      .prepare(
        "SELECT id,json_remove(data,'$.input','$.output') AS data FROM audit_tools WHERE job_id=? AND id>? AND (?=0 OR json_extract(data,'$.file.path') IS NOT NULL) ORDER BY id LIMIT ?",
      )
      .all(
        job.id,
        query.after,
        query.filesOnly === "true" ? 1 : 0,
        query.limit + 1,
      ) as { id: number; data: string }[];
    const tools = rows
      .slice(0, query.limit)
      .map((row) => ({ ...(JSON.parse(row.data) as ToolRecord), id: row.id }));
    return {
      tools,
      nextCursor: rows.length > query.limit ? tools.at(-1)!.id : null,
    };
  }
}
