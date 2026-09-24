# Security policy

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/signature-organization/signature-agent-bridge/security/advisories/new). Do not include live tokens, Claude credentials, personal prompts, or private transcripts in a public issue.

## Trust boundary

Signature Agent Bridge is a **single-user local automation service**. It is not a multitenant model gateway or a sandbox for untrusted prompts.

Worker execution uses Claude Code's native bypass permission mode. Tools execute with the OS user's privileges. A profile containing Bash can run arbitrary commands; a job directory is organizational isolation, not filesystem confinement.

The API binds to loopback. Every versioned endpoint requires a bridge bearer token, except an allowed browser's CORS preflight. Host and Origin validation reduce browser-origin attacks. Public HTML and static assets contain no authentication material.

Client tokens are scoped by principal, operations, and configured profiles. The database stores their hashes. SSE streams are revalidated during delivery and closed after revocation. Tokens are never accepted through query strings.

## Execution audit data

The audit preserves complete emitted tool inputs and outputs, including file contents and shell commands. A command can print credentials or personal data; these remain in the protected local audit. Metadata lists and tool SSE notifications omit payloads, while authenticated detail and export endpoints require the job's `read` scope and ownership. The local owner can inspect every job.

Exports and database backups require the same protection as source workspaces. No automatic redaction, encryption-at-rest, or tamper-proof ledger is claimed. The bridge does not read arbitrary files to fill gaps in tool observations.

## Claude authentication

The bridge invokes the unmodified official executable under the current user's login. It does not extract, proxy, persist, or forward Claude OAuth credentials. API/provider environment overrides are rejected rather than silently changing billing.

Managed Claude policy, subscription eligibility, quotas, and initial host consent remain under Anthropic's control.

## Tunnels

Use HTTPS and a separate scoped token for each remote application. Configure the exact public Host and Origin values. Preserve SSE streaming and disable intermediary buffering. Do not distribute the owner token to remote integrations.

A tunnel does not add isolation to a bypass worker. Give a remote caller only profiles you trust it to use.

## Recovery

SQLite transactions and fenced attempts prevent duplicate ownership. They cannot make external tool side effects transactional. Interrupted work is retained for explicit reconciliation; retries can repeat effects.

## Release integrity

The Code bootstrap downloads a pinned release and verifies its published SHA-256 checksum before installation. GitHub release permissions and HTTPS are part of the distribution trust boundary. macOS executables are ad-hoc signed; they are not Apple-notarized. MCPB bundles are not signed with a publisher certificate in this initial release.

Report a suspected dependency or release-integrity issue through the private channel above.
