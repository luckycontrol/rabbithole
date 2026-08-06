# Notes for agents working in this repo

If you were sent here to **install** Rabbithole for a user, stop — you don't
need to clone or build anything. Follow the Quick start in [README.md](./README.md)
(one `claude mcp add` / `codex mcp add` line). This file is for agents
**developing** the repo.

## Agent execution

Work directly in the current agent process. Do not launch or delegate work to
subagents, agent teams, multi-agent workflows, or background agents. Perform all
repository exploration, planning, implementation, and review yourself.

## What this is

An MCP server (stdio) that opens a branching-document canvas in the browser.
Plain ES modules, a small esbuild-based browser build, and script-driven tests.

- `bin/mcp-server.js` — entry; just imports `src/node/mcp/server.js`
- `src/core/` — host-independent document engine, renderer, artifacts, and
  contracts
- `src/ui/` — browser runtime shared by live pages and frozen snapshots
- `src/node/` — MCP wiring (server name `rabbithole`), filesystem storage,
  sessions, local HTTP/SSE transport, and Node PDF ingestion
- `src/web/` — static BYOK browser host, provider adapters, and IndexedDB store
- `src/core/html/` — shared self-contained shell, tokens, and stylesheet source
- `src/core/html/icons.js` — canonical repository for all product-owned SVG icons and brand marks
- `dist/` — committed live and frozen UI bundles; regenerate after UI changes
- `test/` — capability-oriented suites documented in `docs/testing.md`
- `website/public/` — live public assets copied by `build:publish`

## Run / debug

```bash
npm install
RABBITHOLE_NO_BROWSER=1 node bin/mcp-server.js   # speaks MCP on stdio
npm run build                                    # regenerate committed bundles
npm test                                         # deterministic default suite
```

Storage is JSON files under `~/.rabbithole/` (`RABBITHOLE_DIR` overrides).
Logs go to stderr — stdout is reserved for the MCP protocol; never print to
stdout.

## Test execution policy

Do not run tests unless the user explicitly asks for tests in their current
request. An implementation request by itself does not authorize test execution.
This applies to focused tests, test suites, packaging tests, performance tests,
and live-provider evaluations.

Tests may still be added or updated when a change requires coverage, but leave
them unexecuted and state that clearly in the final report. Builds and static
verification commands remain allowed; do not treat them as permission to run
tests.

## Development workflow

For every code change that adds, modifies, or removes Rabbithole functionality:

1. Before editing code, create a dedicated Git branch and worktree. Do not make
   the implementation changes directly in the primary worktree or on `main`.
2. Make and verify all implementation changes in that dedicated worktree.
3. When the work is complete, commit the changes on the worktree branch and
   merge that branch into `main`.
4. After confirming that the merge into `main` succeeded, remove the dedicated
   worktree and delete its branch.

## Conventions

- The product name is **Rabbithole** — one word, no space, in all copy.
- Node ≥ 18, ES modules everywhere.
- The canvas page must stay fully self-contained (one HTML response, no
  external assets) — that constraint is load-bearing for export/snapshots.
- stdout is reserved for MCP protocol messages; application logs go to stderr.
- Preserve old `.rabbithole` files and snapshots according to
  `docs/compatibility.md`; future formats must fail clearly rather than truncate.
- Put every product-owned SVG icon or brand mark in `src/core/html/icons.js` and
  render it with `iconSvg()`. Do not add inline icon geometry to shell, UI, web,
  settings, or website files. Structural/document SVG (for example the canvas
  edge layer or user-authored content) is not an icon and remains at its owning
  trust boundary.
