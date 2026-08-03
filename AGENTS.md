# Notes for agents working in this repo

If you were sent here to **install** Rabbithole for a user, stop — you don't
need to clone or build anything. Follow the Quick start in [README.md](./README.md)
(one `claude mcp add` / `codex mcp add` line). This file is for agents
**developing** the repo.

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

## Workflow

For any feature addition, removal, or modification, the implementation work
must be performed by a **subagent** in a dedicated **git worktree**. The main
agent coordinates the task, reviews the subagent's changes, runs verification,
and integrates the result; it must not directly edit the implementation for
that task.

Always work in a **git worktree** — never edit directly on `main`:

1. Create a worktree on a new branch before making changes
   (`git worktree add ../rabbithole-<topic> -b <topic>`).
2. Create a dedicated pane for the subagent in tmux session `rabbithole`,
   window `0`, and start the subagent from the new worktree:
   ```bash
   tmux split-window -t rabbithole:0 -c <absolute-worktree-path>
   ```
   Do not substitute another session or window. If `rabbithole:0` is not
   available, stop and report the environment issue before editing files.
3. Run the subagent in that pane with model **GPT-5.6-luna** and
   `reasoning_effort=max`. For the Codex CLI, use the installed CLI's
   equivalent of:
   ```bash
   codex -C <absolute-worktree-path> -m gpt-5.6-luna -c 'model_reasoning_effort="max"'
   ```
4. Give the subagent the implementation task and require it to make all
   changes, tests, and the commit inside the dedicated worktree. After
   committing, the subagent reports the commit hash and stops; it must not
   merge, push, or remove the worktree.
5. The main agent reviews the subagent's diff and test results, then merges the
   branch back into `main`.
6. The main agent pushes the updated `main` branch to its configured upstream
   and verifies that the push succeeds.
7. Only the main agent, and only after the push succeeds, removes the worktree
   (`git worktree remove ../rabbithole-<topic>`) and deletes the branch.

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
