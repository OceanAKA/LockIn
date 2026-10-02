'use strict';

/**
 * Pulls the killer's name out of OCR text from the death banner.
 *
 * OCR output is noisy in predictable ways — `1` reads as `I` or `l`, `0` as `O`,
 * case is unreliable — so matching is deliberately loose on the label and
 * conservative about what it accepts as a name.
 *
 * Riot IDs look like `Name #TAG`, and OCR usually keeps the `#`, so the tag is
 * captured when present and dropped from the display name.
 */

/**
 * Builds a matcher for the phrase that means "you died", tolerant of the ways
 * OCR mangles text: 1/l/I/| are interchangeable, 0/O likewise, and whitespace
 * between words is unreliable.
 */
const CLASSES = [
  ['i', 'l', '1', '|', '!'],
  ['o', '0'],
  ['s', '5'],
  ['b', '8']
];

function charPattern(ch) {
  const lower = ch.toLowerCase();
  for (const set of CLASSES) {
    if (set.includes(lower)) return '[' + set.join('') + ']';
  }
  return lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeLabel(phrase) {
  const words = String(phrase || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  // Words may be separated by any amount of whitespace, or none at all if OCR
  // ran them together.
  return new RegExp(words.map(w => [...w].map(charPattern).join('')).join('\\s*'), 'i');
}

// The default: Valorant's combat report banner.
const DEFAULT_LABEL = makeLabel('KILLED BY');

// Junk OCR commonly emits for icons and HUD fragments.
const NOISE = /^[^\p{L}\p{N}]+$/u;

// Only the ends are trimmed. Interior runs of spaces are load-bearing: the HUD
// separates the name from the weapon and health with a wide gap, and that gap is
// the most reliable way to tell where the name stops.
const LOOKAHEAD = 2;

/**
 * @param {string} text raw OCR output, possibly several lines
 * @param {string} [phrase] the wording to look for; defaults to "KILLED BY"
 * @returns {{name: string, tag: string|null, raw: string}|null}
 */
function parseKilledBy(text, phrase) {
  if (!text) return null;
  const LABEL = phrase === undefined ? DEFAULT_LABEL : makeLabel(phrase);
  if (!LABEL) return null;
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  for (let i = 0; i < lines.length; i++) {
    const m = LABEL.exec(lines[i]);
    if (!m) continue;

    // The name may trail the label, or sit a line or two below it behind icon
    // noise that OCR renders as punctuation.
    const candidates = [lines[i].slice(m.index + m[0].length)];
    for (let k = 1; k <= LOOKAHEAD; k++) {
      if (lines[i + k]) candidates.push(lines[i + k]);
    }

    for (let ci = 0; ci < candidates.length; ci++) {
      const s = candidates[ci].trim();
      if (!s || NOISE.test(s)) continue;
      const hit = extractName(s);
      if (!hit) continue;

      // Valorant's combat report repeats the agent just below the banner with
      // the killer's display name pushed to the right of the panel:
      //     KILLED BY SAGE
      //     Sage                          Aura
      // Look one line past whichever line the agent came from.
      const followIndex = i + (ci === 0 ? 1 : ci);
      hit.player = extractPlayer(lines[followIndex], hit.name);
      return hit;
    }
  }
  return null;
}

/**
 * The display name sitting opposite a repeat of the agent name.
 * Returns null unless the line really looks like that two-column row, so a
 * mis-read never invents a player.
 */
function extractPlayer(line, agentName) {
  if (!line || !agentName) return null;
  const parts = line.split(/\s{3,}/).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const left = parts[0];
  const right = parts[parts.length - 1];
  if (canonical(left) !== canonical(agentName)) return null;

  const name = right.replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 24);
  if (name.length < 2 || !/\p{L}/u.test(name)) return null;
  if (canonical(name) === canonical(agentName)) return null;   // just the agent again
  return name;
}

/**
 * Takes the leading player identifier off a fragment, ignoring trailing HUD text.
 *
 * Only the FIRST token is kept. OCR often flattens the whole panel onto one
 * line — "KILLED BY SAGE Sage COMBAT REPORT" — and agent names (and Riot IDs)
 * are single words, so anything past the first token is panel furniture.
 */
function extractName(fragment) {
  let s = fragment.trim();
  // The HUD puts a wide gap between the name and the weapon / health readout.
  s = s.split(/\s{3,}/)[0].trim();
  if (!s || NOISE.test(s)) return null;

  // Keep the first token, plus a "#TAG" that may have been split off it.
  const tokens = s.split(/\s+/);
  s = tokens[0];
  if (tokens[1] && tokens[1].startsWith('#')) s += ' ' + tokens[1];
  else if (s.endsWith('#') && tokens[1]) s += tokens[1];
  if (!s || NOISE.test(s)) return null;

  let tag = null;
  const hash = s.indexOf('#');
  if (hash >= 0) {
    const after = s.slice(hash + 1).trim().split(/\s+/)[0] || '';
    tag = after.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 8) || null;
    s = s.slice(0, hash).trim();
  }

  // Names allow letters, digits and a few symbols; strip anything else.
  const name = s.replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 24);
  if (!name || name.length < 2) return null;
  // A pure-noise result (all punctuation stripped to digits) isn't a name.
  if (!/\p{L}/u.test(name)) return null;

  return { name, tag, raw: fragment.trim().slice(0, 60) };
}

/**
 * Names differing only by classic OCR confusions are the same player.
 * Used to keep the tally from splitting one nemesis into several.
 */
function canonical(name) {
  return String(name)
    .toLowerCase()
    .replace(/[il|]/g, '1')
    .replace(/[o]/g, '0')
    .replace(/[s]/g, '5')
    .replace(/[^a-z0-9]/g, '');
}

module.exports = { parseKilledBy, canonical, makeLabel };
