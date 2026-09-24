# Verification and release evidence

[README](../README.md) · [Compatibility](compatibility.md) · [Contributing](../CONTRIBUTING.md)

## Automated checks

`npm run check` runs strict TypeScript checking, ESLint, formatting, unit/integration tests, browser interaction tests, bundled build, repository/contract checks, native packaging, and a clean-directory native MCP smoke test.

Coverage includes transactional admission and idempotency, principal isolation and token revocation, SSE replay and expired cursors, process bounds and cancellation, durable quota gates, workflow checkpoints, template persistence, paused follow-up ordering, host claim fencing, and daemon discovery.

The Chromium suite exercises jobs, follow-ups, pause/resume, workflow steps, template validation and execution, token creation/revocation, navigation, dialogs, and layouts from 320 to 1440 pixels. Documentation screenshots use deterministic fixtures, not production customer data.

## Live Claude Code check

On September 24, 2026, the explicit live smoke test passed on macOS arm64 using official Claude Code 2.1.260 with the user's own Claude.ai subscription login:

- Native bypass executed Write and Read without worker approval prompts.
- A follow-up continued the same native session and created a second file.
- A configured native subagent ran and its task events reached the bridge.

The test uses stdin for prompts. It does not extract credentials, alter the Claude client, or call a private provider endpoint.

## What remains host-specific

The MCPB manifest and archive are validated with Anthropic's official tooling. The packaged native executable is tested through a real stdio MCP client in a clean working directory. Platform builds and package smoke tests run separately in CI.

These checks do not establish that every managed Claude Desktop installation permits custom extensions, that every Code organization permits development channels, or that every provider quota reset will expose the same fields. Actual host UI installation, consent, organizational policy, login, and availability remain host-specific. Unknown reset times remain paused for manual recovery.

This project does not claim an OS sandbox, exactly-once external tool effects, or a way to bypass subscription limits. Consult [security boundaries](../SECURITY.md) and [operations](operations.md).
