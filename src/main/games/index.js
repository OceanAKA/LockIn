'use strict';
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { GAMES, GAME_IDS } = require('./defs');
const { ValorantAdapter } = require('./valorant');
const { LeagueAdapter } = require('./league');
const { MarvelRivalsAdapter } = require('./marvelrivals');

const SCAN_MS = 3000;

/** One `tasklist` call, lowercased, for all games at once. */
function runningProcesses() {
  return new Promise(resolve => {
    execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 4 << 20 },
      (err, stdout) => {
        if (err) { resolve(new Set()); return; }
        const set = new Set();
        for (const line of stdout.split(/\r?\n/)) {
          const m = /^"([^"]+)"/.exec(line);
          if (m) set.add(m[1].toLowerCase());
        }
        resolve(set);
      });
  });
}

/**
 * Owns one adapter per game, watches which game is actually running, and
 * forwards state from whichever one is active.
 *
 * Only one game is active at a time — the first running one wins. If nothing is
 * running the active game is null and the controller stays hands-off, so the
 * app never touches Spotify while the user isn't playing.
 */
class GameManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.adapters = {
      valorant: new ValorantAdapter(),
      league: new LeagueAdapter(),
      marvelrivals: new MarvelRivalsAdapter()
    };
    this.activeId = null;
    this.timer = null;

    for (const id of GAME_IDS) {
      this.adapters[id].on('state', s => {
        if (this.activeId !== id) return;
        this.emit('state', { game: id, ...s });
      });
    }
  }

  get active() { return this.activeId ? this.adapters[this.activeId] : null; }

  get needsScreen() {
    const a = this.active;
    return !!(a && a.needsScreen);
  }

  start() {
    for (const id of GAME_IDS) this.adapters[id].start();
    this.timer = setInterval(() => this.scan(), SCAN_MS);
    this.scan();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of GAME_IDS) this.adapters[id].stop();
  }

  /** A game can be read from the screen only if it declares what death says. */
  syncSettings() {
    for (const id of GAME_IDS) {
      const a = this.adapters[id];
      if (a.setScreenEnabled) a.setScreenEnabled(!!this.config.game(id).deathPhrase);
    }
  }

  async scan() {
    const procs = await runningProcesses();
    let firstRunning = null;

    for (const id of GAME_IDS) {
      const def = GAMES[id];
      const enabled = this.config.game(id).enabled;
      const game = def.processes.some(p => procs.has(p.toLowerCase()));
      const client = def.clientProcesses.some(p => procs.has(p.toLowerCase()));
      this.adapters[id].setProcesses({ client: enabled && client, game: enabled && game });
      if (enabled && (game || client) && !firstRunning) firstRunning = id;
    }

    if (firstRunning !== this.activeId) {
      this.activeId = firstRunning;
      const a = this.active;
      this.emit('active', {
        game: this.activeId,
        phase: a ? a.phase : 'off',
        alive: a ? a.alive : null
      });
    }
  }

  /** Route a screen-read label to the active adapter. */
  setScreenLabel(label) {
    const a = this.active;
    if (a && a.setScreenLabel) a.setScreenLabel(label);
  }

  status() {
    const a = this.active;
    return {
      activeGame: this.activeId,
      phase: a ? a.phase : 'off',
      alive: a ? a.alive : null,
      detail: a ? (a.summoner || a.agent || null) : null,
      logWatching: this.adapters.valorant.logWatching,
      leagueError: this.adapters.league.lastError
    };
  }
}

module.exports = { GameManager };
