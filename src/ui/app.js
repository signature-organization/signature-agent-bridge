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

/* All rendered task content uses textContent: prompts and Claude output are untrusted data. */
const el = (id) => document.getElementById(id);
let token = "",
  selected = "",
  jobs = [],
  cursor = null,
  eventCursor = 0,
  controller,
  refreshing = false;
let templates = [],
  loadedPages = 1,
  selectionRevision = 0;
const hostId = crypto.randomUUID(),
  seenEvents = new Set();
const text = (id, value) => {
  el(id).textContent = String(value ?? "");
};
const human = (value) =>
  ({
    operator_pause: "Paused by the operator. Resume when you are ready.",
    "job.paused": "A job is paused and ready for review.",
    "job.compaction":
      "Claude compacted a conversation. Its session is preserved.",
  })[value] ?? value;
const notice = (message) => {
  text("notice", human(message));
  el("notice").hidden = !message;
};
const badge = (status) => {
  const node = document.createElement("span");
  node.className = "pill " + status;
  node.textContent = status.replaceAll("_", " ");
  return node;
};
const action = (label, fn) => {
  const b = document.createElement("button");
  b.textContent = label;
  b.type = "button";
  b.onclick = () =>
    Promise.resolve()
      .then(fn)
      .catch((e) => notice(e.message));
  return b;
};
async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(
    (path === "/chat/completions" ? "/v1" : "/v1/bridge") + path,
    {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? "Request failed");
  return data;
}
function renderJobs() {
  el("jobs").replaceChildren();
  el("empty").hidden = jobs.length > 0;
  text("job-count", jobs.length);
  el("more").hidden = !cursor;
  for (const job of jobs) {
    const row = document.createElement("tr");
    if (job.id === selected) row.className = "active";
    const task = document.createElement("td");
    const prompt =
      job.completion?.messages.filter((m) => m.role === "user").at(-1)
        ?.content ?? job.prompt;
    task.append(
      action(
        (typeof prompt === "string" ? prompt : "Chat completion").slice(0, 110),
        () => selectJob(job.id),
      ),
    );
    const sub = document.createElement("small");
    sub.textContent =
      (job.completion
        ? "Chat completion"
        : job.mode === "cli"
          ? "Claude agent"
          : "Host conversation") +
      " / " +
      job.profile;
    task.append(sub);
    const state = document.createElement("td");
    state.append(badge(job.status));
    const updated = document.createElement("td"),
      time = document.createElement("time");
    time.textContent = new Date(job.updatedAt).toLocaleTimeString();
    updated.append(time);
    row.append(task, state, updated);
    el("jobs").append(row);
  }
}
function completionText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((part) => (part.type === "text" ? part.text : JSON.stringify(part)))
      .join("\n");
  return value == null ? "" : JSON.stringify(value, null, 2);
}
function completionResult(raw) {
  // Persisted inference results use a validated transport envelope; show the answer
  // and client-owned function requests instead of exposing that internal wrapper.
  try {
    const value = JSON.parse(raw);
    return [
      value.content ?? "",
      ...(value.tool_calls ?? []).map(
        (call) => "Client function: " + call.name + "\n" + call.arguments,
      ),
    ]
      .filter(Boolean)
      .join("\n\n");
  } catch {
    return raw;
  }
}
async function selectJob(id) {
  selected = id;
  const revision = ++selectionRevision;
  const job = await api("/jobs/" + id);
  if (revision !== selectionRevision) return;
  el("selection-empty").hidden = true;
  el("job-detail").hidden = false;
  text("detail-state", job.status.replaceAll("_", " "));
  el("detail-state").className = "pill " + job.status;
  text(
    "job-meta",
    job.profile +
      " / " +
      (job.completion ? "inference" : job.mode) +
      " / " +
      (job.compactions ?? 0) +
      " compactions" +
      (job.usage ? " / " + job.usage.total_tokens + " tokens" : ""),
  );
  text("job-error", human(job.error ?? ""));
  el("job-error").hidden = !job.error;
  el("job-actions").replaceChildren();
  const controls =
    job.status === "paused"
      ? ["resume", "cancel"]
      : ["running", "queued"].includes(job.status)
        ? ["pause", "cancel"]
        : ["failed", "interrupted", "timed_out", "canceled"].includes(
              job.status,
            )
          ? ["retry"]
          : [];
  for (const command of controls)
    el("job-actions").append(
      action(command[0].toUpperCase() + command.slice(1), async () => {
        if (
          command === "retry" &&
          !window.confirm(
            "Retry starts a new session and may repeat prior side effects. Continue?",
          )
        )
          return;
        await api("/jobs/" + id + "/" + command, {});
        await refresh();
      }),
    );
  el("messages").replaceChildren();
  const messages = job.completion
    ? [
        ...job.completion.messages.map((m) => ({
          role: m.role,
          text: [
            completionText(m.content),
            ...(m.tool_calls ?? []).map(
              (call) =>
                "Client function: " +
                call.function.name +
                "\n" +
                call.function.arguments,
            ),
          ]
            .filter(Boolean)
            .join("\n\n"),
        })),
        ...(job.result
          ? [{ role: "assistant", text: completionResult(job.result) }]
          : []),
      ]
    : [...job.messages, ...(job.pendingMessages ?? [])];
  for (const message of messages) {
    const node = document.createElement("div");
    node.className = "message " + message.role;
    const label = document.createElement("strong");
    label.textContent =
      message.role === "user"
        ? "You"
        : message.role === "assistant"
          ? "Claude"
          : message.role;
    const body = document.createElement("span");
    body.textContent = message.text;
    node.append(label, body);
    el("messages").append(node);
  }
  el("message-form").hidden =
    Boolean(job.workflowRunId || job.completion) ||
    ["paused", "pause_requested", "cancel_requested"].includes(job.status);
  el("subagents").replaceChildren();
  for (const [id, task] of Object.entries(job.subagents ?? {})) {
    const li = document.createElement("li");
    li.textContent = (task.description || id) + " — " + task.status;
    el("subagents").append(li);
  }
  if (!Object.keys(job.subagents ?? {}).length) {
    const li = document.createElement("li");
    li.textContent = "No child tasks reported.";
    el("subagents").append(li);
  }
  const attempts = await api("/jobs/" + id + "/attempts");
  if (revision !== selectionRevision) return;
  text(
    "attempts",
    JSON.stringify(
      {
        model: "bridge/" + job.profile,
        execution: job.completion ? "inference" : job.mode,
        usage: job.usage ?? null,
        sessionId: job.sessionId ?? null,
        ...attempts,
      },
      null,
      2,
    ),
  );
  renderJobs();
}
async function renderWorkflows() {
  const { runs } = await api("/workflow-runs");
  el("workflow-runs").replaceChildren();
  if (!runs.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent =
      "No workflow runs yet. Create a template below, then start a run here.";
    el("workflow-runs").append(p);
  }
  for (const run of runs) {
    const node = document.createElement("article");
    node.className = "run";
    const title = document.createElement("h3");
    title.textContent = run.template.id;
    node.append(title, badge(run.status));
    const steps = document.createElement("p");
    steps.textContent =
      run.jobIds.length + " of " + run.template.steps.length + " steps created";
    node.append(steps);
    const controls = document.createElement("div");
    controls.className = "actions";
    const commands =
      run.status === "succeeded" || run.cancelRequested
        ? []
        : run.pauseRequested || run.status === "paused" || run.blocked
          ? ["resume", "cancel"]
          : ["pause", "cancel"];
    for (const cmd of commands)
      controls.append(
        action(cmd[0].toUpperCase() + cmd.slice(1), async () => {
          await api("/workflow-runs/" + run.id + "/" + cmd, {});
          await refresh();
        }),
      );
    for (const id of run.jobIds)
      controls.append(
        action("Open step " + (run.jobIds.indexOf(id) + 1), async () => {
          showView("jobs");
          await selectJob(id);
        }),
      );
    node.append(controls);
    el("workflow-runs").append(node);
  }
  await renderTemplates();
}
async function renderTemplates() {
  try {
    templates = (await api("/admin/templates")).templates;
    el("templates-list").replaceChildren();
    el("new-template").hidden = false;
    if (!templates.length) {
      text(
        "templates-list",
        "Create a template to define a repeatable sequence of tasks.",
      );
      return;
    }
    for (const template of templates) {
      const node = document.createElement("article");
      node.className = "template-item";
      const title = document.createElement("h3");
      title.textContent = template.id;
      const purpose = document.createElement("p");
      purpose.textContent =
        template.description || template.steps.length + " ordered steps";
      const controls = document.createElement("div");
      controls.className = "actions";
      controls.append(
        action("Edit", () => openTemplate(template)),
        action("Delete", async () => {
          if (
            !window.confirm(
              "Delete this template? Existing runs keep their saved definition.",
            )
          )
            return;
          await api(
            "/admin/templates/" + encodeURIComponent(template.id),
            {},
            "DELETE",
          );
          await refresh();
        }),
      );
      node.append(title, purpose, controls);
      el("templates-list").append(node);
    }
  } catch (e) {
    el("new-template").hidden = true;
    text("templates-list", e.message);
  }
}
function addStep(
  step = {
    id: "step-" + (el("template-steps").children.length + 1),
    prompt: "",
    profile: "default",
  },
) {
  const card = document.createElement("section");
  card.className = "step-editor";
  const heading = document.createElement("div");
  heading.className = "step-editor-header";
  const title = document.createElement("strong");
  title.textContent = "Step " + (el("template-steps").children.length + 1);
  heading.append(
    title,
    action("Remove", () => card.remove()),
  );
  const row = document.createElement("div");
  row.className = "form-row";
  const idLabel = document.createElement("label");
  idLabel.textContent = "Step ID";
  const idInput = document.createElement("input");
  idInput.name = "step-id";
  idInput.required = true;
  idInput.pattern = "[a-zA-Z0-9_-]{1,64}";
  idInput.value = step.id;
  idLabel.append(idInput);
  const profileLabel = document.createElement("label");
  profileLabel.textContent = "Step profile";
  const profile = document.createElement("select");
  profile.name = "step-profile";
  for (const option of el("profile").options)
    profile.add(new Option(option.text, option.value));
  profile.value = step.profile;
  profileLabel.append(profile);
  row.append(idLabel, profileLabel);
  const promptLabel = document.createElement("label");
  promptLabel.textContent = "Step instructions";
  const prompt = document.createElement("textarea");
  prompt.name = "step-prompt";
  prompt.required = true;
  prompt.maxLength = 100000;
  prompt.value = step.prompt;
  promptLabel.append(prompt);
  card.append(heading, row, promptLabel);
  el("template-steps").append(card);
}
function openTemplate(template) {
  el("template-id").value = template?.id ?? "";
  el("template-id").readOnly = Boolean(template);
  el("template-description").value = template?.description ?? "";
  el("template-input-names").value = template?.inputs.join(", ") ?? "";
  el("template-steps").replaceChildren();
  for (const step of template?.steps ?? [
    {
      id: "research",
      profile: "default",
      prompt: "Research {{input.topic}} and summarize the findings.",
    },
  ])
    addStep(step);
  if (!template) el("template-input-names").value = "topic";
  el("template-error").hidden = true;
  el("template-dialog").showModal();
  el("template-id").focus();
}
async function refresh() {
  if (!token || refreshing) return;
  refreshing = true;
  try {
    const status = await api("/status");
    text(
      "health",
      status.scheduler.paused
        ? "Dispatch paused"
        : status.readiness.ready
          ? "Ready for work"
          : "Attention required",
    );
    text(
      "summary",
      status.activeJobs +
        " active jobs · Native bypass enabled" +
        (status.scheduler.retryAt
          ? " · Reset " + new Date(status.scheduler.retryAt).toLocaleString()
          : ""),
    );
    if (status.scheduler.reason) notice(status.scheduler.reason);
    text("diagnostics", JSON.stringify(status, null, 2));
    const facts = [
      [
        "Claude connection",
        status.readiness.ready
          ? "Ready"
          : (status.readiness.reason ?? "Checking"),
      ],
      ["Dispatch", status.scheduler.paused ? "Paused" : "Running"],
      ["Permission mode", "Native bypass"],
      ["Active jobs", status.activeJobs],
      ["Connected hosts", status.hosts ?? "Unavailable"],
      ["Event streams", status.eventConnections],
      ["Profiles", status.profiles.join(", ")],
      ["OpenAI base URL", location.origin + "/v1"],
      ["Model aliases", status.profiles.map((p) => "bridge/" + p).join(", ")],
      ["Workspace", status.workspace ?? "Owner access required"],
    ];
    el("health-facts").replaceChildren();
    for (const [label, value] of facts) {
      const term = document.createElement("dt"),
        description = document.createElement("dd");
      term.textContent = label;
      description.textContent = String(value);
      if (label === "Workspace") description.className = "path";
      el("health-facts").append(term, description);
    }
    const previous = el("profile").value;
    el("profile").replaceChildren(
      ...status.profiles.map((id) => new Option(id, id)),
    );
    if (status.profiles.includes(previous)) el("profile").value = previous;
    const prevTemplate = el("template").value;
    el("template").replaceChildren(
      ...status.templates.map((t) => new Option(t.id, t.id)),
    );
    el("template").value = status.templates.some((t) => t.id === prevTemplate)
      ? prevTemplate
      : (status.templates[0]?.id ?? "");
    const templateHelp = () => {
      const t = status.templates.find((t) => t.id === el("template").value);
      text(
        "template-help",
        t
          ? "Required inputs: " + (t.inputs.join(", ") || "none")
          : "No templates configured.",
      );
    };
    el("template").onchange = templateHelp;
    templateHelp();
    el("workflow-form").querySelector("button").disabled =
      !status.templates.length;
    // Refresh the pages the operator opened, keeping recent jobs first as history grows.
    const refreshed = [];
    let after = "";
    for (let page = 0; page < loadedPages; page++) {
      const data = await api(
        "/jobs?limit=200&order=desc&after=" + encodeURIComponent(after),
      );
      refreshed.push(...data.jobs);
      after = data.nextCursor;
      if (!after) break;
    }
    jobs = refreshed;
    cursor = after;
    renderJobs();
    if (selected) await selectJob(selected);
    if (!el("workflows-view").hidden) await renderWorkflows();
    if (!el("diagnostics-view").hidden) await renderTokens();
  } catch (e) {
    notice(e.message);
  } finally {
    refreshing = false;
  }
}
async function renderTokens() {
  try {
    const { tokens } = await api("/admin/tokens");
    el("tokens").replaceChildren();
    for (const t of tokens) {
      const row = document.createElement("div");
      row.className = "token-row";
      const name = document.createElement("span");
      name.textContent = t.id + (t.revoked ? " (revoked)" : "");
      row.append(name);
      if (!t.owner && !t.revoked)
        row.append(
          action("Revoke", async () => {
            await api("/admin/tokens/revoke", { id: t.id });
            await renderTokens();
          }),
        );
      el("tokens").append(row);
    }
  } catch (e) {
    text("tokens", e.message);
  }
}
function showView(name) {
  for (const node of document.querySelectorAll(".view"))
    node.hidden = node.id !== name + "-view";
  for (const b of document.querySelectorAll("[data-view]")) {
    b.classList.toggle("selected", b.dataset.view === name);
    b.setAttribute("aria-current", b.dataset.view === name ? "page" : "false");
  }
  text(
    "view-title",
    {
      jobs: "Jobs & conversations",
      workflows: "Workflows",
      diagnostics: "Diagnostics",
    }[name],
  );
  text(
    "view-description",
    {
      jobs: "Keep every task moving, with the context to pick it up again.",
      workflows: "Coordinate repeatable work with a checkpoint at every step.",
      diagnostics:
        "Understand your service, its connections, and application access.",
    }[name],
  );
  void refresh();
}
for (const button of document.querySelectorAll("[data-view]"))
  button.onclick = () => showView(button.dataset.view);
