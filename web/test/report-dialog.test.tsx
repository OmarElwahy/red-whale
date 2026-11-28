// The bug-report dialog (draft, live preview, close/reset prompts, downloads, copy), the HTML export's safety,
// the file name, and the "Create report…" menu item.
import { nodeReportSchema, type NodeReport } from '@redwhale/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { menuItems, type MenuContext } from '../src/menu/items';
import { ReportDialog, titleOf } from '../src/report/ReportDialog';
import { reportFilename, safeLabel } from '../src/report/file';
import { printHtml } from '../src/report/print';
import { reportHtml } from '../src/report/render';
import { node } from './fixtures';

const ID = '00000000000000b1';
const NOW = new Date('2026-11-28T12:34:56.000Z');

function draft(markdown = '# Git config on https://app.northwind.example/\n\n## Severity\n\n**Medium**\n', over: Partial<NodeReport> = {}): NodeReport {
  return nodeReportSchema.parse({
    nodeId: ID,
    type: 'vulnerability',
    label: 'git-config',
    title: 'Git config on https://app.northwind.example/',
    markdown,
    generatedAt: '2026-11-28T12:00:00.000Z',
    ...over,
  });
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** GET report → `drafts` in turn (the last one repeats). */
function stubApi(...drafts: (NodeReport | Response)[]) {
  let i = 0;
  const fetch = vi.fn((url: string) => {
    if (url === `/api/nodes/${ID}/report`) {
      const d = drafts[Math.min(i++, drafts.length - 1)];
      return Promise.resolve(d instanceof Response ? d : json(d));
    }
    return Promise.resolve(json({ error: 'not found' }, 404));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function open() {
  const onClose = vi.fn();
  const print = vi.fn<(html: string) => void>();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ReportDialog nodeId={ID} onClose={onClose} now={() => NOW} print={print} />
    </QueryClientProvider>,
  );
  return { onClose, print };
}

const editor = () => screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Report Markdown' });
const preview = () => screen.getByRole('region', { name: 'Preview' });
/** The preview renders a deferred copy of the text, so it can lag a render behind the editor. */
async function filledPreview(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(preview().textContent).not.toBe('');
  });
  return preview();
}

/** Captures what downloadBlob saves. */
function captureDownloads() {
  const saved: { name: string; blob: Blob }[] = [];
  const blobs = new Map<string, Blob>();
  vi.stubGlobal('URL', Object.assign(globalThis.URL, {
    createObjectURL: vi.fn((b: Blob) => {
      const url = `blob:${String(blobs.size)}`;
      blobs.set(url, b);
      return url;
    }),
    revokeObjectURL: vi.fn(),
  }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.getAttribute('href') ?? '');
    if (blob) saved.push({ name: this.download, blob });
  });
  return saved;
}

