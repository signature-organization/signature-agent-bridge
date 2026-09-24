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

import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startService } from "../../src/service.js";
import { parseConfig } from "../../src/config.js";
let service: Awaited<ReturnType<typeof startService>>, directory: string;
const owner = { id: "owner", owner: true, profiles: ["default"] };
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "bridge-dashboard-"));
  service = await startService(
    parseConfig({
      dataDir: directory,
      workspace: join(directory, "jobs"),
      claudePath: process.execPath,
      port: 0,
      workflows: [
        {
          id: "research-and-review",
          inputs: ["topic"],
          steps: [
            { id: "research", prompt: "Research {{input.topic}}" },
            { id: "review", prompt: "Review {{steps.research}}" },
          ],
        },
      ],
    }),
    {
      worker: () => ({
        ready: async () => ({ ready: true }),
        run: async ({ job }, emit) => {
          emit({ kind: "output", text: "Working on your request" });
          if (job.completion)
            return {
              status: "succeeded",
              result: JSON.stringify({
                content:
                  "Your bridge is ready for OpenAI-compatible applications.",
                tool_calls: [],
              }),
              usage: {
                prompt_tokens: 12,
                completion_tokens: 8,
                total_tokens: 20,
              },
            };
          return {
            status: "succeeded",
            result:
              "Completed: " +
              job.messages.filter((m) => m.role === "user").at(-1)!.text,
          };
        },
      }),
    },
  );
  const first = service.store.submit(
    { prompt: "Prepare the weekly operations summary" },
    owner,
  );
  const attempt = service.store.claim("fixture", "cli", first.id)!;
  for (const tool of [
    {
      toolId: "read-notes",
      name: "Read",
      phase: "requested" as const,
      file: { path: "notes/operations.md", operation: "read" as const },
      input: { file_path: "notes/operations.md" },
    },
    {
      toolId: "read-notes",
      phase: "succeeded" as const,
      output: {
        content:
          "# Operations\nLaunch checklist: pending\nOwner: Platform team",
      },
    },
    {
      toolId: "edit-notes",
      name: "Edit",
      phase: "requested" as const,
      file: { path: "notes/operations.md", operation: "edit" as const },
      input: {
        file_path: "notes/operations.md",
        old_string: "Launch checklist: pending",
        new_string: "Launch checklist: ready for review",
      },
    },
    {
      toolId: "edit-notes",
      phase: "succeeded" as const,
      output: { content: "The file has been updated successfully." },
    },
    {
      toolId: "check-tests",
      name: "Bash",
      phase: "requested" as const,
      input: {
        command: "npm run test:integration",
        description: "Check the integration suite",
      },
    },
    {
      toolId: "check-tests",
      phase: "succeeded" as const,
      output: {
        content: "12 tests passed",
        result: {
          stdout:
            "PASS tests/integration/bridge.test.ts\nTests: 12 passed, 12 total\nTime: 1.84 s",
          stderr: "",
          interrupted: false,
        },
      },
    },
  ])
    service.store.observe(attempt, {
      kind: "tool",
      text: "Tool activity observed",
      tool,
    });
  service.store.observe(attempt, {
    kind: "compaction",
    text: "Conversation compacted",
    data: { trigger: "auto", pre_tokens: 124000 },
  });
  service.store.observe(attempt, {
    kind: "subagent",
    text: "Review complete",
    data: {
      taskId: "reviewer",
      status: "completed",
      description: "Check findings against source notes",
    },
  });
  service.store.finish(attempt, {
    status: "succeeded",
    result:
      "The operations summary is ready. Three priorities need attention: review the onboarding queue, confirm the launch checklist, and close the remaining documentation gaps.",
    sessionId: "11111111-1111-4111-8111-111111111111",
  });
  const second = service.store.submit(
    { prompt: "Review the integration test results" },
    owner,
  );
  service.store.pause(second.id, owner);
  service.store.submit(
    {
      prompt: "Await a design review in the current conversation",
      mode: "channel",
    },
    owner,
  );
});
test.afterAll(async () => {
  await service.close();
  rmSync(directory, { recursive: true, force: true });
});
async function login(page: import("@playwright/test").Page) {
  await page.goto(service.address);
  await page
    .getByLabel("Bridge token", { exact: true })
    .fill(service.ownerToken);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#stream-state")).toContainText("Live");
}
async function capture(page: import("@playwright/test").Page, name: string) {
  if (process.env.UPDATE_SCREENSHOTS === "1") {
    mkdirSync("assets/screenshots", { recursive: true });
    const original = page.viewportSize()!;
    if (!(await page.locator("dialog[open]").count()))
      await page.setViewportSize({
        width: original.width,
        height: Math.max(
          original.height,
          await page.evaluate(() => document.documentElement.scrollHeight),
        ),
      });
    if (await page.locator("#template-dialog[open]").count()) {
      if (original.width > 640) {
        const contentHeight = await page
          .locator("#template-dialog")
          .evaluate((n) => n.scrollHeight);
        await page.setViewportSize({
          width: original.width,
          height: Math.max(
            original.height,
            Math.ceil(contentHeight / 0.9) + 80,
          ),
        });
      }
      await page.locator("#template-dialog").evaluate((n) => {
        n.scrollTop = 0;
        (document.activeElement as HTMLElement)?.blur();
      });
    }
    await page.screenshot({
      path: "assets/screenshots/" + name + ".png",
      fullPage: (await page.locator("dialog[open]").count()) === 0,
    });
    await page.setViewportSize(original);
  }
}
test("desktop renders branded state, safely displays output, and supports bidirectional follow-up", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(service.address);
  await capture(page, "connect-desktop");
  await login(page);
  await page
    .getByRole("button", {
      name: "Prepare the weekly operations summary",
      exact: true,
    })
    .click();
  await expect(page.locator("#job-meta")).toContainText("1 compactions");
  await expect(page.locator("#subagents")).toContainText("completed");
  await capture(page, "dashboard-desktop");
  await page
    .getByLabel("Continue this conversation")
    .fill("Summarize the next action <img src=x onerror=alert(1)>");
  await page
    .getByRole("button", { name: "Send follow-up", exact: true })
    .click();
  await expect(page.locator("#messages")).toContainText(
    "Completed: Summarize the next action",
  );
  expect(await page.locator("#messages img").count()).toBe(0);
  await page.locator('[data-view="diagnostics"]').click();
  await expect(page.locator("#diagnostics")).toContainText("bypassPermissions");
  await expect(page.locator("#tokens")).toContainText("owner");
  await capture(page, "diagnostics-desktop");
  expect(errors).toEqual([]);
});
test("activity and files expose full tool payloads, diffs, audit export, and responsive keyboard tabs", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("button", {
      name: "Prepare the weekly operations summary",
      exact: true,
    })
    .click();
  await page.getByRole("tab", { name: "Activity", exact: false }).click();
  await expect(page.locator("#audit-summary")).toContainText("3 tool calls");
  await page
    .locator("#tool-list .tool-card")
    .filter({ hasText: "Bash" })
    .locator("summary")
    .first()
    .click();
  await expect(page.locator("#tool-list")).toContainText(
    "npm run test:integration",
  );
  await expect(page.locator("#tool-list")).toContainText("12 passed, 12 total");
  await capture(page, "activity-desktop");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Activity", exact: false }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#tool-list details[open]")).toHaveCount(1);
  await page.getByRole("tab", { name: "Activity", exact: false }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Files", exact: false }),
  ).toHaveAttribute("aria-selected", "true");
  await page
    .locator("#file-list .tool-card")
    .filter({ hasText: "Edit" })
    .locator("summary")
    .first()
    .click();
  await expect(page.locator("#file-list")).toContainText(
    "Launch checklist: pending",
  );
  await expect(page.locator("#file-list")).toContainText(
    "Launch checklist: ready for review",
  );
  await capture(page, "files-desktop");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export audit", exact: true }).click();
  const saved = await download;
  const data = JSON.parse(
    await (
      await import("node:fs/promises")
    ).readFile((await saved.path())!, "utf8"),
  );
  expect(
    data.entries.some(
      (e: { data: { input?: { command?: string } } }) =>
        e.data.input?.command === "npm run test:integration",
    ),
  ).toBe(true);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const tab of ["Activity", "Files"]) {
      await page.getByRole("tab", { name: tab, exact: false }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (width === 390) await capture(page, tab.toLowerCase() + "-mobile");
    }
  }
});
test("mobile has no horizontal overflow and exposes job and workflow controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page
    .getByRole("button", {
      name: "Review the integration test results",
      exact: true,
    })
    .click();
  await expect(page.locator("#detail-state")).toContainText("paused");
  await capture(page, "dashboard-mobile");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .locator("#job-actions")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await expect(page.locator("#detail-state")).toContainText("succeeded");
  await page.locator('[data-view="workflows"]').click();
  await page
    .getByLabel("Inputs (JSON object)")
    .fill('{"topic":"local orchestration"}');
  await page
    .getByRole("button", { name: "Start workflow", exact: true })
    .click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#workflow-runs")).toContainText("succeeded", {
    timeout: 15000,
  });
  await capture(page, "workflows-mobile");
});
test("owner can create and revoke a scoped application token", async ({
  page,
}) => {
  await login(page);
  await page.locator('[data-view="diagnostics"]').click();
  await page.getByLabel("Client name").fill("test-client");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await expect(page.locator("#new-token")).toContainText("sab_");
  const token = await page.locator("#new-token").innerText();
  expect(
    (
      await fetch(service.address + "/v1/bridge/status", {
        headers: { Authorization: "Bearer " + token },
      })
    ).status,
  ).toBe(200);
  await page
    .locator(".token-row")
    .filter({ hasText: "test-client" })
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(page.locator("#tokens")).toContainText("test-client (revoked)");
  expect(
    (
      await fetch(service.address + "/v1/bridge/status", {
        headers: { Authorization: "Bearer " + token },
      })
    ).status,
  ).toBe(401);
});
test("all console views render across the layout breakpoints and the new-job dialog executes work", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "New job", exact: false }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByLabel("What should Claude work on?")
    .fill("Verify the installation checklist");
  await capture(page, "new-job-desktop");
  await page.getByRole("button", { name: "Queue job", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator("#messages")).toContainText(
    "Completed: Verify the installation checklist",
  );
  await page.locator('[data-view="workflows"]').click();
  await expect(page.locator("#workflow-runs")).toContainText(
    "research-and-review",
  );
  await capture(page, "workflows-desktop");
  await page
    .getByRole("button", { name: "Open step 1", exact: true })
    .first()
    .click();
  await expect(page.locator("#jobs-view")).toBeVisible();
  await expect(page.locator("#messages")).toContainText(
    "Research local orchestration",
  );
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    for (const view of ["jobs", "workflows", "diagnostics"]) {
      await page.locator('[data-view="' + view + '"]').click();
      await expect(page.locator("#" + view + "-view")).toBeVisible();
      const overflow = await page.evaluate(() =>
        [...document.querySelectorAll("*")]
          .filter(
            (n) =>
              n.getBoundingClientRect().right > innerWidth + 1 &&
              getComputedStyle(n).display !== "none",
          )
          .map((n) => n.tagName + "#" + n.id + "." + n.className),
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        width + " / " + view + " / " + overflow.join(", "),
      ).toBe(true);
      expect(
        Math.round(
          await page
            .locator("footer")
            .evaluate((n) => n.getBoundingClientRect().bottom),
        ),
      ).toBe(960);
      if (width === 768) await capture(page, view + "-tablet");
      if (width === 320 && view === "diagnostics")
        await capture(page, "diagnostics-mobile");
    }
  }
});
test("template editor validates references, saves reusable steps, and runs the new definition", async ({
  page,
}) => {
  await login(page);
  await page.locator('[data-view="workflows"]').click();
  await page.getByRole("button", { name: "New template", exact: true }).click();
  await page.getByLabel("Template ID", { exact: true }).fill("draft-and-check");
  await page
    .getByLabel("Purpose", { exact: true })
    .fill("Draft a response and check it against the requested topic.");
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  const second = page.locator(".step-editor").nth(1);
  await second.getByLabel("Step ID", { exact: true }).fill("review");
  await second
    .getByLabel("Step instructions", { exact: true })
    .fill("Review {{steps.missing}}");
  await page
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await expect(page.locator("#template-error")).toContainText(
    "Invalid workflow reference",
  );
  await second
    .getByLabel("Step instructions", { exact: true })
    .fill("Review {{steps.research}} for accuracy.");
  await capture(page, "template-editor-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, "template-editor-mobile");
  await page
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await expect(page.locator("#template-dialog")).not.toBeVisible();
  await expect(page.locator("#templates-list")).toContainText(
    "draft-and-check",
  );
  await page.locator("#template").selectOption("draft-and-check");
  await page
    .getByLabel("Inputs (JSON object)")
    .fill('{"topic":"template validation"}');
  await page
    .getByRole("button", { name: "Start workflow", exact: true })
    .click();
  await expect(
    page.locator(".run").filter({ hasText: "draft-and-check" }),
  ).toContainText("succeeded", { timeout: 15000 });
});

test("completion jobs share the queue, show readable output and usage, and expose client connection details", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "New job", exact: false }).click();
  await page
    .getByLabel("What should Claude work on?")
    .fill("Confirm the bridge is ready for my application");
  await page.locator("#mode").selectOption("inference");
  const submission = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/v1/chat/completions"),
  );
  await page.getByRole("button", { name: "Queue job", exact: true }).click();
  expect((await submission).postDataJSON().bridge).toEqual({
    execution: "inference",
    background: true,
  });
  await expect(page.locator("#messages")).toContainText("Your bridge is ready");
  await expect(page.locator("#messages")).not.toContainText('"tool_calls"');
  await expect(page.locator("#job-meta")).toContainText("20 tokens");
  await expect(page.locator("#message-form")).toBeHidden();
  await capture(page, "completion-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "completion-mobile");
  await page.locator('[data-view="diagnostics"]').click();
  await expect(page.locator("#diagnostics-view")).toContainText(
    "bridge/default",
  );
  await expect(page.locator("#diagnostics-view")).toContainText(
    service.address + "/v1",
  );
});

