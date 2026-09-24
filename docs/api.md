# Unified API reference

[README](../README.md) · [OpenAPI 3.1](openapi.json) · [Runnable client](../examples/client.mjs) · [Tunnels](tunnels.md)

The bridge exposes one API: OpenAI-compatible `/v1/models` and `/v1/chat/completions`, plus `/v1/bridge/*` orchestration extensions. The console, MCP integration, SDK clients, and workflows share authentication, profiles, one durable queue, and the same execution lifecycle. See the [SDK guide](openai-compatible.md) for the compatibility contract and runnable Python examples.

## Authentication and errors

Use `Authorization: Bearer $BRIDGE_TOKEN` on every `/v1/` request. Tokens never belong in URLs. An approved browser origin may send an unauthenticated CORS preflight; its subsequent command still requires authentication.

Client tokens are scoped to a principal, allowed profiles, and operations. `read` permits status and that principal's resources; `submit` permits jobs and follow-ups; `control` permits pause, resume, cancel, and retry; `workflows` permits starting an allowed template. Owner tokens administer configuration and all resources.

Errors use `{"error":{"code":"...","message":"...","type":"invalid_request_error","param":null,"requestId":"..."}}`; the type reflects the error class, and an admitted completion can also include `job_id`. Common statuses: 400 invalid input, 401 invalid token, 403 unavailable scope/profile/host/origin, 404 inaccessible resource, 409 incompatible state or idempotency conflict, 413 size bound, 429 admission or rate limit, 503 unavailable configuration.

Traffic is limited to 240 requests per minute per principal **per admission class**: ordinary requests, execution controls, and host leases. Read polling cannot exhaust the lease or stop/cancel bucket. SSE permits four connections per principal and 100 per service.

## Jobs and conversation turns

| Method and path                                         | Purpose                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /v1/bridge/status`                                 | Version, readiness, dispatch gate, profiles, available templates                       |
| `GET /v1/models`                                        | Discover authorized `bridge/<profile>` models                                          |
| `POST /v1/chat/completions`                             | Submit messages; returns completion JSON/SSE, or 202 Job with `bridge.background:true` |
| `GET /v1/bridge/jobs?limit=100&after=UUID&order=asc`    | Principal-scoped page; limit 1–200, asc or desc                                        |
| `GET /v1/bridge/jobs/{id}`                              | Current job, messages, status, session, reported child tasks                           |
| `GET /v1/bridge/jobs/{id}/result`                       | 202 while nonterminal; 200 with terminal status/result/error                           |
| `GET /v1/bridge/jobs/{id}/attempts`                     | Attempt history without private claim fences                                           |
| `GET /v1/bridge/jobs/{id}/messages`                     | Conversation and pending messages                                                      |
| `POST /v1/bridge/jobs/{id}/messages`                    | Queue `{text}` as another native session turn                                          |
| `POST /v1/bridge/jobs/{id}/{pause,resume,cancel,retry}` | Explicit execution control                                                             |

`model` selects a configured profile, such as `bridge/default`. `bridge.execution` defaults to `inference`: native tools are disabled and client functions are returned as OpenAI tool calls. Choose `agent` for profile-controlled native work or `channel` for a host conversation. `bridge.background:true` returns a durable Job receipt; channel requires it. Native agent/channel input is one text user message. The caller cannot supply CLI arguments, executable paths, environment overrides, or working directories.

```json
{
  "model": "bridge/default",
  "messages": [
    { "role": "user", "content": "Write a concise project checklist" }
  ],
  "bridge": { "execution": "agent", "background": true }
}
```

Use a unique `Idempotency-Key` for job creation, follow-ups, and workflow creation. Repeating the same principal, operation, key, and body returns the existing resource; changing the body returns 409. Preserve the key across uncertain network retries.

Inference histories belong to the calling SDK: submit full history as a new chat request for each turn. The follow-up endpoint is for native agent conversations. A message during execution or queued native continuation waits until that turn completes. Paused jobs must resume before accepting messages. Workflow-step prompts are fixed; start a separate job for follow-up discussion. Resume preserves an available native session; retry creates a new session and may repeat effects.

## Execution audit and full tool payloads

| Method and path                         | Purpose                                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /v1/bridge/jobs/{id}/audit`        | Durable, paginated observations; optional `includePayloads=true` and fixed `through` snapshot. |
| `GET /v1/bridge/jobs/{id}/tools`        | Current native tool metadata; `filesOnly=true` filters reported file targets.                  |
| `GET /v1/bridge/jobs/{id}/tools/{tool}` | Full input/output, command/content, result, and correlation for one numeric tool record.       |

