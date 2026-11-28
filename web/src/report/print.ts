// "Save as PDF…": the browser's print dialog on the report's HTML page, where the analyst picks "Save as PDF" (no PDF
// library: the PDF looks exactly like the .html, in any language). The page goes in a hidden iframe that runs no
// script (sandbox without allow-scripts; allow-modals lets print() open, allow-same-origin lets us call it).
// Chrome and Edge suggest the page's <title> as the file name.

const FRAME_ID = 'redwhale-report-print';

export function printHtml(html: string, doc: Document = document): void {
  doc.getElementById(FRAME_ID)?.remove();
  const frame = doc.createElement('iframe');
  frame.id = FRAME_ID;
  frame.title = 'Report for printing';
  frame.setAttribute('sandbox', 'allow-modals allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // Off screen but laid out: some browsers print a `display: none` or zero-size frame blank.
  Object.assign(frame.style, { position: 'fixed', left: '-10000px', top: '0', width: '800px', height: '600px', border: '0' });
  frame.addEventListener(
    'load',
    () => {
      const win = frame.contentWindow;
      if (!win) return;
      win.addEventListener('afterprint', () => {
        frame.remove();
      });
      win.focus();
      win.print();
    },
    { once: true },
  );
  frame.srcdoc = html;
  doc.body.appendChild(frame);
}
