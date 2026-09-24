# Architecture and design decisions

[README](../README.md) · [API](api.md) · [Operations](operations.md)

![Local bridge architecture](../assets/diagrams/architecture.svg)

[Download PNG](../assets/diagrams/architecture.png)

## Follow a request from start to finish

| Stage    | Client / caller                                                       | Signature Agent Bridge                                                           | Claude                                                                                |
| -------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Start    | An application, script, or browser prepares a prompt                  | A host-loaded MCP adapter starts or discovers the local service                  | The official executable is installed and authenticated by its user                    |
| Submit   | Sends a REST request with a bridge token and optional idempotency key | Authenticates, validates the profile, and commits the job to SQLite              | No model execution has started yet                                                    |
| Execute  | Receives a job ID and can subscribe to events                         | Claims an exclusive attempt and starts the official CLI with the prompt on stdin | Uses the user's subscription, runs tools, and manages its own subagents and context   |
| Observe  | Receives SSE progress and can inspect the job over REST               | Persists structured observations before publishing them                          | Emits output, compaction boundaries, child-task updates, limits, and its final result |
| Continue | Sends a follow-up or pause/resume command                             | Coordinates the state transition, session ID, and next workflow step             | Resumes its native conversation when requested                                        |

The plugin is the host integration and startup mechanism. The durable queue and HTTP listener run in a separate local service process. Automatic model work runs in an owned Claude Code process. These responsibilities stay separate even when everything runs on the same laptop.

For optional channel jobs, the current Claude host conversation performs the work after claiming it through MCP. That path uses explicit progress/completion acknowledgments because the bridge cannot directly control a Desktop or Code conversation's process.

## One service owns mutable state

Desktop and Code run thin stdio MCP adapters. They discover or start a shared local service. A renewable filesystem lock gives one service ownership of the database and worker processes. HTTP clients and the console use that same service.

This avoids two independent queues when both Claude hosts are open. It also keeps configuration and job history independent of plugin-cache paths, which change during updates.

The service validates the saved instance ID and protocol version when reconnecting. An unrelated process listening on the same port is not accepted as the bridge. A port collision is detected before crash recovery mutates active attempts.

## Three identities with different lifetimes

| Identity           | Purpose                                    | Lifetime                            |
| ------------------ | ------------------------------------------ | ----------------------------------- |
| Job ID             | User-visible work and conversation         | Durable                             |
| Attempt ID + fence | Exclusive authority to execute one attempt | Ends when the attempt finishes      |
| Claude session ID  | Native conversation and compacted context  | Managed by Claude's session storage |

A resume uses the same Claude session. An explicit retry creates a new attempt and a new session while retaining the job's history. The job workspace remains available; retry is not a filesystem rollback.

## Commands and events commit together

SQLite uses WAL, foreign keys, full synchronous commits, prepared statements, and immediate transactions. Job transitions, idempotency records, and events are written together.

An idempotency key is scoped to a principal and operation. The same request returns its existing resource; changing its body under the same key produces a conflict. A fence prevents a disconnected or superseded worker from finishing a newer attempt.

The latest 10,000 event sequence IDs are retained. Clients reconnect with a cursor. An expired cursor is explicit and requires a state refresh, preventing silent gaps.

![Bidirectional REST/SSE communication](../assets/diagrams/communication.svg)

[Download PNG](../assets/diagrams/communication.png)

## Claude owns its context

The worker invokes the unmodified installed Claude Code executable. Prompts go over stdin, never through a shell. The worker enables native bypass and suppresses host customizations with safe mode while preserving the official subscription login.

The bridge observes structured session, compaction, rate-limit, and child-task events. It does not rewrite Claude's transcripts, invent a summary, scrape authentication secrets, or reconstruct native tool history after compaction.

Model access still depends on Anthropic's current subscription support and managed policy. The bridge checks for conflicting API/provider environment settings and never silently changes the billing path.

## Process ownership is the execution boundary

Each job has its own working directory. This organizes files; it does not sandbox tools. The worker uses a separate POSIX process group, or Windows process-tree termination, for cancellation and shutdown. Graceful termination gives Claude time to record unfinished work; a bounded escalation stops unresponsive processes.

A channel host is different: the bridge does not own that conversation's process. It requests control changes and waits for explicit acknowledgment. Losing the host marks the attempt interrupted, so external side effects can be reconciled.

## Workflows have durable checkpoints

Each run snapshots its template and inputs. Only a successful current step creates the next step. Failed steps do not automatically replay. Explicit workflow pause blocks advancement even when a current job has already completed.

Subagents run inside a Claude execution. The bridge observes their lifecycle, limits reported child-task count, and stops them with their parent. Independent agent teams and arbitrary graph scheduling are not part of this release.

![Workflow and child-task ownership](../assets/diagrams/workflows.svg)

[Download PNG](../assets/diagrams/workflows.png)
