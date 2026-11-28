// Node drags on the canvas (docs/architecture.md §8): momentum (momentum.ts) and, in Tree mode, the subtree that
// follows the dragged node (subtree.ts), wired together.
//
// Order matters. Both listen to `grab`, and Cytoscape runs listeners in the order they were bound. A press must end
// the running glide first (which reports the gliding node at rest and stops its subtree following it), and only then
// set up the subtree drag for the node just pressed; the other way round, ending the old glide tears the new subtree
// drag down and the pressed node moves alone. So momentum is bound first.
import type { Core, NodeSingular } from 'cytoscape';
import { bindMomentum, type FrameScheduler, type Momentum } from './momentum';
import { bindSubtreeDrag, type SubtreeDrag } from './subtree';

export interface DragsOptions {
  /** Tree mode: a dragged node carries everything below it. */
  carriesSubtree: () => boolean;
  reducedMotion: () => boolean;
  /** A dragged node came to rest (after any glide); its subtree has stopped following it. Once per drag. */
  onRest: (node: NodeSingular) => void;
  scheduler?: FrameScheduler;
}

export interface Drags {
  momentum: Momentum;
  subtree: SubtreeDrag;
  dispose: () => void;
}

export function bindDrags(cy: Core, options: DragsOptions): Drags {
  // Set right below, before any event can fire; read only when a node comes to rest.
  let following: SubtreeDrag | null = null;
  const momentum = bindMomentum(cy, {
    reducedMotion: options.reducedMotion,
    scheduler: options.scheduler,
    onRest: (node) => {
      following?.end();
      options.onRest(node);
    },
  });
  const subtree = bindSubtreeDrag(cy, options.carriesSubtree);
  following = subtree;
  return {
    momentum,
    subtree,
    dispose: () => {
      momentum.dispose();
      subtree.dispose();
    },
  };
}