/* fetch streaming permits bearer headers; EventSource would force a cookie or a URL token. */
async function stream(signal) {
  let delay = 1000;
  while (token && !signal.aborted) {
    try {
      const response = await fetch("/v1/bridge/events", {
        headers: {
          Authorization: "Bearer " + token,
          "Last-Event-ID": String(eventCursor),
        },
        signal,
      });
      if (response.status === 409) {
        eventCursor = (await api("/status")).eventCursorFloor;
        await refresh();
        const data = await response.json();
        notice(data.error.message + " State refreshed.");
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (!response.ok)
        throw new Error("Event connection rejected (" + response.status + ")");
      text("stream-state", "Live / SSE");
      text("connection", "Connected");
      delay = 1000;
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const id = frame.match(/^id: (\d+)/m)?.[1],
            data = frame.match(/^data: (.+)$/m)?.[1];
          if (id) eventCursor = Number(id);
          if (!data || seenEvents.has(eventCursor)) continue;
          seenEvents.add(eventCursor);
          if (seenEvents.size > 500)
            seenEvents.delete(seenEvents.values().next().value);
          const event = JSON.parse(data),
            li = document.createElement("li"),
            time = document.createElement("time"),
            body = document.createElement("span");
          time.textContent = new Date(event.createdAt).toLocaleTimeString();
          body.textContent =
            event.type +
            " / " +
            (event.data.text ?? event.data.error ?? event.jobId);
          li.append(time, body);
          el("events").prepend(li);
          while (el("events").children.length > 80)
            el("events").lastChild.remove();
          if (
            ["job.paused", "job.rate_limit", "job.compaction"].includes(
              event.type,
            )
          )
            notice(event.data.error ?? event.data.text ?? event.type);
        }
      }
    } catch {
      if (signal.aborted) return;
      text("stream-state", "Reconnecting…");
      text("connection", "Reconnecting");
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(15000, delay * 2);
  }
}
el("connect-form").onsubmit = async (event) => {
  event.preventDefault();
  token = el("token").value.trim();
  try {
    await api("/status");
    el("token").value = "";
    el("login").hidden = true;
    el("workspace").hidden = false;
    el("logout").hidden = false;
    el("new-job").hidden = false;
    notice("");
    controller = new AbortController();
    void stream(controller.signal);
    await refresh();
  } catch (e) {
    token = "";
    notice(e.message);
  }
};
el("logout").onclick = () => {
  void api("/hosts/disconnect", { id: hostId }).catch(() => {});
  token = "";
  controller?.abort();
  location.reload();
};
el("refresh").onclick = () => {
  notice("");
  void refresh();
};
for (const cmd of ["pause", "resume"])
  el(cmd + "-all").onclick = () =>
    api("/admin/" + cmd, {})
      .then(() => {
        notice("");
        return refresh();
      })
      .catch((e) => notice(e.message));
