/**
 * Build a tmux v1 custom layout that gives the orchestrator a small, fixed
 * area advantage while distributing the remaining space among workers.
 *
 * The leaves are emitted in tmux pane-list order (the same order used by
 * layout_assign_fallback in tmux's v1 layout parser). We use only integers and
 * the classic checked format: <checksum>,<geometry>{...} / [...].
 *
 * Never run this for a window with foreign panes. tmux.ts owns that policy.
 */

type Rect = { x: number; y: number; width: number; height: number };
export interface WeightedLayout {
  layout: string;
  /** Leaf geometries in tmux pane assignment order, for diagnostics and tests. */
  panes: readonly Rect[];
}

type LayoutNode =
  | { rect: Rect; children?: undefined; index: number }
  | { rect: Rect; children: [LayoutNode, LayoutNode]; axis: "horizontal" | "vertical"; index?: undefined };

// Tmux v1 layout parser checks both minimum leaf dimensions and offsets.
const MIN_WIDTH = 4;
const MIN_HEIGHT = 3;

function checksum(body: string): string {
  let sum = 0;
  for (const byte of Buffer.from(body, "ascii")) {
    sum = ((sum >> 1) | ((sum & 1) << 15)) & 0xffff;
    sum = (sum + byte) & 0xffff;
  }
  return sum.toString(16).padStart(4, "0");
}

function rectangle(rect: Rect): string {
  return `${rect.width}x${rect.height},${rect.x},${rect.y}`;
}

function serialize(node: LayoutNode): string {
  const base = rectangle(node.rect);
  if (!node.children) return base;
  const [left, right] = node.children;
  const open = node.axis === "vertical" ? "{" : "[";
  const close = node.axis === "vertical" ? "}" : "]";
  return `${base}${open}${serialize(left)},${serialize(right)}${close}`;
}

/**
 * Among near-half partitions, prefer one that distributes weight evenly.
 * A contiguous partition is necessary because tmux v1 assigns leaves in order.
 */
function partition(weights: readonly number[], start: number, end: number): number {
  const sum = weights.slice(start, end).reduce((a, b) => a + b, 0);
  let prefix = 0;
  let best = start + 1;
  let distance = Infinity;
  for (let i = start + 1; i < end; i++) {
    prefix += weights[i - 1];
    const diff = Math.abs(prefix - (sum - prefix));
    if (diff < distance) { distance = diff; best = i; }
  }
  return best;
}

function build(
  rect: Rect, weights: readonly number[], start: number, end: number,
  output: Rect[],
): LayoutNode | undefined {
  const count = end - start;
  if (count === 1) {
    output[start] = rect;
    return { rect, index: start };
  }
  const middle = partition(weights, start, end);
  const a = weights.slice(start, middle).reduce((x, y) => x + y, 0);
  const b = weights.slice(middle, end).reduce((x, y) => x + y, 0);
  const total = a + b;

  // Character cells are approximately twice as tall as they are wide.
  // Prefer wide panes and a two-dimensional mosaic over thin columns.
  const preferred: ("vertical" | "horizontal")[] =
    rect.width / rect.height >= 2.4 ? ["vertical", "horizontal"] : ["horizontal", "vertical"];
  for (const axis of preferred) {
    const vertical = axis === "vertical";
    const available = (vertical ? rect.width : rect.height) - 1; // tmux divider
    const minimumA = (vertical ? MIN_WIDTH : MIN_HEIGHT) * (middle - start);
    const minimumB = (vertical ? MIN_WIDTH : MIN_HEIGHT) * (end - middle);
    if (available < minimumA + minimumB) continue;
    const firstSize = Math.max(minimumA, Math.min(available - minimumB, Math.round(available * a / total)));
    const firstRect: Rect = vertical
      ? { ...rect, width: firstSize }
      : { ...rect, height: firstSize };
    const secondRect: Rect = vertical
      ? { x: rect.x + firstSize + 1, y: rect.y, width: available - firstSize, height: rect.height }
      : { x: rect.x, y: rect.y + firstSize + 1, width: rect.width, height: available - firstSize };
    const first = build(firstRect, weights, start, middle, output);
    const second = build(secondRect, weights, middle, end, output);
    if (first && second) return { rect, axis, children: [first, second] };
  }
  return undefined;
}

/** Return undefined when the terminal is too small for a safe custom layout. */
export function createWeightedLayout(
  width: number, height: number, paneCount: number, mainWeight = 1.25,
): WeightedLayout | undefined {
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(paneCount)
    || width < MIN_WIDTH || height < MIN_HEIGHT || paneCount < 1 || paneCount > 64
    || !Number.isFinite(mainWeight) || mainWeight < 1 || mainWeight > 2) return undefined;
  const weights = Array(paneCount).fill(1) as number[];
  // A configured weight of 1 is valid, but rounding can make a worker tie the
  // orchestrator; keep the documented small area advantage in that case.
  weights[0] = Math.max(mainWeight, 1.25);
  const panes: Rect[] = [];
  const tree = build({ x: 0, y: 0, width, height }, weights, 0, paneCount, panes);
  if (!tree) return undefined;
  const payload = serialize(tree);
  return { layout: `${checksum(payload)},${payload}`, panes };
}
