'use strict';

/**
 * Reads the alive counts Valorant prints either side of the round timer.
 *
 * The HUD shows `[allies] N  0:34  N [enemies]` — a white digit in a grey
 * hexagonal pill on each side. Windows OCR refuses to return a lone glyph, so
 * the digit is read geometrically instead:
 *
 *   1. threshold the pill crop to bright pixels,
 *   2. group them into connected blobs,
 *   3. take the blob nearest the pill's centre (the HUD's white border lines
 *      and stray bright world pixels are elsewhere and get ignored),
 *   4. a "1" is a thin, solid vertical bar: much narrower than it is tall AND
 *      it fills most of its own bounding box. Every other digit is wider, and
 *      the ones that come close (a 7) are hollow. Both tests must agree.
 *
 * Deterministic, ~1ms, and independent of what's behind the HUD.
 */

const BRIGHT = 200;          // r,g,b all above this = part of the white digit
const MIN_BLOB = 12;         // px; smaller is noise
const ONE_ASPECT = 0.5;      // width/height below this could be a "1"
const ONE_FILL = 0.45;       // ...and a "1" covers at least this much of its box

/** 4-connected components over a binary mask; returns per-blob stats. */
function blobs(mask, w, h) {
  const label = new Int32Array(w * h);
  const out = [];
  let next = 0;
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || label[start]) continue;
    next++;
    let n = 0, minX = w, maxX = -1, minY = h, maxY = -1, sx = 0, sy = 0;
    stack.push(start); label[start] = next;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i - x) / w;
      n++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const nb = [i - 1, i + 1, i - w, i + w];
      if (x === 0) nb[0] = -1; if (x === w - 1) nb[1] = -1;
      for (const j of nb) {
        if (j >= 0 && j < w * h && mask[j] && !label[j]) { label[j] = next; stack.push(j); }
      }
    }
    if (n >= MIN_BLOB) {
      out.push({
        n, minX, maxX, minY, maxY,
        w: maxX - minX + 1, h: maxY - minY + 1,
        cx: sx / n, cy: sy / n
      });
    }
  }
  return out;
}

/**
 * Reads one pill.
 * @returns {{found:boolean, isOne:boolean, aspect:number|null, box:object|null, blobs:number}}
 */
function readPill(rgba, w, h) {
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < w * h; i += 4, p++) {
    if (rgba[i] > BRIGHT && rgba[i + 1] > BRIGHT && rgba[i + 2] > BRIGHT) mask[p] = 1;
  }
  const all = blobs(mask, w, h);
  if (!all.length) return { found: false, isOne: false, aspect: null, box: null, blobs: 0 };

  // The digit is the blob closest to the middle of the pill. Border lines run
  // along the edges; the digit never does.
  const cx = w / 2, cy = h / 2;
  let best = null, bestD = Infinity;
  for (const b of all) {
    // A blob touching the crop edge is a border line or the world, not a digit.
    if (b.minX === 0 || b.minY === 0 || b.maxX === w - 1 || b.maxY === h - 1) continue;
    const d = (b.cx - cx) ** 2 + (b.cy - cy) ** 2;
    if (d < bestD) { bestD = d; best = b; }
  }
  if (!best) return { found: false, isOne: false, aspect: null, box: null, blobs: all.length };

  const aspect = best.w / best.h;
  const fill = best.n / (best.w * best.h);
  return {
    found: true,
    isOne: aspect < ONE_ASPECT && fill > ONE_FILL,
    aspect: +aspect.toFixed(2),
    fill: +fill.toFixed(2),
    box: { x: best.minX, y: best.minY, w: best.w, h: best.h },
    blobs: all.length
  };
}

/**
 * @param left  {rgba,width,height} crop of the allies pill
 * @param right {rgba,width,height} crop of the enemies pill
 */
function readCounts(left, right) {
  const a = readPill(left.rgba, left.width, left.height);
  const e = readPill(right.rgba, right.width, right.height);
  return {
    allies: a, enemies: e,
    // Only "1" can be identified with certainty; anything wider is ≥ 2.
    alliesOne: a.found && a.isOne,
    enemiesOne: e.found && e.isOne,
    clutch: a.found && a.isOne && e.found && e.isOne
  };
}

module.exports = { readPill, readCounts, blobs, BRIGHT, ONE_ASPECT, ONE_FILL };
