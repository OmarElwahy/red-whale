// Export (docs/architecture.md §8): the whole workspace as JSON (GET /api/export, a plain download), and the
// graph on the canvas as a PNG (cy.png(), via the wrapper's handle).
import { useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { downloadBlob, exportFilename } from './export';

export const EXPORT_JSON_URL = '/api/export?format=json';

export interface ExportButtonsProps {
  /** Renders the PNG, or null when there's no canvas. */
  png: () => Blob | null;
  /** No graph on screen (empty workspace, error): nothing to draw. */
  pngDisabled: boolean;
  /** Injected in tests. */
  download?: (blob: Blob, filename: string) => void;
}

export function ExportButtons({ png, pngDisabled, download = downloadBlob }: ExportButtonsProps) {
  const [error, setError] = useState<string | null>(null);
  const exportPng = () => {
    try {
      const blob = png();
      if (blob === null) throw new Error('the graph is not drawn yet');
      download(blob, exportFilename('graph', 'png'));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <a
        href={EXPORT_JSON_URL}
        download
        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        title="Every node, edge, scan and observation in the workspace, whatever the filters show"
      >
        Export JSON
      </a>
      <Button
        size="sm"
        variant="ghost"
        disabled={pngDisabled}
        title="The whole graph on the canvas (not just the part in view), as it looks now"
        onClick={exportPng}
      >
        Export PNG
      </Button>
      {error !== null && (
        <span role="alert" className="text-xs text-red-400">
          PNG export failed: {error}
        </span>
      )}
    </>
  );
}
