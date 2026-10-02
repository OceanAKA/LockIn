'use strict';
const { EventEmitter } = require('events');

/**
 * Marvel Rivals adapter.
 *
 * NetEase encrypts the game's logs (they start with a `logversion000` header
 * followed by binary), and there is no local API, so nothing about the match is
 * readable from disk.
 *
 * The only handle is the text shown on death, which the user supplies in
 * settings. Until they do, all this adapter knows is that the game is open, so
 * it reports 'menu' and music simply plays the whole time.
 */
class MarvelRivalsAdapter extends EventEmitter {
  constructor() {
    super();
    this.phase = 'off';
    this.alive = null;
    this.running = false;
    this.screenEnabled = false;
  }

  get id() { return 'marvelrivals'; }

  /** Nothing else reports state, so capture runs whenever the game is up. */
  get needsScreen() { return this.running && this.screenEnabled; }

  start() { /* purely process- and screen-driven */ }

  stop() { this.set('off', null); }

  setProcesses({ client, game }) {
    this.running = client || game;
    if (!this.running) this.set('off', null);
    else if (this.phase === 'off') this.set('menu', null);
  }

  setScreenEnabled(v) {
    this.screenEnabled = v;
    // With no death text configured we only know the game is open; report menus
    // rather than silently pausing music for a match we cannot see.
    if (!v && this.running) this.set('menu', null);
  }

  setScreenLabel(label) {
    if (!this.running || !this.screenEnabled) return;
    if (label === 'dead') this.set('live', false);
    // No log to fall back on, and no hide-the-report key here, so the banner
    // going away really does mean you're back up.
    else if (label === 'alive') this.set('live', true);
  }

  set(phase, alive) {
    if (this.phase === phase && this.alive === alive) return;
    this.phase = phase;
    this.alive = alive;
    this.emit('state', { phase, alive, detail: null });
  }
}

module.exports = { MarvelRivalsAdapter };
