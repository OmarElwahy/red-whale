# Bug report progress: "Create report…" for a finding node

Branch `phase-bugreport`, cut from `main` (`5a57121`, after phase-graphfix was merged). Started 2026-11-28.

Goal: right-click a vulnerability, secret or leak node ▸ "Create report…" (also a side-panel button) opens a dialog
with a bug-bounty style draft in editable Markdown with a live preview: Download .md, Download .html, Copy.
Not in scope: reports over many nodes (6F), PDF (the HTML prints to PDF), AI-written text, sending anywhere, new DB
tables.

## Steps

| # | Step | Status |
|---|---|---|
| 1 | Report builder + `GET /api/nodes/:id/report` + tests | done |
| 2 | Dialog + menu/panel buttons + downloads + web-dom tests | done |
| 3 | Docs (§6/§8/§13, handoff) + manual checklist | next |

## Decisions (user, 2026-11-28: all recommended answers)

1. **Several parents** (nuclei: one node per template, on many URLs): Affected asset is the shortest path from a
   root (breadth-first up the incoming edges, parents in value order), over the whole database, not the view's
   filters. Every other direct parent is listed under "Also affects" with its own path, at most 20, then "…and N more".
2. **Description**: `data.description`, else the name (`data.name`, else the label) with the type and value; then
   template, CVEs and tags. Data keys no section shows go under Evidence ▸ Other data, so nothing is dropped.
3. **Steps to reproduce** use `finding` observations only (a `parent` row isn't the tool finding it).
4. **Closing with edits** always asks, also after a download or copy ("Your edits aren't saved anywhere").
5. **Live updates** never touch the editor; "Reset to fresh draft" refetches (asks first if there are edits).
6. **Severity** is the node's own (not the effective one), plus `cvss` (a score, a vector string, or
   `{ score, vector }`).
7. **Copy** copies the Markdown.

Step 1 details:
- `shared/src/api.ts`: `REPORT_NODE_TYPES`, `isReportNodeType`, `nodeReportSchema`
  (`nodeId, type, label, title, markdown, generatedAt`). `title` is plain text for the HTML `<title>`.
- `server/src/report/build.ts`: `buildReport` (pure), `pathToRoot`, `nodeReport`. Route in `routes/report.ts`:
  404 for no node, 400 for other types.
- Escaping: tool text folds line breaks and backslash-escapes ``\ ` * _ [ ] < > & ~ |`` anywhere. Where a value
  starts a line or a list item, a leading `# + = -` or `1.`/`1)` is escaped too. `.`, `/`, `:` and mid-line `-` are
  left alone so the `.md` stays readable. Commands and extracted values go in fences longer than any backtick run.
  References are autolinks only for http(s) URLs (WHATWG-serialized), else escaped text.
- Extracted values are shown as stored (the tool masked them). The report lists the job IDs whose raw output holds
  the rest; a scan from an uploaded file says "Ingested from a file: scan …". The builder never reads raw output.
- Analyst notes go in as the analyst's own Markdown.

Step 2 details:
- `web/src/report/ReportDialog.tsx`: the draft is fetched once (query key `['report', id]`, outside `['api', …]`,
  so a live update's invalidation doesn't refetch it; `staleTime: Infinity`). The first draft is taken while
  rendering (React's state-from-props pattern; the lint rule forbids setState in an effect). Close (✕, Escape,
  backdrop) and Reset show an in-dialog confirm strip when the text differs from the draft. The preview renders a
  `useDeferredValue` copy of the text.
- `web/src/report/render.tsx`: one renderer for preview and HTML: react-markdown (no raw HTML), images as
  `[image: alt]` text, a link whose URL the safe transform emptied (`javascript:` etc.) as plain text. `reportHtml`
  is `renderToStaticMarkup` in one page: inline CSS, system fonts, no script, CSP meta
  (`default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`), `no-referrer`, the
  `<title>` HTML-escaped. The page title is the edited text's first `# ` heading (escapes undone), else the server's.
- `web/src/report/file.ts`: `redwhale-report-<label: [A-Za-z0-9._-], runs → "-", ≤ 60, trimmed; else "node">-<UTC>Z`.
  `fileTimestamp` moved into `graph/export.ts` (shared with the PNG name).
- Menu: `'report'` ("Create report…", after Run tool) for vulnerability, secret and leak. Side panel: a "Create
  report" button under Details for the same types. `App.tsx` holds `reporting`.
- Builder polish after a look in the app: "A leak: X." when the name is the value; a list of plain values in
  Other data reads `a, b` (nested data stays JSON).
- Checked on a scratch copy (mock showcase DB, API on 4101, Vite on 5174): right-click a leak ▸ Create report…,
  the draft and preview, an edit then Escape shows the prompt. `vite build` bundles `react-dom/server` fine (the
  existing >500 kB chunk warning is unchanged in kind).

## Next action

Step 3: docs. Architecture §6 (route row), §8 (menu item, panel button, dialog, HTML export), §13 (decisions of
2026-11-28 above), `docs/handoff.md` (Status, decisions), and the manual checklist below in this file.
