import type { Core } from 'cytoscape';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { toElements } from '../src/graph/elements';
import { LABEL_FADE_LEVELS, LABEL_HIDDEN, LABEL_MIN_PX, bindLabelFade, labelsVisible } from '../src/graph/labels';
import { EDGE_FONT_PX, LABEL_FADE_MS, NODE_FONT_PX } from '../src/graph/style';
import { edge, headless, node } from './fixtures';

describe('labelsVisible', () => {
  test('shown at or above the threshold, hidden below', () => {
    expect(labelsVisible(10, LABEL_MIN_PX / 10, true)).toBe(true);
    expect(labelsVisible(10, (LABEL_MIN_PX - 0.1) / 10, true)).toBe(false);
  });

  test('coming back needs a little more zoom, so resting on the threshold does not flicker', () => {
    const atThreshold = LABEL_MIN_PX / 10;
    expect(labelsVisible(10, atThreshold, false)).toBe(false);
    expect(labelsVisible(10, atThreshold * 1.1, false)).toBe(true);
  });
});

describe('bindLabelFade', () => {
  let cy: Core;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cy.destroy();
  });

  function setup(zoom: number) {
    cy = headless();
    cy.add(toElements({ nodes: [node('a'), node('b')], edges: [edge('a', 'b')] }));
    cy.zoom(zoom);
    const unbind = bindLabelFade(cy);
    /** The fade level class every node (edge) has, or 'shown' when none. */
    const level = (sel: 'node' | 'edge') => {
      const found = LABEL_FADE_LEVELS.filter((c) => cy.$(`${sel}.${c}`).length === cy.$(sel).length);
      return found[0] ?? (cy.$(sel).filter((el) => LABEL_FADE_LEVELS.some((c) => el.hasClass(c))).empty() ? 'shown' : 'mixed');
    };
    const state = () => ({ nodes: level('node'), edges: level('edge') });
    return { unbind, state };
  }

  test('edge labels (smaller) go before node labels when zooming out, and come back zooming in', () => {
    const { state } = setup(1.5);
    expect(state()).toEqual({ nodes: 'shown', edges: 'shown' });
    cy.zoom(LABEL_MIN_PX / EDGE_FONT_PX - 0.05); // edges too small, nodes still fine
    vi.advanceTimersByTime(LABEL_FADE_MS);
    expect(state()).toEqual({ nodes: 'shown', edges: LABEL_HIDDEN });
    cy.zoom(LABEL_MIN_PX / NODE_FONT_PX - 0.05);
    vi.advanceTimersByTime(LABEL_FADE_MS);
    expect(state()).toEqual({ nodes: LABEL_HIDDEN, edges: LABEL_HIDDEN });
    cy.zoom(2);
    vi.advanceTimersByTime(LABEL_FADE_MS);
    expect(state()).toEqual({ nodes: 'shown', edges: 'shown' });
  });

  test('a short fade, not a pop: half-way first, then gone', () => {
    const { state } = setup(1.5);
    cy.zoom(0.3);
    expect(state()).toEqual({ nodes: 'label-fade-1', edges: 'label-fade-1' });
    expect(cy.getElementById('a').style('text-opacity')).toBe('0.5');
    vi.advanceTimersByTime(LABEL_FADE_MS);
    expect(state()).toEqual({ nodes: LABEL_HIDDEN, edges: LABEL_HIDDEN });
    expect(cy.getElementById('a').style('text-opacity')).toBe('0');
  });

  test('turning back mid-fade reverses from where it is', () => {
    const { state } = setup(1.5);
    cy.zoom(0.3);
    cy.zoom(1.5);
    vi.advanceTimersByTime(LABEL_FADE_MS);
    expect(state()).toEqual({ nodes: 'shown', edges: 'shown' });
  });

  test('elements added later take the current state', () => {
    setup(0.3);
    cy.add(toElements({ nodes: [node('c')], edges: [edge('a', 'c')] }));
    expect(cy.getElementById('c').hasClass(LABEL_HIDDEN)).toBe(true);
    expect(cy.getElementById('a->c').hasClass(LABEL_HIDDEN)).toBe(true);
  });

  test('edges show their relation along the edge, on a small background; no hard min-size cut', () => {
    setup(1.5);
    const a = cy.getElementById('a');
    const e = cy.getElementById('a->b');
    expect(e.style('label')).toBe('has_subdomain');
    expect(e.style('text-rotation')).toBe('autorotate');
    expect(Number(e.style('text-background-opacity'))).toBeGreaterThan(0);
    expect(a.style('min-zoomed-font-size')).toBe('0px');
  });

  test('unbinding stops following the zoom and cancels a fade in progress', () => {
    const { unbind, state } = setup(1.5);
    cy.zoom(0.3);
    unbind();
    vi.advanceTimersByTime(LABEL_FADE_MS);
    expect(state()).toEqual({ nodes: 'label-fade-1', edges: 'label-fade-1' });
    cy.zoom(2);
    expect(state()).toEqual({ nodes: 'label-fade-1', edges: 'label-fade-1' });
  });
});
