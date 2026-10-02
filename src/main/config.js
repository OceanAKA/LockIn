'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { GAME_IDS, gameDefaults } = require('./games/defs');

const SCHEMA_VERSION = 5;

/**
 * Where to look for the "KILLED BY" banner. The combat report sits on the right
 * of the screen, so that's the default; scanning less means less HUD text for
 * the parser to sift through. 'full' is the fallback if the panel moves.
 */
const KILL_REGIONS = {
  right: { x: 0.35, y: 0, w: 0.65, h: 1 },
  full: { x: 0, y: 0, w: 1, h: 1 }
};

function baseDefaults() {
  return {
    version: SCHEMA_VERSION,
    enabled: true,            // the master on/off switch on the little box
    compact: true,            // start as the small corner widget
    alwaysOnTop: false,       // off by default; the widget shouldn't cover your work
    mediaAppId: '',           // blank = whichever player is actually playing
    killTracker: {            // reads the "KILLED BY" banner with Windows OCR
      enabled: true,          // the default death signal: exact, no calibration
      regionPreset: 'right',  // 'right' | 'full' | 'custom'
      region: { ...KILL_REGIONS.right },
      pollMs: 900,
      useAsDeathSignal: true  // seeing the banner is proof you died
    },
    killTally: {},            // canonical key -> { label, agent, player, count }
    hype: {                   // 1v1 clutch music
      enabled: false,
      source: '',             // Spotify link/URI, YouTube URL, or a folder of tracks
      // The alive-count pills sit either side of the round timer. Measured on a
      // 16:9 HUD: centres at 0.43 and 0.57 of the width, just under the top edge.
      pills: { offset: 0.07, top: 0.018, w: 0.05, h: 0.062 },
      pollMs: 700,
      volume: 100,            // local-file playback only
      showCard: true,
      cardText: '1v1 — LOCK IN'
    },
    reminder: {               // the nudge shown each time you die
      enabled: true,
      text: 'Do 5 pushups',
      seconds: 4,
      showOverlay: true,
      speak: false,           // needed if the game runs exclusive fullscreen
      countDeaths: true
    },
    games: Object.fromEntries(GAME_IDS.map(id => [id, gameDefaults(id)]))
  };
}

/** Keys from older schemas that no longer mean anything. */
const RETIRED = [
  'playVolume', 'fadeMs',                              // volume control dropped
  'clientId', 'playlistUri', 'musicSource',            // Spotify Web API dropped
  'refreshToken', 'refreshTokenPlain',
  'playInBuyPhase', 'deathDetection', 'samples', 'captureRegion'
];

/** Per-game keys retired with the pixel classifier in v5. */
const RETIRED_GAME = ['samples', 'screenDetection', 'captureRegion', 'playlistUri'];

/**
 * v1 was Valorant-only with its settings at the top level. Lift the ones that
 * still exist into games.valorant.
 */
function migrateV1(raw) {
  const out = baseDefaults();
  const v = out.games.valorant;
  v.playInMenus = raw.playInMenus ?? true;
  v.playInPrep = raw.playInBuyPhase ?? true;   // renamed
  v.playWhenDead = raw.playWhenDead ?? true;
  return out;
}

class Config {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json');
    this.data = baseDefaults();
    this.load();
  }

  load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return;  // first run
    }

    if (!raw.version || raw.version < 2) {
      this.data = migrateV1(raw);
      this.backup('v1');
      this.save();
      return;
    }

    const base = baseDefaults();
    this.data = { ...base, ...raw, version: SCHEMA_VERSION };

    // Drop settings that belonged to features which no longer exist, and write
    // back so the file on disk matches what the app actually uses.
    let hadStale = false;
    for (const k of RETIRED) {
      if (k in this.data) { delete this.data[k]; hadStale = true; }
    }

    // Nested objects need merging, or a stored one hides newly added settings.
    this.data.reminder = { ...base.reminder, ...(raw.reminder || {}) };

    // v4 made the "KILLED BY" banner the default death signal and moved the
    // scan to the right of the screen. An older config carries the old opt-out
    // and a whole-screen region, which would silently keep it disabled — so
    // take the new defaults wholesale on upgrade.
    if ((raw.version || 0) < 4) {
      this.data.killTracker = { ...base.killTracker };
      hadStale = true;
    } else {
      this.data.killTracker = {
        ...base.killTracker,
        ...(raw.killTracker || {}),
        region: { ...base.killTracker.region, ...((raw.killTracker || {}).region || {}) }
      };
    }
    this.data.killTally = raw.killTally || {};
    this.data.hype = {
      ...base.hype,
      ...(raw.hype || {}),
      pills: { ...base.hype.pills, ...((raw.hype || {}).pills || {}) }
    };
    delete this.data.hype.band; delete this.data.hype.allies; delete this.data.hype.enemies;

    // Merge each game individually so newly added games and settings appear.
    this.data.games = {};
    for (const id of GAME_IDS) {
      const d = gameDefaults(id);
      const stored = (raw.games || {})[id] || {};
      const merged = { ...d, ...stored };
      for (const k of RETIRED_GAME) {
        if (k in merged) { delete merged[k]; hadStale = true; }
      }
      this.data.games[id] = merged;
    }

    if (hadStale || (raw.version || 0) < SCHEMA_VERSION) this.save();
  }

  backup(tag) {
    try {
      fs.copyFileSync(this.file, this.file + '.' + tag + '.bak');
    } catch { /* best effort */ }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Write-then-rename so a crash mid-write can't leave a truncated config.
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('config save failed:', e.message);
    }
  }

  get(k) { return this.data[k]; }
  set(k, v) { this.data[k] = v; this.save(); }
  update(patch) { Object.assign(this.data, patch); this.save(); }

  game(id) { return this.data.games[id]; }

  setGame(id, patch) {
    Object.assign(this.data.games[id], patch);
    this.save();
  }

  publicView() { return { ...this.data }; }
}

module.exports = { Config, SCHEMA_VERSION, KILL_REGIONS };
