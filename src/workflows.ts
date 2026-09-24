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
import { z } from "zod";
import {
  BridgeError,
  terminal,
  type Job,
  type Principal,
} from "./contracts.js";
import { templateSchema, type WorkflowTemplate } from "./config.js";
import { QueueStore } from "./store.js";
export type WorkflowRun = {
  id: string;
  principal: Principal;
  template: WorkflowTemplate;
  inputs: Record<string, string>;
  jobIds: string[];
  status: string;
  cancelRequested: boolean;
  pauseRequested?: boolean;
  blocked?: boolean;
  createdAt: string;
};
const inputsSchema = z.record(z.string(), z.string().max(100000));
export class Workflows {
  readonly templates: WorkflowTemplate[];
  constructor(
    private store: QueueStore,
    templates: unknown[],
  ) {
    this.templates = templates.map((t) => templateSchema.parse(t));
    const ids = new Set<string>();
    for (const t of this.templates) {
      if (ids.has(t.id) || new Set(t.inputs).size !== t.inputs.length)
        throw new Error("Duplicate workflow or input identifier");
      ids.add(t.id);
      const previous = new Set<string>();
      for (const step of t.steps) {
        if (previous.has(step.id)) throw new Error("Duplicate workflow step");
        for (const match of step.prompt.matchAll(/\{\{([^}]+)\}\}/g)) {
          const ref = match[1]!;
          const valid = ref.startsWith("input.")
            ? t.inputs.includes(ref.slice(6))
            : ref.startsWith("steps.") && previous.has(ref.slice(6));
          if (!valid) throw new Error("Invalid workflow reference: " + ref);
        }
        previous.add(step.id);
      }
    }
  }
  private save(run: WorkflowRun): void {
    this.store.db
      .prepare("INSERT OR REPLACE INTO workflows VALUES(?,?,?)")
      .run(run.id, run.principal.id, JSON.stringify(run));
  }
  replaceTemplates(templates: unknown[]): void {
    const validated = new Workflows(this.store, templates).templates;
    // Existing runs retain their snapshots; edits only affect newly started runs.
    this.templates.splice(0, this.templates.length, ...validated);
  }
  get(id: string, p: Principal): WorkflowRun {
    const row = this.store.db
      .prepare("SELECT data FROM workflows WHERE id=?")
      .get(id) as { data: string } | undefined;
    const run = row ? (JSON.parse(row.data) as WorkflowRun) : null;
    if (!run || (!p.owner && run.principal.id !== p.id))
      throw new BridgeError("not_found", "Workflow not found", 404);
    return run;
  }
  list(p: Principal): WorkflowRun[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM workflows WHERE (?=1 OR principal_id=?) ORDER BY rowid DESC LIMIT 200",
        )
        .all(p.owner ? 1 : 0, p.id) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as WorkflowRun);
  }
  start(
    templateId: string,
    raw: Record<string, string>,
    p: Principal,
    key?: string,
  ): WorkflowRun {
    const inputs = inputsSchema.parse(raw);
    const sorted = Object.fromEntries(
      Object.keys(inputs)
        .sort()
        .map((k) => [k, inputs[k]]),
    );
    return this.store.idempotent(
      p,
      "workflow-runs",
      key,
      { templateId, inputs: sorted },
      () => {
        const template = this.templates.find((t) => t.id === templateId);
        if (!template)
          throw new BridgeError(
            "not_found",
            "Workflow template not found",
            404,
          );
        if (
          Object.keys(inputs).length !== template.inputs.length ||
          template.inputs.some((k) => !Object.hasOwn(inputs, k))
        )
          throw new BridgeError(
            "invalid_inputs",
            "Workflow inputs must match the template",
          );
        if (
          !p.owner &&
          template.steps.some((s) => !p.profiles.includes(s.profile))
        )
          throw new BridgeError(
            "profile_forbidden",
            "Workflow profile unavailable",
            403,
          );
        const run: WorkflowRun = {
          id: randomUUID(),
          principal: p,
          template: structuredClone(template),
          inputs,
          jobIds: [],
          status: "running",
          cancelRequested: false,
          createdAt: new Date().toISOString(),
        };
        this.createStep(run, 0);
        this.save(run);
        return run;
      },
      (id) => this.get(id, p),
    );
  }
  private createStep(run: WorkflowRun, index: number): void {
    const step = run.template.steps[index]!;
    const prompt = step.prompt.replace(
      /\{\{([^}]+)\}\}/g,
      (_all: string, ref: string) => {
        if (ref.startsWith("input.")) return run.inputs[ref.slice(6)]!;
        const i = run.template.steps.findIndex((s) => s.id === ref.slice(6));
        return this.store.get(run.jobIds[i]!).result ?? "";
      },
    );
    const job = this.store.submit(
      { prompt, profile: step.profile, mode: "cli" },
      run.principal,
    );
    this.store.linkWorkflow(job.id, run.id, step.id);
    run.jobIds.push(job.id);
  }
  advance(): void {
    this.store.atomic(() => {
      const rows = this.store.db
        .prepare("SELECT data FROM workflows")
        .all() as { data: string }[];
      for (const row of rows) {
        const run = JSON.parse(row.data) as WorkflowRun;
        if (
          run.status === "succeeded" ||
          run.cancelRequested ||
          run.pauseRequested ||
          run.blocked
        )
          continue;
        const job = this.store.get(run.jobIds.at(-1)!);
        if (job.status === "succeeded") {
          if (run.jobIds.length === run.template.steps.length)
            run.status = "succeeded";
          else {
            try {
              this.createStep(run, run.jobIds.length);
              run.status = "running";
            } catch (error) {
              run.status = "failed";
              run.blocked = true;
              this.store.addEvent(job, "workflow.failed", {
                runId: run.id,
                error:
                  error instanceof Error
                    ? error.message
                    : "Step validation failed",
              });
            }
          }
        } else
          run.status =
            terminal.has(job.status) ||
            job.status === "paused" ||
            job.status === "pause_requested"
              ? job.status
              : "running";
        this.save(run);
      }
    });
  }
  retryJob(id: string, p: Principal): Job {
    return this.store.atomic(() => {
      const job = this.store.get(id, p);
      if (job.workflowRunId) {
        const run = this.get(job.workflowRunId, p);
        if (run.pauseRequested)
          throw new BridgeError(
            "workflow_paused",
            "Resume the paused workflow before retrying its step",
            409,
          );
        if (run.cancelRequested || run.jobIds.at(-1) !== id)
          throw new BridgeError(
            "invalid_retry",
            "Only the current failed workflow step can retry",
            409,
          );
        run.status = "running";
        this.save(run);
      }
      return this.store.retry(id, p);
    });
  }
  pause(id: string, p: Principal): WorkflowRun {
    return this.store.atomic(() => {
      const run = this.get(id, p);
      if (run.cancelRequested || run.status === "succeeded") return run;
      run.pauseRequested = true;
      run.status = "paused";
      this.store.pause(run.jobIds.at(-1)!, p);
      this.save(run);
      return run;
    });
  }
  resume(id: string, p: Principal): WorkflowRun {
    return this.store.atomic(() => {
      const run = this.get(id, p);
      if (run.cancelRequested)
        throw new BridgeError(
          "invalid_resume",
          "Canceled workflows cannot resume",
          409,
        );
      const job = this.store.get(run.jobIds.at(-1)!);
      if (job.status === "pause_requested")
        throw new BridgeError(
          "pause_pending",
          "Wait for the active attempt to stop",
          409,
        );
      if (job.status === "paused") this.store.resume(job.id, p);
      run.pauseRequested = false;
      run.blocked = false;
      run.status = "running";
      this.save(run);
      return run;
    });
  }
  cancel(id: string, p: Principal): WorkflowRun {
    return this.store.atomic(() => {
      const run = this.get(id, p);
      if (run.status === "succeeded") return run;
      run.cancelRequested = true;
      run.status = "canceled";
      for (const jobId of run.jobIds) this.store.cancel(jobId, p);
      this.save(run);
      return run;
    });
  }
}