beforeEach(() => {
  stubApi(draft());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ReportDialog', () => {
  test("the server's draft fills the editor, and the preview follows edits", async () => {
    open();
    const box = await editor();
    expect(box.value).toContain('## Severity');
    expect(screen.getByRole('heading', { level: 2, name: 'Report: git-config' })).toBeTruthy();
    expect(within(await filledPreview()).getByRole('heading', { level: 1 }).textContent).toBe('Git config on https://app.northwind.example/');
    fireEvent.change(box, { target: { value: '# Edited title\n\nSome *text*.' } });
    await waitFor(() => {
      expect(within(preview()).getByRole('heading', { level: 1 }).textContent).toBe('Edited title');
    });
    expect(within(preview()).getByText('text').tagName).toBe('EM');
  });

  test('closing without edits closes at once (✕, Escape)', async () => {
    const { onClose } = open();
    await editor();
    fireEvent.click(screen.getByRole('button', { name: 'Close report' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('closing with edits asks first: Keep editing stays, Close anyway closes', async () => {
    const { onClose } = open();
    fireEvent.change(await editor(), { target: { value: 'changed' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('alert').textContent).toContain("Your edits aren't saved anywhere. Close anyway?");
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect((await editor()).value).toBe('changed');

    fireEvent.click(screen.getByRole('button', { name: 'Close report' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close anyway' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a download still counts as unsaved: closing after it asks', async () => {
    captureDownloads();
    const { onClose } = open();
    fireEvent.change(await editor(), { target: { value: 'changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download .md' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close report' }));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('Reset to fresh draft refetches; with edits it asks first', async () => {
    const fetch = stubApi(draft('first'), draft('second'));
    open();
    const box = await editor();
    expect(box.value).toBe('first');
    fireEvent.change(box, { target: { value: 'mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset to fresh draft' }));
    expect(screen.getByRole('alert').textContent).toContain('A fresh draft replaces your edits.');
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reset anyway' }));
    await waitFor(() => {
      expect(box.value).toBe('second');
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('Download .md saves the edited text with the label and UTC time in the name', async () => {
    const saved = captureDownloads();
    open();
    fireEvent.change(await editor(), { target: { value: '# Mine\n\nedited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download .md' }));
    expect(saved.map((s) => s.name)).toEqual(['redwhale-report-git-config-2026-11-28T12-34-56Z.md']);
    expect(saved[0]?.blob.type).toBe('text/markdown;charset=utf-8');
    expect(await saved[0]?.blob.text()).toBe('# Mine\n\nedited');
  });

  test('Download .html saves one self-contained page of the edited text', async () => {
    const saved = captureDownloads();
    open();
    fireEvent.change(await editor(), { target: { value: '# Mine & yours\n\nedited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download .html' }));
    expect(saved.map((s) => s.name)).toEqual(['redwhale-report-git-config-2026-11-28T12-34-56Z.html']);
    expect(saved[0]?.blob.type).toBe('text/html;charset=utf-8');
    const html = (await saved[0]?.blob.text()) ?? '';
    expect(html).toContain('<title>Mine &#38; yours</title>');
    expect(html).toContain('<h1>Mine &amp; yours</h1>');
    expect(html).not.toMatch(/<script|<link|@import|url\(|https?:\/\/fonts/i);
  });

  test('Save as PDF… prints the edited page, titled with the file name, and says what to pick', async () => {
    const { print } = open();
    fireEvent.change(await editor(), { target: { value: '# Mine\n\nedited <b>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as PDF…' }));
    expect(print).toHaveBeenCalledTimes(1);
    const html = print.mock.calls[0]?.[0] ?? '';
    expect(html).toContain('<title>redwhale-report-git-config-2026-11-28T12-34-56Z</title>');
    expect(html).toContain('<h1>Mine</h1>');
    expect(html).toContain('edited &lt;b&gt;');
    expect(html).toContain("default-src 'none'");
    expect(screen.getByRole('status').textContent).toBe('In the print dialog, pick "Save as PDF" as the destination.');
  });

  test('Copy puts the Markdown on the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    open();
    fireEvent.change(await editor(), { target: { value: 'copy me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('copy me');
    expect(await screen.findByText('Copied the Markdown.')).toBeTruthy();
  });

  test('a failed draft says why; nothing to download', async () => {
    stubApi(json({ error: 'reports are for vulnerability, secret, leak nodes' }, 400));
    open();
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't build the report");
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Download .md' }).disabled).toBe(true);
  });

  test('hostile Markdown in the preview: no HTML, no image, no javascript: link', async () => {
    stubApi(draft('<script>window.pwned = 1</script>\n\n<img src="http://evil.example/x.png">\n\n![alt text](http://evil.example/y.png)\n\n[click](javascript:alert(1))'));
    open();
    await editor();
    const p = await filledPreview();
    expect(p.querySelector('script, img, iframe')).toBeNull();
    expect(p.textContent).toContain('<script>window.pwned = 1</script>');
    expect(p.textContent).toContain('[image: alt text]');
    expect(within(p).getByText('click').tagName).toBe('SPAN');
    expect(p.querySelector('a')).toBeNull();
  });
});

describe('reportHtml', () => {
  test('escapes raw HTML, draws images as text, drops javascript: links, has a CSP and no remote loads', () => {
    const html = reportHtml(
      '# Hi\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n![a](http://evil.example/p.png)\n\n[x](javascript:alert(1))\n\n<https://ok.example/a>',
      '</title><script>alert(1)</script>',
    );
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"`);
    expect(html).toContain('<title>&#60;/title&#62;&#60;script&#62;alert(1)&#60;/script&#62;</title>');
    expect(html).not.toMatch(/<script|<img|<iframe|javascript:/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('[image: a]');
    expect(html).toContain('<a href="https://ok.example/a" target="_blank" rel="noopener noreferrer">');
    // No tag loads anything (the escaped `&lt;img src=x` above is text).
    expect(html).not.toMatch(/<[a-z]+[^>]*\s(src|srcset|href)=["'](?!https:\/\/ok\.example)/i);
    expect(html).not.toMatch(/<link|@import|url\(/i);
  });
});

describe('printHtml', () => {
  const frames = () => document.querySelectorAll<HTMLIFrameElement>('iframe#redwhale-report-print');

  test('a hidden frame that runs no script holds the page; it prints on load and goes away after', () => {
    printHtml('<!doctype html><title>t</title><p>hi</p>');
    const [frame] = frames();
    if (!frame) throw new Error('no frame');
    expect(frame.getAttribute('sandbox')).toBe('allow-modals allow-same-origin');
    expect(frame.srcdoc).toContain('<p>hi</p>');
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    const win = frame.contentWindow;
    if (!win) throw new Error('no window');
    const print = vi.spyOn(win, 'print').mockImplementation(() => undefined);
    frame.dispatchEvent(new Event('load'));
    expect(print).toHaveBeenCalledTimes(1);
    win.dispatchEvent(new Event('afterprint'));
    expect(frames()).toHaveLength(0);
  });

  test('a second print replaces a frame still waiting', () => {
    printHtml('<p>one</p>');
    printHtml('<p>two</p>');
    expect([...frames()].map((f) => f.srcdoc)).toEqual(['<p>two</p>']);
    frames()[0]?.remove();
  });
});

describe('file names and title', () => {
  test('the label in safe characters, then UTC without colons', () => {
    expect(reportFilename('CVE-2021-41773', 'md', NOW)).toBe('redwhale-report-CVE-2021-41773-2026-11-28T12-34-56Z.md');
    expect(safeLabel('AWS access key in /static/app.js')).toBe('AWS-access-key-in-static-app.js');
    expect(safeLabel('../../etc/passwd')).toBe('etc-passwd');
    expect(safeLabel('<>:"|?*')).toBe('node');
    expect(safeLabel('a'.repeat(100))).toHaveLength(60);
  });

  test('the HTML title is the first heading as plain text, else the fallback', () => {
    expect(titleOf('intro\n# Git \\<config\\> on x\n## more', 'fb')).toBe('Git <config> on x');
    expect(titleOf('no heading', 'fb')).toBe('fb');
  });
});

describe('menu', () => {
  const ctx: MenuContext = { group: undefined, canExpandNeighbors: true, hasRoom: true };
  test('"Create report…" only on vulnerability, secret and leak nodes', () => {
    const has = (type: Parameters<typeof node>[1] extends infer O ? O : never) =>
      menuItems(node('n', type), ctx).some((i) => i.action === 'report' && i.label === 'Create report…');
    expect(has({ type: 'vulnerability' })).toBe(true);
    expect(has({ type: 'secret' })).toBe(true);
    expect(has({ type: 'leak' })).toBe(true);
    expect(has({ type: 'url' })).toBe(false);
    expect(has({ type: 'subdomain' })).toBe(false);
  });
});