All three require `read` and job ownership (or owner access). Lists accept numeric `after` and `limit` 1–200. Follow `nextCursor` until null; audit pages have a byte budget and may return fewer than the requested limit. See the [audit guide](audit.md) for complete fields, provenance, retention, and large JSON exports.

## Orchestration event stream

```sh
curl --no-buffer --fail-with-body "$BRIDGE_URL/v1/bridge/events" \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Last-Event-ID: 42"
```

This stream describes jobs and workflows. Chat Completions uses standard OpenAI SSE on its own response when `stream:true`, with buffered validated output. Both belong to the same API; they have different message contracts.

Each orchestration event has a durable numeric ID:

```text
id: 43
event: job.progress
data: {"id":43,"principalId":"client","jobId":"...","type":"job.progress","data":{"text":"Working"},"createdAt":"..."}

```

Save the last processed ID and reconnect with `Last-Event-ID`. Deduplicate by ID. Event IDs are global, so scoped clients can see gaps. Heartbeat comments carry no event ID. A slow client is disconnected rather than consuming unbounded memory.

The service retains approximately the newest 10,000 events. HTTP 409 `event_cursor_expired` means refresh current resource state and restart from `eventCursorFloor` in status. SSE is a notification log, not an indefinitely retained audit archive.

Typical events: `job.queued`, `job.running`, `job.session`, `job.progress`, `job.tool`, `job.message`, `job.compaction`, `job.subagent`, `job.rate_limit`, `job.paused`, `job.resumed`, `job.succeeded`, `job.failed`, `job.interrupted`, and `workflow.failed`.

Use `fetch` streaming in browsers to send a bearer header. Native `EventSource` does not expose arbitrary authorization headers. See [examples/client.mjs](../examples/client.mjs) for a complete command/event loop.

## Workflows and templates

| Method and path                                            | Purpose                                            |
| ---------------------------------------------------------- | -------------------------------------------------- |
| `POST /v1/bridge/workflow-runs`                            | Start `{templateId, inputs}`; returns 202          |
| `GET /v1/bridge/workflow-runs`                             | Up to 200 most recent scoped runs                  |
| `GET /v1/bridge/workflow-runs/{id}`                        | Template snapshot, inputs, step job IDs, state     |
| `POST /v1/bridge/workflow-runs/{id}/{pause,resume,cancel}` | Control a run without replaying completed steps    |
| `GET /v1/bridge/admin/templates`                           | Owner: full reusable definitions                   |
| `PUT /v1/bridge/admin/templates/{templateId}`              | Owner: validate and persist a definition           |
| `DELETE /v1/bridge/admin/templates/{templateId}`           | Owner: remove a definition, preserve run snapshots |

See [template authoring](workflows.md) for schemas, valid references, and use cases.

## Owner and host operations

Owner routes include `POST /v1/bridge/admin/{pause,resume,stop}`, `GET/POST /v1/bridge/admin/tokens`, and `POST /v1/bridge/admin/tokens/revoke`. Token creation takes `{id, profiles, scopes}`; revocation takes `{id}` and revokes every token for that principal.

Adapters renew `POST /v1/bridge/hosts/heartbeat` with `{id}` and close through `POST /v1/bridge/hosts/disconnect`. Leases last seven seconds.

For host-conversation execution: list `GET /v1/bridge/channel/pending`, then `POST /v1/bridge/channel/claim` with `{hostId, jobId}`. The response contains the job and a private attempt receipt. One host may hold one outstanding claim. Progress, completion, and stopped acknowledgments must supply the same `hostId`, `attemptId`, and `fence`. Add `text` to progress or `result` to completion. A notification alone grants no execution authority.

A lost lease interrupts the attempt and rejects late completion. The operator must reconcile external actions before retrying.
