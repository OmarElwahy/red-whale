import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ContextMenu } from '../src/menu/ContextMenu';
import { menuItems, type MenuItem } from '../src/menu/items';
import { node } from './fixtures';

function renderMenu() {
  const onAction = vi.fn();
  const onClose = vi.fn();
  const target = node('u', { type: 'url', value: 'https://a.example.com/', label: 'https://a.example.com/' });
  const items = menuItems(target, { group: undefined, canExpandNeighbors: true, hasRoom: true });
  render(<ContextMenu x={40} y={50} title={target.label} items={items} onAction={onAction} onClose={onClose} />);
  return { onAction, onClose };
}

describe('ContextMenu', () => {
  test('lists the items for the node, with "Run tool" disabled while the tools load', () => {
    renderMenu();
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(labels).toEqual(['Focus', 'Expand neighbors', 'Expand all below', 'Copy value', 'Open URL in new tab', 'Run tool', 'Add child node…']);
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Run tool' }).disabled).toBe(true);
  });

  test('clicking an item runs its action', () => {
    const { onAction } = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open URL in new tab' }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'open-url' }));
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

describe('Run tool submenu', () => {
  test('opens in place, shows badges and reasons, runs an item, and goes back', () => {
    const onAction = vi.fn();
    const items: MenuItem[] = [
      { action: 'focus', label: 'Focus' },
      {
        action: 'run-menu',
        label: 'Run tool',
        submenu: [
          { action: 'run-group', name: 'subdomain', label: 'Run group: subdomain enumeration', badges: [{ text: 'passive', tone: 'passive' }] },
          {
            action: 'run-tool',
            name: 'crtsh',
            label: 'crt.sh',
            badges: [{ text: 'external', tone: 'external' }],
            disabled: true,
            hint: 'Docker is not running.',
          },
        ],
      },
    ];
    render(<ContextMenu x={0} y={0} title="example.com" items={items} onAction={onAction} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('menuitem', { name: /Run tool/ }));
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual([
      '‹ Run tool',
      'Run group: subdomain enumerationpassive',
      'crt.shexternalDocker is not running.',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: /Run group/ }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'run-group', name: 'subdomain' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '‹ Run tool' }));
    expect(screen.getByRole('menuitem', { name: 'Focus' })).toBeTruthy();
  });
});
