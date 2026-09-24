# Compatibility and support boundaries

[README](../README.md) · [Installation](installation.md)

| Surface                            | Integration                                      | Execution                                                               |
| ---------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| Claude Desktop on macOS/Windows    | Native binary MCPB extension                     | Dedicated official Claude Code worker using the user's own subscription |
| Claude Code on macOS/Linux/Windows | Native plugin marketplace, MCP server, and skill | Same local worker and queue                                             |
| Code channel preview               | Explicitly enrolled stdio MCP channel            | Work claimed in the current host conversation                           |
| Local applications                 | Authenticated HTTP REST and SSE                  | Profile-controlled queued work                                          |
| HTTPS tunnel callers               | Same API behind a configured tunnel              | Same local service and trust boundary                                   |

Minimum supported Claude Code version: **2.1.260**. The worker preserves official login and uses native bypass. It does not support API-key mode or third-party provider billing.

Source runtime: Node.js 24+. Native release builder/runtime: official Node.js 26.3.0. Release artifacts target macOS arm64/x64, Linux arm64/x64, and Windows x64. Desktop bundles are produced only for macOS and Windows.

Intel Mac packages contain an executable launcher beside the unmodified official runtime and bundled application. This avoids a reproduced startup crash in the pinned runtime's Intel single-executable output. Other platforms use single-executable builds. All release packages are self-contained; keep portable folders intact.

Claude Desktop installation consent, managed extension allowlists, Code workspace/plugin consent, and channel preview enrollment remain host-controlled.

The project does not expose a headless API for the Desktop chat UI. Desktop is a native startup/management surface; automatic jobs run through the locally installed official Claude Code executable. For conversation-owned channel work, Desktop can inspect and claim jobs with tools, but automatic Code-channel notifications are not a Desktop MCP feature.

Subscription capabilities can change. Consult [Anthropic's current Claude-plan guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) and [Claude Code compliance guidance](https://code.claude.com/docs/en/legal-and-compliance). Each user keeps their own account and bridge instance.

See the [verification record](verification.md) for what was tested and what requires a host-specific acceptance check.
