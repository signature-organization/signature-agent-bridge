# Verification and release evidence

[README](../README.md) · [Compatibility](compatibility.md) · [Contributing](../CONTRIBUTING.md)

## Automated checks

`npm run check` runs strict TypeScript checking, ESLint, formatting, unit/integration tests, real Python SDK compatibility tests, browser interaction tests, bundled build, repository/contract checks, native packaging, and a clean-directory native MCP smoke test.

Coverage includes transactional admission and idempotency, principal isolation and token revocation, SSE replay and expired cursors, process bounds and cancellation, durable quota gates, workflow checkpoints, template persistence, paused follow-up ordering, host claim fencing, and daemon discovery.

The Chromium suite exercises jobs, follow-ups, pause/resume, workflow steps, template validation and execution, token creation/revocation, navigation, dialogs, and layouts from 320 to 1440 pixels. Documentation screenshots use deterministic fixtures, not production customer data.

## Live Claude Code check

On September 24, 2026, the explicit live smoke test passed on macOS arm64 using official Claude Code 2.1.260 with the user's own Claude.ai subscription login:

- Native bypass executed Write and Read without worker approval prompts.
- A follow-up continued the same native session and created a second file.
- A configured native subagent ran and its task events reached the bridge.

The test uses stdin for prompts. It does not extract credentials, alter the Claude client, or call a private provider endpoint.

## OpenAI and Pydantic AI clients

On September 24, 2026, seven real-client cases passed against official Claude Code 2.1.260 on macOS arm64, using OpenAI Python SDK 3.19.2 and Pydantic AI 2.49.0:

- Model discovery and text completion.
- OpenAI SSE completion and Pydantic AI streamed output.
- A client-side Python function executed exactly once, with its result returned on the next model turn.
- Typed Pydantic output using output functions and native JSON Schema output.
- SDK authentication and unsupported-parameter errors.

The same seven cases run in CI over real HTTP with a deterministic worker, so CI does not consume a subscription. Worker tests separately verify disabled native tools for inference, native structured-output validation, observed usage, and the draft-07 envelope accepted by Claude. HTTP tests cover idempotency, disconnects, cancellation, quota gates, revocation, deadlines, malformed output, and shutdown.

Run `BRIDGE_LIVE_TEST=1 npm run test:clients` with `BRIDGE_PYTHON` pointing to an interpreter containing the pinned test dependencies to repeat the live check. Results describe the tested versions and login, not a guarantee of every provider response.

## Native Code plugin installation

The official Claude Code CLI successfully added this public GitHub marketplace and installed `signature-agent-bridge@signature-organization` into an isolated local configuration. Both the marketplace and plugin metadata passed the official plugin validator. The installed plugin exposed its configured MCP server and skill.

## What remains host-specific

The MCPB manifest and archive are validated with Anthropic's official tooling. The packaged native executable is tested through a real stdio MCP client in a clean working directory. Platform builds and package smoke tests run separately in CI.

These checks do not establish that every managed Claude Desktop installation permits custom extensions, that every Code organization permits development channels, or that every provider quota reset will expose the same fields. Actual host UI installation, consent, organizational policy, login, and availability remain host-specific. Unknown reset times remain paused for manual recovery.

This project does not claim an OS sandbox, exactly-once external tool effects, or a way to bypass subscription limits. Consult [security boundaries](../SECURITY.md) and [operations](operations.md).
