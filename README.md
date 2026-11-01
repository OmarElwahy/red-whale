# RED WHALE

Local, open-source reconnaissance framework. Tool findings become an interactive correlation graph.

## What's in this folder

| Path | What |
|---|---|
| `CLAUDE.md` | Instructions Claude Code reads automatically every session |
| `docs/architecture.md` | Design, DB schema, API, graph UI, and the phase-by-phase build plan |
| `docs/contract.md` | The JSON format every tool script must output |
| `docs/team-guide.md` | Send this to teammates: how to write a tool script + template |
| `docs/features.md` | Full product feature list |
| `contract/examples/` | Valid sample outputs (subfinder, nmap, httpx, nuclei) — also test fixtures |
| `tools/validate_output.py` | Validator for tool-script output (no dependencies) |

## Prerequisites

- Node.js 20+ and pnpm (`npm install -g pnpm`)
- Python 3.10+
- Git
- Claude Code
- On Windows: work inside WSL2 (Ubuntu) for fewer problems with native modules like better-sqlite3

## Start building with Claude Code

```bash
cd red-whale
git init && git add -A && git commit -m "Project docs and contract"
claude
```

Then paste this as your first message:

> Read CLAUDE.md, docs/architecture.md and docs/contract.md. We're starting **Phase 1**.
> Enter plan mode and propose a plan for Phase 1 steps 1–3: the folder/file structure, the packages
> you'll install with versions, and the test cases you'll write for the contract schema and for
> normalization/node IDs. Don't write code until I approve the plan.

After each phase: review the diff, run `pnpm typecheck && pnpm test`, commit, then start the next phase with
"Start Phase N per docs/architecture.md, plan first."

## Check a teammate's output

```bash
python3 tools/validate_output.py path/to/their_output.json
```

## Third-party

- **Lucide icons** (`lucide-static` 1.59.0, [ISC License](https://lucide.dev/license), © Lucide Icons and Contributors):
  the node-type icons on the graph. Only the 11 icons we use are bundled, inlined into the app
  (`web/src/graph/icons.ts`); nothing is loaded from a CDN. Four of them (`at-sign`, `link`, `lock`, `server`)
  come from the Feather project (MIT License, © 2013-present Cole Bemis). The full license text ships in
  `web/node_modules/lucide-static/LICENSE`.
