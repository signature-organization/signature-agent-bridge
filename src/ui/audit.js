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

const el = (id) => document.getElementById(id);
const node = (tag, value, className) => {
  const result = document.createElement(tag);
  if (value !== undefined) result.textContent = value;
  if (className) result.className = className;
  return result;
};
// Preserve focus, selection, and scroll when a polling refresh contains no changes.
function replaceIfChanged(parent, children) {
  if (
    parent.childNodes.length === children.length &&
    children.every((child, index) => parent.childNodes[index] === child)
  )
    return;
  parent.replaceChildren(...children);
}
const pretty = (value) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
const timestamp = (value) =>
  value
    ? new Date(value).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "Time unavailable";
const state = (value) =>
  ({
    requested: "Awaiting result",
    succeeded: "Reported success",
    failed: "Reported failure",
    unknown: "Outcome unknown",
  })[value] ?? value;
function payload(container, label, value, className = "") {
  if (value === undefined) return;
  const section = node("section", undefined, "payload-section " + className);
  section.append(
    node("h4", label),
    node("pre", value === "" ? "(empty)" : pretty(value)),
  );
  container.append(section);
}
function inspector(container, tool) {
  const input = tool.input ?? {},
    output = tool.output ?? {},
    result = output.result ?? {};
  const info = node(
    "p",
    `${tool.name ?? "Tool"} · ${state(tool.status)} · ${tool.parentToolUseId ? "Subagent" : "Main session"}`,
    "tool-provenance",
  );
  container.append(info);
  if (tool.name === "Bash") {
    payload(container, "Command", input.command, "command-output");
    payload(container, "Standard output", result.stdout);
    payload(container, "Standard error", result.stderr);
  }
  if (tool.name === "Write")
    payload(
      container,
      tool.status === "succeeded" ? "Written content" : "Requested content",
      input.content,
    );
  if (
    tool.name === "Edit" &&
    typeof input.old_string === "string" &&
    typeof input.new_string === "string"
  ) {
    container.append(
      node("h4", "Replacement diff"),
      node(
        "p",
        input.replace_all
          ? "Replace all matching occurrences. These are the exact submitted fragments."
          : "Exact submitted replacement fragments; surrounding file content is not implied.",
        "hint",
      ),
    );
    const diff = node("div", undefined, "diff-grid");
    payload(diff, "− Before", input.old_string, "diff-before");
    payload(diff, "+ After", input.new_string, "diff-after");
    container.append(diff);
  }
  if (result.structuredPatch)
    payload(container, "Patch reported by Claude", result.structuredPatch);
  if (result.originalFile !== undefined)
    payload(container, "Original file reported by Claude", result.originalFile);
  if (result.file?.content !== undefined)
    payload(container, "File content reported by Claude", result.file.content);
  payload(container, "Tool output", output.content);
  if (!tool.completedAt)
    container.append(
      node(
        "p",
        "No terminal tool result was observed. A side effect may still have occurred.",
        "hint",
      ),
    );
  const raw = node("details", undefined, "raw-payload");
  raw.append(node("summary", "Raw input, result, and correlation"));
  payload(raw, "Input", tool.input);
  payload(raw, "Result", tool.output);
  const { input: _input, output: _output, ...metadata } = tool;
  void _input;
  void _output;
  payload(raw, "Observation", metadata);
  container.append(raw);
}
export function createAuditPanel(api, notice) {
  let jobId = "",
    revision = 0,
    tab = "conversation",
    toolPages = 1,
    filePages = 1,
    eventPages = 1;
  const cards = new Map();
  const loadedFor = new Map();
  function showTab(name, focus = false) {
    tab = name;
    for (const button of document.querySelectorAll("[data-job-tab]")) {
      const active = button.dataset.jobTab === name;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    }
    for (const panel of document.querySelectorAll("[data-job-panel]"))
      panel.hidden = panel.dataset.jobPanel !== name;
  }
  for (const button of document.querySelectorAll("[data-job-tab]")) {
    button.onclick = () => {
      showTab(button.dataset.jobTab);
      if (jobId) void select({ id: jobId }).catch((e) => notice(e.message));
    };
    button.onkeydown = (event) => {
      const names = ["conversation", "activity", "files"],
        index = names.indexOf(tab);
      const next =
        event.key === "ArrowRight"
          ? (index + 1) % 3
          : event.key === "ArrowLeft"
            ? (index + 2) % 3
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? 2
                : -1;
      if (next >= 0) {
        event.preventDefault();
        showTab(names[next], true);
        if (jobId) void select({ id: jobId }).catch((e) => notice(e.message));
      }
    };
  }
  function reset() {
    jobId = "";
    revision++;
    toolPages = filePages = eventPages = 1;
    cards.clear();
    loadedFor.clear();
    showTab("conversation");
    for (const id of [
      "tool-list",
      "file-list",
      "audit-entries",
      "audit-summary",
    ])
      el(id).replaceChildren();
  }
  function begin(id) {
    if (jobId === id) return;
    reset();
    jobId = id;
  }
  function toolCard(tool, kind, id) {
    const key = kind + ":" + tool.id,
      signature = JSON.stringify(tool),
      old = cards.get(key);
    if (old?.signature === signature) return old.element;
    const card = node("details", undefined, "tool-card");
    card.open = old?.element.open ?? false;
    const summary = node("summary"),
      icon = node(
        "span",
        kind === "files" ? "↗" : tool.name === "Bash" ? ">_" : "⌘",
        "tool-icon",
      ),
      title = node("span", undefined, "tool-title");
    title.append(
      node(
        "strong",
        kind === "files" ? tool.file.path : (tool.name ?? "Unmatched result"),
      ),
    );
    title.append(
      node(
        "small",
        kind === "files"
          ? tool.name + " · " + tool.file.operation
          : (tool.file?.path ??
              (tool.parentToolUseId ? "Subagent tool" : "Main session")),
      ),
    );
    const status = node("span", state(tool.status), "pill " + tool.status);
    const time = node(
      "small",
      tool.durationMs === undefined
        ? timestamp(tool.requestedAt ?? tool.completedAt)
        : (tool.durationMs / 1000).toFixed(2) + " s",
      "tool-time",
    );
    summary.append(icon, title, status, time);
    const body = node("div", undefined, "tool-inspector");
    card.append(summary, body);
    let loaded = false;
    const load = async () => {
      if (!card.open || loaded) return;
      loaded = true;
      body.replaceChildren(node("p", "Loading observation…", "hint"));
      try {
        const value = await api(`/jobs/${id}/tools/${tool.id}`);
        if (jobId !== id || cards.get(key)?.element !== card) return;
        body.replaceChildren();
        inspector(body, value);
      } catch (error) {
        loaded = false;
        body.replaceChildren(node("p", error.message, "error"));
      }
    };
    card.ontoggle = () => void load();
    cards.set(key, { signature, element: card });
    if (card.open) void load();
    return card;
  }
  async function listPages(path, pages, firstPage) {
    let after = 0,
      values = [],
      nextCursor = null;
    for (let page = 0; page < pages; page++) {
      const data =
        page === 0 && firstPage
          ? firstPage
          : await api(
              path +
                "&after=" +
                after +
                (firstPage ? "&through=" + firstPage.through : ""),
            );
      values.push(...(data.tools ?? data.entries));
      nextCursor = data.nextCursor;
      if (nextCursor === null) break;
      after = nextCursor;
    }
    return { values, nextCursor };
  }
  function journal(entries, id) {
    const children = [];
    for (const entry of entries) {
      const key = "event:" + entry.id;
      if (cards.has(key)) {
        children.push(cards.get(key).element);
        continue;
      }
      const row = node("details", undefined, "audit-entry"),
        summary = node("summary");
      const title = entry.type.replaceAll(".", " / ").replaceAll("_", " ");
      summary.append(
        node("time", timestamp(entry.createdAt)),
        node("strong", title),
        node("span", entry.source, "audit-source"),
      );
      row.append(summary);
      let loaded = false;
      row.ontoggle = async () => {
        if (!row.open || loaded) return;
        loaded = true;
        try {
          const data = await api(
            `/jobs/${id}/audit?after=${entry.id - 1}&through=${entry.id}&limit=1&includePayloads=true`,
          );
          if (jobId === id)
            payload(row, "Recorded observation", data.entries[0]);
        } catch (error) {
          loaded = false;
          notice(error.message);
        }
      };
      cards.set(key, { element: row });
      children.push(row);
    }
    replaceIfChanged(el("audit-entries"), children);
  }
  async function select(job) {
    begin(job.id);
    const current = ++revision,
      id = jobId;
    const first = await api(`/jobs/${id}/audit?limit=30`);
    if (current !== revision || jobId !== id) return;
    const count = first.summary;
    el("audit-summary").replaceChildren(
      ...[
        [count.tools, "tool calls"],
        [count.files, "file targets"],
        [count.changedFiles, "reported changed"],
        [count.events, "audit events"],
      ].map(([value, label]) => {
        const item = node("div");
        item.append(node("strong", String(value)), node("span", " " + label));
        return item;
      }),
    );
    el("activity-count").textContent = String(count.tools);
    el("files-count").textContent = String(count.files);
    el("audit-count").textContent = String(count.events);
    const coverage =
      count.coverage === "client_functions"
        ? "Functions run in the calling application. Inspect requests and client-reported results in the audit log; their filesystem effects are not observed here."
        : count.coverage === "host_lifecycle"
          ? "The host conversation reports job progress. Its internal tool calls and file changes are not exposed to this bridge."
          : "Complete tool payloads as emitted by Claude. Outcomes are provider-reported; shell and external tool side effects may not identify files.";
    el("audit-coverage").textContent = coverage;
    el("file-coverage").textContent =
      "Read, Write, Edit, and NotebookEdit targets reported by Claude. Expand an action to inspect content and available diffs. A successful command alone does not verify a file change.";
    const view = tab,
      stamp =
        first.through + ":" + toolPages + ":" + filePages + ":" + eventPages;
    if (view === "conversation" || loadedFor.get(view) === stamp) return;
    const data = await listPages(
      `/jobs/${id}/tools?limit=25` +
        (view === "files" ? "&filesOnly=true" : ""),
      view === "files" ? filePages : toolPages,
    );
    const events =
      view === "activity"
        ? await listPages(`/jobs/${id}/audit?limit=30`, eventPages, first)
        : null;
    if (current !== revision || jobId !== id || tab !== view) return;
    const kind = view === "files" ? "files" : "tools",
      list = view === "files" ? "file-list" : "tool-list",
      button = view === "files" ? "more-files" : "more-tools";
    const nodes = data.values.map((tool) => toolCard(tool, kind, id));
    replaceIfChanged(
      el(list),
      nodes.length
        ? nodes
        : [
            node(
              "p",
              view === "files"
                ? "No file targets observed for this job."
                : "No native tool calls observed for this job.",
              "audit-empty",
            ),
          ],
    );
    el(button).hidden = data.nextCursor === null;
    if (events) {
      journal(events.values, id);
      el("more-audit").hidden = events.nextCursor === null;
      if (count.coverage !== "native_tools") el("audit-journal").open = true;
    }
    loadedFor.set(view, stamp);
    showTab(tab);
  }
  for (const [id, increment] of [
    ["more-tools", () => toolPages++],
    ["more-files", () => filePages++],
    ["more-audit", () => eventPages++],
  ])
    el(id).onclick = async () => {
      increment();
      try {
        await select({ id: jobId });
      } catch (e) {
        notice(e.message);
      }
    };
  el("export-audit").onclick = async () => {
    const id = jobId,
      button = el("export-audit");
    button.disabled = true;
    try {
      let after = 0,
        through,
        bytes = 0,
        first = true;
      const parts = [];
      do {
        const page = await api(
          `/jobs/${id}/audit?limit=200&includePayloads=true&after=${after}` +
            (through === undefined ? "" : `&through=${through}`),
        );
        if (jobId !== id)
          throw new Error(
            "Selection changed. Select the job again to export its audit.",
          );
        through ??= page.through;
        if (!parts.length)
          parts.push(
            JSON.stringify({
              schemaVersion: 1,
              jobId: id,
              through,
              exportedAt: new Date().toISOString(),
            }).slice(0, -1) + ',"entries":[',
          );
        for (const entry of page.entries) {
          const encoded = JSON.stringify(entry);
          bytes += new TextEncoder().encode(encoded).length;
          if (bytes > 64_000_000)
            throw new Error(
              "This audit exceeds the 64 MB browser export limit. Export all pages with the audit API; no partial download was created.",
            );
          parts.push((first ? "" : ",") + encoded);
          first = false;
        }
        after = page.nextCursor;
      } while (after !== null);
      parts.push("]}");
      const url = URL.createObjectURL(
        new Blob(parts, { type: "application/json" }),
      );
      const link = node("a");
      link.href = url;
      link.download = `bridge-audit-${id}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      notice(error.message);
    } finally {
      button.disabled = false;
    }
  };
  return { select, reset, begin };
}
