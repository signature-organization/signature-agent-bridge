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

import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { chatRequestSchema } from "../src/completion-protocol.js";
import { templateSchema } from "../src/config.js";
const str = { type: "string" },
  uuid = { type: "string", format: "uuid" };
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
const json = (schema: unknown) => ({ "application/json": { schema } });
const receipt = { hostId: str, attemptId: uuid, fence: uuid };
const schemas: Record<string, unknown> = {
  ChatRequest: z.toJSONSchema(chatRequestSchema, { io: "input" }),
  ChatCompletion: object(
    {
      id: str,
      object: { const: "chat.completion" },
      created: { type: "integer" },
      model: str,
      choices: {
        type: "array",
        items: object({
          index: { type: "integer" },
          message: {
            type: "object",
            properties: {
              role: { const: "assistant" },
              content: { type: ["string", "null"] },
              tool_calls: { type: "array", items: { type: "object" } },
            },
          },
          finish_reason: { enum: ["stop", "tool_calls"] },
        }),
      },
      usage: ref("Usage"),
    },
    ["id", "object", "created", "model", "choices"],
  ),
  Usage: object({
    prompt_tokens: { type: "integer" },
    completion_tokens: { type: "integer" },
    total_tokens: { type: "integer" },
  }),
  Models: object({
    object: { const: "list" },
    data: {
      type: "array",
      items: object({
        id: str,
        object: { const: "model" },
        created: { type: "integer" },
        owned_by: str,
      }),
    },
  }),
  Template: z.toJSONSchema(templateSchema),
  Job: {
    type: "object",
    required: ["id", "prompt", "profile", "mode", "status", "messages"],
    properties: {
      id: uuid,
      prompt: str,
      profile: str,
      mode: { enum: ["cli", "channel"] },
      status: {
        enum: [
          "queued",
          "running",
          "pause_requested",
          "paused",
          "cancel_requested",
          "succeeded",
          "failed",
          "canceled",
          "interrupted",
          "timed_out",
        ],
      },
      sessionId: uuid,
      result: str,
      completion: ref("ChatRequest"),
      usage: ref("Usage"),
      error: str,
      retryAt: {
        type: "integer",
        description: "Provider retry time in Unix milliseconds",
      },
      messages: { type: "array", items: { type: "object" } },
      pendingMessages: { type: "array", items: { type: "object" } },
      compactions: { type: "integer" },
      subagents: { type: "object" },
    },
  },
  ToolObservation: object(
    {
      id: { type: "integer" },
      jobId: uuid,
      attemptId: uuid,
      toolId: str,
      name: str,
      sessionId: str,
      parentToolUseId: str,
      status: { enum: ["requested", "succeeded", "failed", "unknown"] },
      requestedAt: str,
      completedAt: str,
      durationMs: { type: "number" },
      file: object({
        path: str,
        operation: { enum: ["read", "write", "edit"] },
      }),
      input: {},
      output: {},
    },
    ["id", "jobId", "attemptId", "toolId", "status"],
  ),
  AuditEntry: object(
    {
      id: { type: "integer" },
      jobId: uuid,
      attemptId: uuid,
      sessionId: str,
      type: str,
      source: { enum: ["claude", "bridge", "client"] },
      createdAt: str,
      data: { type: "object", additionalProperties: true },
    },
    ["id", "jobId", "type", "source", "createdAt", "data"],
  ),
  AuditPage: object({
    entries: { type: "array", items: ref("AuditEntry") },
    through: { type: "integer" },
    nextCursor: { type: ["integer", "null"] },
    summary: object({
      tools: { type: "integer" },
      files: { type: "integer" },
      changedFiles: { type: "integer" },
      failedTools: { type: "integer" },
      unknownTools: { type: "integer" },
      events: { type: "integer" },
      coverage: {
        enum: ["native_tools", "client_functions", "host_lifecycle"],
      },
    }),
  }),
  ToolPage: object({
    tools: { type: "array", items: ref("ToolObservation") },
    nextCursor: { type: ["integer", "null"] },
  }),
  Error: object({
    error: object(
      {
        code: str,
        message: str,
        type: str,
        param: { type: "null" },
        requestId: str,
        job_id: uuid,
      },
      ["code", "message", "type", "param"],
    ),
  }),
};
const paths: Record<string, Record<string, unknown>> = {};
for (const match of (
  readFileSync("src/http.ts", "utf8") + readFileSync("src/openai.ts", "utf8")
).matchAll(/app\.(get|post|put|delete)\(\s*["'](\/v1\/[^"']+)["']/g)) {
  const method = match[1]!,
    path = match[2]!.replace(/:([A-Za-z]+)/g, "{$1}");
  const admin = /\/v1\/bridge\/(admin|hosts|channel)\//.test(path);
  const parameters: unknown[] = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema:
      m[1] === "id"
        ? uuid
        : m[1] === "tool"
          ? { type: "integer", minimum: 1 }
          : str,
  }));
  if (/\/jobs\/\{id\}\/(audit|tools)$/.test(path)) {
    parameters.push(
      {
        name: "after",
        in: "query",
        schema: { type: "integer", minimum: 0, default: 0 },
      },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 200, default: 100 },
      },
    );
    if (path.endsWith("/audit"))
      parameters.push(
        {
          name: "through",
          in: "query",
          schema: { type: "integer", minimum: 0 },
          description:
            "Fix this to the first page's through value for an immutable export.",
        },
        {
          name: "includePayloads",
          in: "query",
          schema: { type: "string", enum: ["true", "false"], default: "false" },
          description:
            "Include complete tool inputs/results. Pages stop around 4 MB, always retaining at least one whole entry.",
        },
      );
    else
      parameters.push({
        name: "filesOnly",
        in: "query",
        schema: { type: "string", enum: ["true", "false"], default: "false" },
      });
  }
  if (path === "/v1/bridge/jobs" && method === "get")
    parameters.push(
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 200, default: 100 },
      },
      { name: "after", in: "query", schema: str },
      {
        name: "order",
        in: "query",
        schema: { type: "string", enum: ["asc", "desc"], default: "asc" },
      },
    );
  if (
    method === "post" &&
    [
      "/v1/chat/completions",
      "/v1/bridge/jobs/{id}/messages",
      "/v1/bridge/workflow-runs",
    ].includes(path)
  )
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      schema: { type: "string", maxLength: 128 },
    });
  if (path === "/v1/bridge/events")
    parameters.push({
      name: "Last-Event-ID",
      in: "header",
      schema: { type: "integer", minimum: 0 },
      description: "Resume after this event; expired cursors return 409.",
    });
  let input: unknown;
  if (method === "post" || method === "put") {
    input = { type: "object", additionalProperties: false };
    if (path === "/v1/chat/completions") input = ref("ChatRequest");
    if (path === "/v1/bridge/jobs/{id}/messages")
      input = object({
        text: { type: "string", minLength: 1, maxLength: 100000 },
      });
    if (path === "/v1/bridge/workflow-runs")
      input = object({
        templateId: str,
        inputs: { type: "object", additionalProperties: str },
      });
    if (path === "/v1/bridge/admin/tokens")
      input = object({
        id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" },
        profiles: { type: "array", minItems: 1, items: str },
        scopes: {
          type: "array",
          minItems: 1,
          items: { enum: ["read", "submit", "control", "workflows"] },
        },
      });
    if (
      path === "/v1/bridge/admin/tokens/revoke" ||
      path.startsWith("/v1/bridge/hosts/")
    )
      input = object({ id: str });
    if (path.startsWith("/v1/bridge/admin/templates/")) input = ref("Template");
    if (path === "/v1/bridge/channel/claim")
      input = object({ hostId: str, jobId: uuid });
    if (path === "/v1/bridge/channel/progress")
      input = object({
        ...receipt,
        text: { type: "string", maxLength: 16000 },
      });
    if (path === "/v1/bridge/channel/complete")
      input = object({
        ...receipt,
        result: { type: "string", maxLength: 100000 },
      });
    if (path === "/v1/bridge/channel/stopped") input = object(receipt);
  }
  const scope = admin
    ? "owner"
    : method === "get"
      ? "read"
      : path === "/v1/bridge/workflow-runs"
        ? "workflows"
        : path === "/v1/chat/completions"
          ? "read + submit"
          : path.endsWith("/messages")
            ? "submit"
            : "control";
  const accepted =
    method === "post" &&
    [
      "/v1/bridge/jobs/{id}/messages",
      "/v1/bridge/jobs/{id}/retry",
      "/v1/bridge/workflow-runs",
    ].includes(path);
  const responseSchema = path.endsWith("/audit")
    ? ref("AuditPage")
    : path.endsWith("/tools")
      ? ref("ToolPage")
      : path.endsWith("/tools/{tool}")
        ? ref("ToolObservation")
        : path === "/v1/bridge/jobs/{id}" ||
            /\/jobs\/\{id\}\/(pause|resume|cancel|retry)$/.test(path)
          ? ref("Job")
          : path === "/v1/models"
            ? ref("Models")
            : path === "/v1/chat/completions"
              ? ref("ChatCompletion")
              : { type: "object" };
  const operation: Record<string, unknown> = {
    operationId:
      method +
      path.replaceAll("/", "_").replaceAll("{", "").replaceAll("}", ""),
    summary: method.toUpperCase() + " " + path,
    description:
      "Requires " +
      scope +
      " authorization. See api.md for lifecycle semantics, errors, and response fields.",
    tags: [
      path === "/v1/chat/completions" || path === "/v1/models"
        ? "OpenAI compatibility"
        : admin
          ? "Administration"
          : path.includes("workflow")
            ? "Workflows"
            : path.includes("events")
              ? "Events"
              : "Jobs",
    ],
    "x-required-scope": scope,
    parameters,
    responses: {
      [accepted ? "202" : "200"]: {
        description: accepted
          ? "Accepted for asynchronous execution"
          : "Successful response",
        content:
          path === "/v1/bridge/events"
            ? { "text/event-stream": { schema: { type: "string" } } }
            : json(responseSchema),
      },
      default: {
        description: "Rejected request; error.code identifies the reason.",
        content: json(ref("Error")),
      },
    },
  };
  if (path === "/v1/chat/completions") {
    const responses = operation.responses as Record<string, unknown>;
    const headers = {
      "X-Bridge-Job-Id": {
        description: "Durable job ID for console and recovery",
        schema: uuid,
      },
    };
    responses["200"] = {
      description:
        "Validated completion JSON or buffered OpenAI SSE. Keepalive comments precede the final chunks; data: [DONE] ends the stream.",
      headers,
      content: {
        ...json(ref("ChatCompletion")),
        "text/event-stream": { schema: { type: "string" } },
      },
    };
    responses["202"] = {
      description: "bridge.background=true: durable job receipt",
      headers,
      content: json(ref("Job")),
    };
    responses["429"] = {
      description:
        "Admission bound or subscription limit. A paused admitted job is retained.",
      headers: {
        "Retry-After": {
          schema: { type: "integer" },
          description: "Seconds until a known provider reset",
        },
      },
      content: json(ref("Error")),
    };
  }
  if (path.endsWith("/result"))
    (operation.responses as Record<string, unknown>)["202"] = {
      description: "Job is not terminal yet.",
      content: json({ type: "object" }),
    };
  if (input) operation.requestBody = { required: true, content: json(input) };
  (paths[path] ??= {})[method] = operation;
}
const spec = {
  openapi: "3.1.0",
  info: {
    title: "Signature Agent Bridge API",
    version: JSON.parse(readFileSync("package.json", "utf8")).version,
    description:
      "OpenAI-compatible Chat Completions and unified /v1/bridge orchestration extensions. Copyright 2026 Signature Management Consultants SLU. Author @ancongui.",
    license: { name: "Apache-2.0", identifier: "Apache-2.0" },
  },
  servers: [{ url: "http://127.0.0.1:8766" }],
  security: [{ bearerAuth: [] }],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "sab_ token",
      },
    },
    schemas,
  },
};
writeFileSync("docs/openapi.json", JSON.stringify(spec, null, 2) + "\n");
