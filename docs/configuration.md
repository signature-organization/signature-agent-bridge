# Configuration

[Install](installation.md) · [Workflows](workflows.md) · [Security](../SECURITY.md)

The first host load creates a private `config.json` in the bridge data directory. Paths must be absolute. Template edits in the console update this file atomically. Other configuration changes require a restart.

| Setting                 | Default                         | Purpose                                                             |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------- |
| `dataDir`               | OS-specific user data directory | Durable state, tokens, and discovery                                |
| `workspace`             | `<dataDir>/jobs`                | One subdirectory per job                                            |
| `claudePath`            | Discovered official executable  | Local Claude Code; never supplied by an API request                 |
| `host`                  | `127.0.0.1`                     | Loopback only                                                       |
| `port`                  | `8766`                          | Listener port; `0` selects an available port                        |
| `concurrency`           | `1`                             | Concurrent CLI attempts, range 1–8                                  |
| `queueCapacity`         | `1000`                          | Admission bound for queued/active work                              |
| `allowedHosts`          | `localhost`, `127.0.0.1`        | Accepted HTTP Host names                                            |
| `allowedOrigins`        | `[]`                            | Additional trusted browser origins                                  |
| `idleMs`                | `30000`                         | Managed service idle timeout                                        |
| `profiles`              | One `default` profile           | Tools, model, execution limits, and named agents                    |
| `workflows`             | `[]`                            | Reusable sequential templates                                       |
| `openai.timeoutMs`      | `300000`                        | Completion deadline including queue wait; 100–3,600,000 ms          |
| `openai.maxConnections` | `16`                            | Total synchronous completion waiters; 1–64, with four per principal |

## Execution profiles

A profile allows a client to choose a preconfigured execution environment without accepting arbitrary command-line flags, executable paths, or environment variables from the network.

Each profile appears as `bridge/<profile>` in model discovery for authorized clients. Inference jobs retain the profile model and execution limits but disable all native tools and named agents; application functions are requested through OpenAI tool calls. `bridge.execution: "agent"` enables the native tool configuration below.

The default profile enables Read, Write, Edit, Bash, Glob, and Grep. Its limits are a five-minute attempt timeout, two million output bytes, 100 model turns, and eight reported child tasks.

Profiles can include a model name and explicit tools from Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, and Agent. Named subagents have their own explicit tool lists and cannot recursively include Agent through the profile schema.

These are tool-selection controls, not an OS sandbox. Bash can perform arbitrary actions permitted to the bridge's OS user. Grant profiles only to callers you trust with those capabilities.

## Bridge tokens

See [Get your bridge token](tokens.md) for exact file locations, clipboard commands, client creation, and REST/SSE examples.

The owner token is stored in `owner.token` with private file permissions on platforms that support them. Scoped client tokens are generated through the console or CLI, returned once, and stored in the database as hashes.

Scopes are `read`, `submit`, `control`, and `workflows`. Non-owner tokens are restricted to their principal's jobs and assigned profiles. Template administration, service controls, host leases, and channel claims require the owner.

## Sharing state across installations

A plugin cache is executable code, not user state. Updating a Code plugin or Desktop bundle does not change the default data directory. Both adapters discover the same service by its saved instance ID and authenticated protocol response.
