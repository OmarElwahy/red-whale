import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ContextMenu } from '../src/menu/ContextMenu';
import { menuItems } from '../src/menu/items';
import { node } from './fixtures';

function renderMenu() {
  const onAction = vi.fn();
  const onClose = vi.fn();
  const target = node('u', { type: 'url', value: 'https://a.example.com/', label: 'https://a.example.com/' });
  const items = menuItems(target, { group: undefined, canLoadPage: true, canExpandNeighbors: true });
  render(<ContextMenu x={40} y={50} title={target.label} items={items} onAction={onAction} onClose={onClose} />);
  return { onAction, onClose };
}

describe('ContextMenu', () => {
  test('lists the items for the node, with "Run tool" disabled', () => {
    renderMenu();
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(labels).toEqual(['Focus', 'Expand neighbors', 'Copy value', 'Open URL in new tab', 'Run tool (coming later)']);
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Run tool (coming later)' }).disabled).toBe(true);
  });

  test('clicking an item runs its action', () => {
    const { onAction } = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open URL in new tab' }));
    expect(onAction).toHaveBeenCalledWith('open-url');
  });

  test('Escape and a click outside close it; a click inside does not', () => {
    const { onClose } = renderMenu();
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Focus' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
