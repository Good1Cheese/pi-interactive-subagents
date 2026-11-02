import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWeightedLayout } from "../pi-extension/subagents/weighted-layout.ts";

/** Parse the geometry section of tmux's classic layout string recursively. */
function parse(body: string) {
  let pos = 0;
  const rects: Array<{ width: number; height: number; x: number; y: number }> = [];
  function cell(): void {
    const match = /^(\d+)x(\d+),(\d+),(\d+)/.exec(body.slice(pos));
    assert.ok(match, `Malformed cell at ${pos}: ${body.slice(pos)}`);
    pos += match[0].length;
    const [width, height, x, y] = match.slice(1).map(Number);
    if (body[pos] === "[" || body[pos] === "{") {
      const close = body[pos++] === "[" ? "]" : "}";
      cell();
      assert.equal(body[pos++], ",");
      cell();
      assert.equal(body[pos++], close);
    } else {
      rects.push({ width, height, x, y });
    }
  }
  cell();
  assert.equal(pos, body.length);
  return rects;
}

function verifyNoUnusedSpace(width: number, height: number, count: number, weight = 1.25): void {
  const result = createWeightedLayout(width, height, count, weight);
  assert.ok(result, `Layout should fit ${count} panes in ${width}x${height}`);
  assert.match(result.layout, /^[a-f\d]{4},\d+x\d+,0,0/);
  const rects = parse(result.layout.slice(5));
  assert.deepEqual(rects, result.panes);
  assert.equal(rects.length, count);
  const filled = new Set<string>();
  for (const rect of rects) {
    assert.ok(rect.width >= 4 && rect.height >= 3);
    assert.ok(rect.x + rect.width <= width && rect.y + rect.height <= height);
    for (let x = rect.x; x < rect.x + rect.width; ++x) {
      for (let y = rect.y; y < rect.y + rect.height; ++y) {
        const key = `${x},${y}`;
        assert.equal(filled.has(key), false, `overlap at ${key}`);
        filled.add(key);
      }
    }
  }
  // Divider rows/columns explain any unassigned cells. Every physical row
  // and column must still contain pane content; no orphaned bottom region.
  for (let x = 1; x < width - 1; ++x) {
    if (rects.some(r => r.x <= x && r.x + r.width > x)) continue;
    assert.ok(rects.some(r => r.x <= x - 1 && r.x + r.width > x - 1), `unused width at ${x}`);
    assert.ok(rects.some(r => r.x <= x + 1 && r.x + r.width > x + 1), `unused width at ${x}`);
  }
  for (let y = 1; y < height - 1; ++y) {
    if (rects.some(r => r.y <= y && r.y + r.height > y)) continue;
    assert.ok(rects.some(r => r.y <= y - 1 && r.y + r.height > y - 1), `unused height at ${y}`);
    assert.ok(rects.some(r => r.y <= y + 1 && r.y + r.height > y + 1), `unused height at ${y}`);
  }
  if (count >= 2) {
    const areas = rects.map(r => r.width * r.height);
    const others = areas.slice(1);
    assert.ok(areas[0] > Math.max(...others), `orchestrator should exceed every worker: ${areas}`);
    assert.ok(Math.max(...others) / Math.min(...others) < 1.3, `workers not balanced: ${areas}`);
  }
}

describe("weighted tmux layout", () => {
  it("fills the entire height and width with a slightly larger orchestrator after any agent count", () => {
    for (let n = 1; n <= 12; n++) verifyNoUnusedSpace(170, 45, n);
  });
  it("keeps the orchestrator larger when the configured weight is neutral", () => {
    const result = createWeightedLayout(40, 15, 4, 1)!;
    const areas = result.panes.map(r => r.width * r.height);
    assert.ok(areas[0] > Math.max(...areas.slice(1)), `orchestrator should exceed every worker: ${areas}`);
  });

  it("respects user-specified main weight", () => {
    const small = createWeightedLayout(170, 45, 4, 1.05)!;
    const large = createWeightedLayout(170, 45, 4, 1.7)!;
    const area = (r: {width: number; height: number}) => r.width * r.height;
    assert.ok(area(large.panes[0]) > area(small.panes[0]));
  });
  it("does not invent geometry in tiny or invalid terminals", () => {
    assert.equal(createWeightedLayout(12, 8, 12), undefined);
    assert.equal(createWeightedLayout(170, 45, 4, Infinity), undefined);
    assert.equal(createWeightedLayout(170, 45, 0), undefined);
  });
});