el("job-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const job = await api("/chat/completions", {
      model: "bridge/" + el("profile").value,
      messages: [{ role: "user", content: el("prompt").value }],
      bridge: {
        execution: el("mode").value === "cli" ? "agent" : el("mode").value,
        background: true,
      },
    });
    el("prompt").value = "";
    el("job-dialog").close();
    selected = job.id;
    notice("");
    await refresh();
  } catch (e) {
    text("job-form-error", e.message);
    el("job-form-error").hidden = false;
  }
};
el("message-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("/jobs/" + selected + "/messages", {
      text: el("followup").value,
    });
    el("followup").value = "";
    await refresh();
  } catch (e) {
    notice(e.message);
  }
};
el("workflow-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("/workflow-runs", {
      templateId: el("template").value,
      inputs: JSON.parse(el("workflow-inputs").value),
    });
    await refresh();
  } catch (e) {
    notice(e.message);
  }
};
el("token-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const result = await api("/admin/tokens", {
      id: el("client-name").value,
      profiles: el("client-profiles")
        .value.split(",")
        .map((x) => x.trim()),
      scopes: ["read", "submit", "control", "workflows"],
    });
    text("new-token", result.token);
    el("new-token").hidden = false;
    await renderTokens();
  } catch (e) {
    notice(e.message);
  }
};
el("more").onclick = async () => {
  if (refreshing) return;
  loadedPages++;
  await refresh();
};
setInterval(() => {
  if (token) {
    void api("/hosts/heartbeat", { id: hostId }).catch(() => {});
    void refresh();
  }
}, 5000);

el("new-job").onclick = () => {
  el("job-form-error").hidden = true;
  el("job-dialog").showModal();
  el("prompt").focus();
};
el("close-job").onclick = () => el("job-dialog").close();
el("new-template").onclick = () => openTemplate();
el("close-template").onclick = () => el("template-dialog").close();
el("add-step").onclick = () => {
  if (el("template-steps").children.length < 32) addStep();
};
el("template-form").onsubmit = async (event) => {
  event.preventDefault();
  const body = {
    id: el("template-id").value,
    description: el("template-description").value,
    inputs: el("template-input-names")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    steps: [...el("template-steps").children].map((card) => ({
      id: card.querySelector('[name="step-id"]').value,
      prompt: card.querySelector('[name="step-prompt"]').value,
      profile: card.querySelector('[name="step-profile"]').value,
    })),
  };
  try {
    await api("/admin/templates/" + encodeURIComponent(body.id), body, "PUT");
    el("template-dialog").close();
    await refresh();
  } catch (e) {
    text("template-error", e.message);
    el("template-error").hidden = false;
  }
};

el("template-form").addEventListener("input", () => {
  el("template-error").hidden = true;
});
