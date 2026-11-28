# Bug report progress: "Create report…" for a finding node

Branch `phase-bugreport`, cut from `main` (`5a57121`, after phase-graphfix was merged). Started 2026-11-28.

Goal: right-click a vulnerability, secret or leak node ▸ "Create report…" (also a side-panel button) opens a dialog
with a bug-bounty style draft in editable Markdown with a live preview: Download .md, Download .html, Copy; and
(step 4, asked for after step 3) Save as PDF….
Not in scope: reports over many nodes (6F), AI-written text, sending anywhere, new DB tables.

## Steps

| # | Step | Status |
|---|---|---|
| 1 | Report builder + `GET /api/nodes/:id/report` + tests | done |
| 2 | Dialog + menu/panel buttons + downloads + web-dom tests | done |
| 3 | Docs (§6/§8/§13, handoff) + manual checklist | done |
| 4 | PDF: "Save as PDF…" through the print dialog (user's choice) + tests + docs | done |

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

Step 3: architecture §6 (route row), §8 (Bug report bullet), §13 (one decision row); handoff Status row and
Key decisions.

Step 4 (user, 2026-11-28: "download it as pdf"; chose the print dialog over a one-click PDF library):
- `web/src/report/print.ts` `printHtml`: the same HTML page as Download .html in a hidden iframe (`srcdoc`,
  `sandbox="allow-modals allow-same-origin"`, so no script runs in it; off screen but laid out, since some browsers
  print a zero-size frame blank). On load it calls the frame's `print()`; `afterprint` removes the frame; a second
  click replaces a frame still waiting.
- The page `<title>` is the file name stem (`reportFileStem`), which Chrome and Edge suggest as the PDF's name.
- Checked in Chromium (the app's browser pane): in such a sandboxed `srcdoc` frame, under the report's CSP,
  `print()` runs (`beforeprint` fires, no "ignored call" warning).

## Manual checklist

On the showcase mock (`pnpm mock`, then `pnpm dev`, open http://127.0.0.1:5173). Claude Code ran 1, 2 and 5 on a
scratch copy; the rest is yours.

1. Right-click the leak `Collection1-2019` ▸ **Create report…** opens "Report: Collection1-2019" with the draft on the
   left and the rendered preview on the right.
2. Right-click a URL, a subdomain and a group: no "Create report…".
3. Click the secret `AWS access key in /static/app.js`: the side panel has **Create report** under Details; it opens
   the dialog. The preview shows `Preview (masked): AKIA****WXYZ` (escaped as `AKIA\*\*\*\*WXYZ` in the Markdown)
   and the notes under Analyst notes.
4. The verified FortiOS CVE: Severity line, Confidence `verified` in the Timeline, the notes' list rendered in
   the preview.
5. Type in the editor: the preview follows. Press Esc: "Your edits aren't saved anywhere. Close anyway?" ▸
   **Keep editing** keeps the text; ✕ ▸ **Close anyway** closes.
6. Edit, then **Reset to fresh draft** ▸ it asks; **Reset anyway** brings the server's draft back.
7. **Download .md**: a file `redwhale-report-<label>-<UTC>Z.md` with your edited text.
8. **Download .html**: open it with the network off (or DevTools ▸ Network): it renders, loads nothing, the tab title
   is the report's `#` heading.
8b. **Save as PDF…**: the print dialog opens on the report (not on the app); pick "Save as PDF". The suggested name
   is `redwhale-report-<label>-<UTC>Z.pdf`; the PDF looks like the .html (white page, code blocks wrap, links
   readable); the dialog's status line says what to pick. Try Firefox too (it names the file differently).
9. **Copy**, paste into a text editor: the Markdown.
10. Hostile text: in the editor add `<script>alert(1)</script>`, `![x](http://example.com/x.png)` and
    `[x](javascript:alert(1))`. The preview shows the script as text, `[image: x]`, and `x` as plain text (not a
    link); the same in the downloaded .html, and no alert.
11. With a real nuclei finding (a lab run, 6C-6): Steps to reproduce lists each run's command and `Matched at`, and
    Evidence names the job IDs (their raw output opens from the Jobs tab).
12. While the dialog is open, run a tool or ingest a file: the editor text doesn't change.

## Next action

The user runs the manual checklist above and merges `phase-bugreport` when satisfied. Nothing else is planned on
this branch.
