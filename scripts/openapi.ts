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
import { jobInputSchema } from "../src/contracts.js";
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
  JobInput: z.toJSONSchema(jobInputSchema),
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
  Error: object({ error: object({ code: str, message: str, requestId: str }) }),
};
const paths: Record<string, Record<string, unknown>> = {};
for (const match of readFileSync("src/http.ts", "utf8").matchAll(
  /app\.(get|post|put|delete)\(\s*["'](\/v1\/[^"']+)["']/g,
)) {
  const method = match[1]!,
    path = match[2]!.replace(/:([A-Za-z]+)/g, "{$1}");
  const admin = /\/v1\/(admin|hosts|channel)\//.test(path);
  const parameters: unknown[] = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: m[1] === "id" ? uuid : str,
  }));
  if (path === "/v1/jobs" && method === "get")
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
    ["/v1/jobs", "/v1/jobs/{id}/messages", "/v1/workflow-runs"].includes(path)
  )
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      schema: { type: "string", maxLength: 128 },
    });
  if (path === "/v1/events")
    parameters.push({
      name: "Last-Event-ID",
      in: "header",
      schema: { type: "integer", minimum: 0 },
      description: "Resume after this event; expired cursors return 409.",
    });
  let input: unknown;
  if (method === "post" || method === "put") {
    input = { type: "object", additionalProperties: false };
    if (path === "/v1/jobs") input = ref("JobInput");
    if (path === "/v1/jobs/{id}/messages")
      input = object({
        text: { type: "string", minLength: 1, maxLength: 100000 },
      });
    if (path === "/v1/workflow-runs")
      input = object({
        templateId: str,
        inputs: { type: "object", additionalProperties: str },
      });
    if (path === "/v1/admin/tokens")
      input = object({
        id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" },
        profiles: { type: "array", minItems: 1, items: str },
        scopes: {
          type: "array",
          minItems: 1,
          items: { enum: ["read", "submit", "control", "workflows"] },
        },
      });
    if (path === "/v1/admin/tokens/revoke" || path.startsWith("/v1/hosts/"))
      input = object({ id: str });
    if (path.startsWith("/v1/admin/templates/")) input = ref("Template");
    if (path === "/v1/channel/claim")
      input = object({ hostId: str, jobId: uuid });
    if (path === "/v1/channel/progress")
      input = object({
        ...receipt,
        text: { type: "string", maxLength: 16000 },
      });
    if (path === "/v1/channel/complete")
      input = object({
        ...receipt,
        result: { type: "string", maxLength: 100000 },
      });
    if (path === "/v1/channel/stopped") input = object(receipt);
  }
  const scope = admin
    ? "owner"
    : method === "get"
      ? "read"
      : path === "/v1/workflow-runs"
        ? "workflows"
        : path === "/v1/jobs" || path.endsWith("/messages")
          ? "submit"
          : "control";
  const accepted =
    method === "post" &&
    [
      "/v1/jobs",
      "/v1/jobs/{id}/messages",
      "/v1/jobs/{id}/retry",
      "/v1/workflow-runs",
    ].includes(path);
  const responseSchema =
    path === "/v1/jobs/{id}" ||
    (path === "/v1/jobs" && method === "post") ||
    /\/jobs\/\{id\}\/(pause|resume|cancel|retry)$/.test(path)
      ? ref("Job")
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
      admin
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
          path === "/v1/events"
            ? { "text/event-stream": { schema: { type: "string" } } }
            : json(responseSchema),
      },
      default: {
        description: "Rejected request; error.code identifies the reason.",
        content: json(ref("Error")),
      },
    },
  };
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
      "Authenticated local orchestration with REST commands and durable SSE notifications. Copyright 2026 Signature Management Consultants SLU. Author @ancongui.",
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
