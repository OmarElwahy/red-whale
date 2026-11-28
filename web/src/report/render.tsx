// The report's Markdown, rendered the same way in the dialog's preview and in the HTML export. The draft holds tool
// text from target pages, so: no raw HTML (react-markdown's default), link URLs through react-markdown's safe
// transform (no javascript:), and images drawn as their alt text, so nothing loads from another host.
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown, { type Components } from 'react-markdown';

const components: Components = {
  // The safe transform empties an unsafe URL (javascript:, data:…): then it's text, not a link to nowhere.
  a: ({ href, children }) =>
    href === undefined || href === '' ? (
      <span>{children}</span>
    ) : (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
  img: ({ alt }) => <span className="report-img">{alt === undefined || alt === '' ? '[image]' : `[image: ${alt}]`}</span>,
};

export function ReportMarkdown({ children }: { children: string }): ReactNode {
  return <Markdown components={components}>{children}</Markdown>;
}

/** The five characters that matter in HTML text and attributes. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}

/** Inline, system fonts only; prints cleanly to PDF. */
const STYLE = `
:root { color-scheme: light; }
body { margin: 0; background: #fff; color: #1a1a1a;
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; overflow-wrap: anywhere; }
h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 1.25rem; }
h2 { font-size: 1.15rem; margin: 1.75rem 0 0.5rem; padding-bottom: 0.25rem; border-bottom: 1px solid #ddd; }
h3 { font-size: 1rem; margin: 1.25rem 0 0.4rem; }
p, ul, ol, pre, blockquote { margin: 0.5rem 0; }
ul, ol { padding-left: 1.5rem; }
a { color: #0b5cad; }
code { font: 0.9em ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  background: #f3f3f3; border-radius: 3px; padding: 0.05em 0.3em; }
pre { background: #f6f6f6; border: 1px solid #e2e2e2; border-radius: 4px; padding: 0.6rem 0.75rem;
  overflow-x: auto; white-space: pre-wrap; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #ccc; padding-left: 0.75rem; color: #555; }
hr { border: 0; border-top: 1px solid #ddd; margin: 2rem 0 1rem; }
.report-img { color: #777; font-style: italic; }
@media print { main { padding: 0; max-width: none; } a { color: inherit; } }
`;

/**
 * One self-contained page: the rendered Markdown, inline CSS, no script, no remote font or image. The CSP meta is a
 * second guard: nothing may load or run even if something slipped through the renderer.
 */
export function reportHtml(markdown: string, title: string): string {
  const body = renderToStaticMarkup(<ReportMarkdown>{markdown}</ReportMarkdown>);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    `<main>${body}</main>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
