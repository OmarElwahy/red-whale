import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { exportFilename, graphPng, PNG_OPTIONS } from '../src/graph/export';
import { EXPORT_JSON_URL, ExportButtons, type ExportButtonsProps } from '../src/graph/ExportButtons';
import { COLORS } from '../src/graph/style';

describe('graphPng', () => {
  test('the full graph (not just the viewport), on the dark canvas color, as a blob', () => {
    const blob = new Blob(['png'], { type: 'image/png' });
    const png = vi.fn(() => blob);
    expect(graphPng({ png })).toBe(blob);
    expect(png).toHaveBeenCalledWith(PNG_OPTIONS);
    expect(PNG_OPTIONS).toMatchObject({ output: 'blob', full: true, bg: COLORS.canvas });
    expect(PNG_OPTIONS.maxWidth).toBeLessThanOrEqual(8192);
  });

  test('file names are UTC timestamps without colons', () => {
    expect(exportFilename('graph', 'png', new Date('2026-10-30T12:34:56.789Z'))).toBe(
      'redwhale-graph-2026-10-30T12-34-56Z.png',
    );
  });
});

describe('ExportButtons', () => {
  function renderButtons(props: Partial<ExportButtonsProps> = {}) {
    const download = vi.fn<NonNullable<ExportButtonsProps['download']>>();
    const blob = new Blob(['png'], { type: 'image/png' });
    const png = vi.fn<ExportButtonsProps['png']>(() => blob);
    render(<ExportButtons png={png} pngDisabled={false} download={download} {...props} />);
    return { download, png, blob };
  }

  test('JSON is a plain download of GET /api/export', () => {
    renderButtons();
    const link = screen.getByRole('link', { name: 'Export JSON' });
    expect(link.getAttribute('href')).toBe(EXPORT_JSON_URL);
    expect(EXPORT_JSON_URL).toBe('/api/export?format=json');
    expect(link.hasAttribute('download')).toBe(true);
  });

  test('PNG renders the canvas and downloads it with a timestamped name', () => {
    const { download, png, blob } = renderButtons();
    fireEvent.click(screen.getByRole('button', { name: 'Export PNG' }));
    expect(png).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledWith(blob, expect.stringMatching(/^redwhale-graph-[\dT-]+Z\.png$/));
  });

  test('PNG is disabled when there is no graph on screen', () => {
    renderButtons({ pngDisabled: true });
    expect(screen.getByRole('button', { name: 'Export PNG' }).hasAttribute('disabled')).toBe(true);
  });

  test('a failed render says why instead of failing silently', () => {
    const { download } = renderButtons({
      png: () => {
        throw new Error('canvas too large');
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Export PNG' }));
    expect(screen.getByRole('alert').textContent).toBe('PNG export failed: canvas too large');
    expect(download).not.toHaveBeenCalled();
  });
});
