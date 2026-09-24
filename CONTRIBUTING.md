# Contributing

Thank you for contributing to Signature Agent Bridge. Explain the problem and the behavior your change should provide before opening a large pull request.

## Set up

Use an official Node.js 26.3.0 distribution for the native packaging checks. Runtime source supports Node 24 or later; Node 26 supplies the single-executable builder.

```sh
npm ci
npx playwright install chromium
npm run check
```

On Linux CI, use `npx playwright install --with-deps chromium`. Homebrew's Node executable may lack the SEA fuse; set `BRIDGE_SEA_NODE` to an official Node 26.3.0 binary if needed.

The Intel Mac package ships a launcher, the official runtime, and the bundled application because the pinned Intel single-executable output crashes at startup. The other platforms use SEA. Both layouts run the same clean-directory MCP package smoke test.

The normal suite uses deterministic subprocess and HTTP fixtures and does not consume a Claude subscription. A separate, explicit live check is available:

```sh
BRIDGE_LIVE_TEST=1 npm run test:live
```

That check creates temporary files using your official Claude Code login, resumes the same native session, and verifies a native subagent. It consumes your plan allowance. Native Claude session history remains in Claude's own storage.

## Change standards

- Keep queue transitions transactional and execution ownership fenced.
- Reproduce recovery, authorization, and concurrency defects with regression tests.
- Keep prompts out of shell interpolation and treat model output as untrusted text.
- Preserve scoped bearer authentication, loopback binding, and explicit tunnel allowlists.
- Comment the rationale behind non-obvious behavior. Use American English.
- Update API documentation, integration metadata, screenshots, and compatibility notes when behavior changes.

Each original source file starts with the existing full Apache-2.0 notice, company copyright, and an author line identifying its actual contributors. Add your GitHub handle when contributing; do not remove prior authors. JSON uses a matching `.license` sidecar because JSON does not support comments. Upstream license texts retain their original attribution.

Use neutral branches such as `feat/template-validation` or `fix/session-resume`. Keep local plans, agent instructions, credentials, workspaces, logs, database files, dependency trees, and release output out of commits.

## Visual and release checks

`UPDATE_SCREENSHOTS=1 npm run test:browser` refreshes the documented console screenshots. `npm run render:diagrams` refreshes PNG copies of the editable SVG diagrams. These documentation images are intentionally versioned.

Releases use the platform matrix in GitHub Actions. Verify all packages, download the artifacts, and publish them together with one combined `SHA256SUMS`. Version numbers in package metadata, CLI, manifests, marketplace, and bootstrap must agree. The bootstrap pins a release rather than executing a floating branch.

Report vulnerabilities through the process in [SECURITY.md](SECURITY.md).
