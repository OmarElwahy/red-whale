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
| 2 | Dialog + menu/panel buttons + downloads + web-dom tests | next |
| 3 | Docs (§6/§8/§13, handoff) + manual checklist | |

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

## Next action

Step 2: `web/src/report/ReportDialog.tsx` (textarea + preview, Download .md/.html, Copy, close prompt, reset),
a shared renderer (react-markdown, no raw HTML, images as alt text), the HTML page (inline CSS, system fonts,
CSP meta, escaped title, `renderToStaticMarkup`), the file-name helper next to `exportFilename`, a `'report'`
menu action for the three types, a side-panel button, and web-dom tests.
