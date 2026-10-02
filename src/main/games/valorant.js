'use strict';
const { EventEmitter } = require('events');
const { LogWatcher } = require('../logWatcher');

// Log phase -> normalised phase.
const PHASE_MAP = {
  menu: 'menu',
  pregame: 'menu',      // agent select
  buy: 'prep',
  live: 'live',
  roundend: 'end'
};

/**
 * Valorant adapter.
 *
 * Round state is exact, straight from ShooterGame.log. Death is the one thing
 * Riot does not log client-side, so `alive` is supplied externally by reading
 * the death banner, and only matters while the phase is 'live'.
 */
class ValorantAdapter extends EventEmitter {
  constructor() {
    super();
    this.watcher = new LogWatcher();
    this.phase = 'off';
    this.alive = null;
    this.agent = null;
    this.running = false;
    this.screenEnabled = false;

    this.watcher.on('phase', ({ phase, agent }) => {
      this.agent = agent || this.agent;
      const mapped = PHASE_MAP[phase] || 'menu';
      // Every round begins with the player alive; a stale 'dead' must not leak.
      if (mapped === 'prep' || mapped === 'end') this.alive = true;
      this.set(mapped, this.alive);
    });
    this.watcher.on('spawn', ({ agent }) => { this.agent = agent; });
  }

  get id() { return 'valorant'; }

  /** Screen capture is only worth running during a live round. */
  get needsScreen() {
    return this.running && this.screenEnabled && this.phase === 'live';
  }

  get logWatching() { return this.watcher.watching; }

  start() { this.watcher.start(); }

  stop() { this.watcher.stop(); this.set('off', null); }

  setProcesses({ client, game }) {
    this.running = client || game;
    if (!this.running) this.set('off', null);
    else if (this.phase === 'off') this.set('menu', null);
  }

  setScreenEnabled(v) { this.screenEnabled = v; }

  /** Called with 'alive' or 'dead' from the on-screen death text. */
  setScreenLabel(label) {
    if (this.phase !== 'live') return;
    this.set(this.phase, label === 'alive');
  }

  set(phase, alive) {
    if (this.phase === phase && this.alive === alive) return;
    this.phase = phase;
    this.alive = alive;
    this.emit('state', { phase, alive, detail: this.agent });
  }
}

module.exports = { ValorantAdapter };
