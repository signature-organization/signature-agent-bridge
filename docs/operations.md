# Execution, recovery, and operations

[README](../README.md) · [Architecture](architecture.md) · [Configuration](configuration.md)

![Job execution lifecycle](../assets/diagrams/lifecycle.svg)

[PNG version](../assets/diagrams/lifecycle.png)

## State and controls

| State              | Meaning                                      | Appropriate next action                              |
| ------------------ | -------------------------------------------- | ---------------------------------------------------- |
| `queued`           | Admitted, awaiting a worker or channel claim | Wait, pause, or cancel                               |
| `running`          | An exclusive attempt owns the work           | Inspect progress, send a follow-up, pause, or cancel |
| `pause_requested`  | The owner is being asked to stop             | Wait for the attempt to reconcile                    |
| `paused`           | No active attempt is executing the job       | Inspect the reason; resume when eligible             |
| `cancel_requested` | Cancellation is in progress                  | Wait for acknowledgment or reconciliation            |
| `succeeded`        | A terminal result was committed              | Read it or send a standalone follow-up               |
| `failed`           | Execution or validation failed               | Diagnose before an explicit retry                    |
| `timed_out`        | The configured attempt timeout elapsed       | Inspect partial side effects before retrying         |
| `canceled`         | The attempt acknowledged cancellation        | Retry only if intended                               |
| `interrupted`      | Worker or host ownership was lost            | Reconcile effects before retrying                    |

**Pause dispatch** stops new admissions to workers and requests pauses for active CLI jobs. It does not cancel the queue. **Resume dispatch** clears the global gate when the provider reset permits it; individual paused jobs remain explicit controls in the panel.

## Compaction

Claude owns the native transcript and its compacted summary. The bridge persists session IDs and records `job.compaction` events. A compacted conversation continues through Claude's `--resume` mechanism; the bridge does not replay the pre-compaction transcript.

A reported compaction failure pauses the execution for review. If a native session has been removed or is no longer resumable, the CLI reports an error. The bridge does not silently substitute a fresh session.

## Subscription limits

The worker observes native `rate_limit_event` records and terminal quota errors. A rejection pauses the affected job and latches a persistent global dispatch gate.

A valid future `resetsAt` timestamp is honored with a five-second buffer. At that point the bridge can continue a quota-paused job with a saved session, up to three automatic resumptions per job. It never guesses a reset time from prose, purchases usage, changes subscriptions, or switches to API billing.

If a reset timestamp is absent, an operator must decide when to resume dispatch and the paused job. A workflow explicitly paused by an operator is not automatically resumed by the quota timer. Other attempts paused while a quota gate is applied remain visible for operator control.

Usage fields are shown only when reported by Claude. Missing utilization does not mean zero usage.

## Follow-up turns

A standalone job is a conversation. A follow-up received during execution waits for the current attempt to finish. On success, the next attempt uses the same session and only the new user messages. A paused attempt retains queued follow-ups until its unfinished work has been resumed and completed.

The bridge limits a conversation to 64 messages and 200,000 characters of retained conversation text when admitting another follow-up. Start a new job when that limit is reached.

Workflow prompts come from the snapshot. They do not accept arbitrary follow-up messages that would change the meaning of downstream steps.

## Crashes and external effects

A startup recovery marks attempts with lost ownership interrupted; it does not automatically repeat them. Attempt fences reject stale completion messages.

Database atomicity is not an exactly-once guarantee for external effects. A tool may have written a file, sent a request, or changed a remote system before its result was lost. Review the workspace and external state before retrying.

Inspect the job's **Activity** and **Files** tabs before retrying. Tool results, full payloads, and known file targets remain in the [durable audit](audit.md). A missing result is **Outcome unknown**, even if the tool may have completed its side effect.

## Host lifecycle

MCP adapters renew host leases every two seconds. A channel claim whose host lease expires is interrupted. A notification does not claim work and never completes a job by itself.

The managed service stays available while hosts or queued/active CLI work need it, and uses an idle timeout when they do not. The console also renews an owner host lease while connected. Run the portable CLI's `serve` command without `--managed` for a continuously available local service.

Use `stop` for graceful shutdown. Active CLI work is paused and child processes are reconciled before the database lock is released.

## Data, retention, and backups

The data directory contains `config.json`, `queue.sqlite`, `owner.token`, a discovery file, and service logs. Job workspaces are under the configured workspace directory. Native Claude transcripts remain in Claude's own storage.

The service retains the latest 10,000 event sequence IDs. Jobs, messages, attempts, workflow snapshots, and full execution audits remain durable. Monitor disk usage and archive data deliberately; this release does not silently delete job history.

Stop the service before making a filesystem backup of SQLite and its sidecars. Protect backups as user data: prompts, results, full file contents, shell commands/output, and bridge authentication material can be sensitive. To restore, keep the configuration's absolute paths consistent with the restored data directory.

## Native protocol references

The worker follows the official [programmatic CLI documentation](https://code.claude.com/docs/en/headless), [Agent SDK reference](https://platform.claude.com/docs/en/agent-sdk/typescript), and [channel protocol](https://code.claude.com/docs/en/channels-reference). Subscription support is described in [Anthropic's Claude-plan guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
