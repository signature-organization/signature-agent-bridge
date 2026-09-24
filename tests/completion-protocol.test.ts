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
import {
  prepareCompletion,
  parseCompletionResult,
} from "../src/completion-protocol.js";
const base = {
  model: "bridge/default",
  messages: [{ role: "user", content: "Hello" }],
};
const tool = {
  type: "function",
  function: {
    name: "add",
    parameters: {
      type: "object",
      properties: { a: { type: "integer" } },
      required: ["a"],
      additionalProperties: false,
    },
  },
};
it("preserves roles and quoted content without shell interpolation", () => {
  const p = prepareCompletion({
    ...base,
    messages: [{ role: "system", content: "Be concise" }, ...base.messages],
  });
  expect(p.prompt).toContain('"role":"system"');
  expect(p.request.model).toBe("bridge/default");
  expect(
    parseCompletionResult(
      JSON.stringify({ content: "Hello", tool_calls: [] }),
      p.request,
    ).content,
  ).toBe("Hello");
});
it("validates client-side tool arguments and forced tool choices", () => {
  const p = prepareCompletion({
    ...base,
    tools: [tool],
    tool_choice: "required",
  });
  expect(
    parseCompletionResult(
      JSON.stringify({
        content: null,
        tool_calls: [{ name: "add", arguments: '{"a":2}' }],
      }),
      p.request,
    ).toolCalls,
  ).toHaveLength(1);
  for (const output of [
    { content: "skip", tool_calls: [] },
    {
      content: null,
      tool_calls: [{ name: "add", arguments: '{"a":"wrong"}' }],
    },
    { content: null, tool_calls: [{ name: "unknown", arguments: "{}" }] },
  ])
    expect(() =>
      parseCompletionResult(JSON.stringify(output), p.request),
    ).toThrow();
  expect(() =>
    prepareCompletion({
      ...base,
      tools: [tool],
      tool_choice: { type: "function", function: { name: "missing" } },
    }),
  ).toThrow();
});
it("accepts complete tool round trips and rejects orphan or missing tool results", () => {
  const call = {
    id: "call_1",
    type: "function",
    function: { name: "add", arguments: '{"a":2}' },
  };
  const messages = [
    ...base.messages,
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: "call_1", content: "3" },
  ];
  expect(
    prepareCompletion({ ...base, messages, tools: [tool] }).request.messages,
  ).toHaveLength(3);
  expect(() =>
    prepareCompletion({ ...base, messages: messages.slice(0, 2) }),
  ).toThrow();
  expect(() =>
    prepareCompletion({
      ...base,
      messages: [{ role: "tool", tool_call_id: "other", content: "3" }],
    }),
  ).toThrow();
});
it("validates JSON output and nested local-reference schemas", () => {
  const response_format = {
    type: "json_schema",
    json_schema: {
      name: "Answer",
      strict: true,
      schema: {
        type: "object",
        properties: { answer: { $ref: "#/$defs/count" } },
        required: ["answer"],
        $defs: { count: { type: "integer" } },
      },
    },
  };
  const p = prepareCompletion({ ...base, response_format });
  expect(
    parseCompletionResult(
      JSON.stringify({ content: '{"answer":7}', tool_calls: [] }),
      p.request,
    ).content,
  ).toBe('{"answer":7}');
  expect(() =>
    parseCompletionResult(
      JSON.stringify({ content: '{"answer":"wrong"}', tool_calls: [] }),
      p.request,
    ),
  ).toThrow();
  expect(() => parseCompletionResult("not json", p.request)).toThrow();
});
it("rejects unsupported options, media, remote schemas and expensive regex schemas before admission", () => {
  for (const value of [
    { ...base, temperature: 0.5 },
    { ...base, max_tokens: 100 },
    { ...base, n: 2 },
    {
      ...base,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "https://example.com" } },
          ],
        },
      ],
    },
    {
      ...base,
      tools: [
        {
          ...tool,
          function: {
            ...tool.function,
            parameters: { $ref: "https://example.com/schema" },
          },
        },
      ],
    },
    {
      ...base,
      tools: [
        {
          ...tool,
          function: {
            ...tool.function,
            parameters: { type: "string", pattern: "(a+)+" },
          },
        },
      ],
    },
  ])
    expect(() => prepareCompletion(value)).toThrow();
});
it("rejects no-tool and parallel-tool violations without fabricating an answer", () => {
  const output = JSON.stringify({
    content: null,
    tool_calls: [
      { name: "add", arguments: '{"a":2}' },
      { name: "add", arguments: '{"a":3}' },
    ],
  });
  expect(() =>
    parseCompletionResult(
      output,
      prepareCompletion({ ...base, tools: [tool], parallel_tool_calls: false })
        .request,
    ),
  ).toThrow();
  expect(() =>
    parseCompletionResult(
      output,
      prepareCompletion({ ...base, tools: [tool], tool_choice: "none" })
        .request,
    ),
  ).toThrow();
  expect(() =>
    parseCompletionResult(
      '{"content":null,"tool_calls":[]}',
      prepareCompletion(base).request,
    ),
  ).toThrow();
});