test("keeps recent jobs visible and preserves loaded history across refreshes", async ({
  page,
}) => {
  for (let i = 0; i < 205; i++)
    service.store.submit(
      { prompt: "History entry " + i, mode: "channel" },
      owner,
    );
  await login(page);
  await expect(
    page.getByRole("button", { name: "History entry 204", exact: true }),
  ).toBeVisible();
  await page.locator("#more").click();
  await expect(
    page.getByRole("button", { name: "History entry 0", exact: true }),
  ).toBeAttached();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "History entry 0", exact: true }),
  ).toBeAttached();
  await expect(
    page.getByRole("button", { name: "History entry 204", exact: true }),
  ).toBeAttached();
});

test("audit pagination survives refresh and renders untrusted payloads as text", async ({
  page,
}) => {
  const job = service.store.submit(
      { prompt: "Inspect tool payload safety" },
      owner,
    ),
    attempt = service.store.claim("fixture", "cli", job.id)!;
  for (let index = 0; index < 27; index++) {
    const toolId = "safe-" + index;
    service.store.observe(attempt, {
      kind: "tool",
      text: "tool",
      tool: {
        toolId,
        name: "Write",
        phase: "requested",
        file: { path: `files/item-${index}.txt`, operation: "write" },
        input: {
          file_path: `files/item-${index}.txt`,
          content: '<img src=x onerror="window.auditInjected=true">',
        },
      },
    });
    service.store.observe(attempt, {
      kind: "tool",
      text: "tool",
      tool: { toolId, phase: "succeeded", output: { content: "Written" } },
    });
  }
  service.store.finish(attempt, {
    status: "succeeded",
    result: "Fixture ready",
  });
  let releaseAttempts!: () => void;
  const attemptsGate = new Promise<void>((resolve) => {
    releaseAttempts = resolve;
  });
  await page.route(`**/jobs/${job.id}/attempts`, async (route) => {
    await attemptsGate;
    await route.continue();
  });
  await login(page);
  await page
    .getByRole("button", { name: "Inspect tool payload safety", exact: true })
    .click();
  await page.getByRole("tab", { name: "Files", exact: false }).click();
  releaseAttempts();
  await expect(
    page.getByRole("tab", { name: "Files", exact: false }),
  ).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(async () => ({
      count: await page.locator("#file-list .tool-card").count(),
      notice: await page.locator("#notice").textContent(),
      tab: await page.locator("#tab-files").getAttribute("aria-selected"),
    }))
    .toMatchObject({ count: 25 })
    .catch(async (error) => {
      throw new Error(
        error.message +
          "\nPanel state: " +
          JSON.stringify({
            notice: await page.locator("#notice").textContent(),
            tab: await page.locator("#tab-files").getAttribute("aria-selected"),
          }),
      );
    });
  await page
    .getByRole("button", { name: "Load more file actions", exact: true })
    .click();
  await expect(page.locator("#file-list .tool-card")).toHaveCount(27);
  await page
    .locator("#file-list .tool-card")
    .last()
    .locator("summary")
    .first()
    .click();
  await expect(page.locator("#file-list")).toContainText(
    "window.auditInjected=true",
  );
  expect(await page.locator("#file-list img").count()).toBe(0);
  expect(
    await page.evaluate(() => Object.hasOwn(window, "auditInjected")),
  ).toBe(false);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#file-list .tool-card")).toHaveCount(27);
  await expect(page.locator("#file-list .tool-card[open]")).toHaveCount(1);
});
