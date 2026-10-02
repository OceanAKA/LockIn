'use strict';
const { EventEmitter } = require('events');
const { GAMES } = require('./games/defs');

/**
 * Decides whether music should be playing, given the active game's normalised
 * phase and whether the player is alive, then drives the chosen player to match.
 *
 * Phases: 'off' | 'menu' | 'prep' | 'live' | 'end'
 *
 * `desired === null` means "no opinion" — used when no game is running, so the
 * app leaves playback completely alone while the user isn't playing.
 */
class Controller extends EventEmitter {
  /** @param getPlayer returns the Windows media-session controller. */
  constructor(config, getPlayer, isHyped = () => false) {
    super();
    this.config = config;
    this.getPlayer = getPlayer;
    this.isHyped = isHyped;      // hype mode wants music on regardless of state
    this.game = null;
    this.phase = 'off';
    this.alive = null;
    this.desired = null;
    this.applied = null;
    this.settleTimer = null;
    this.busy = false;
    this.lastError = null;
  }

  setState({ game, phase, alive }) {
    const changed = this.game !== game || this.phase !== phase || this.alive !== alive;
    this.game = game;
    this.phase = phase;
    this.alive = alive;
    if (changed) this.schedule();
  }

  /** @returns true = play, false = pause, null = leave Spotify alone. */
  computeDesired() {
    if (!this.config.get('enabled')) return null;   // master switch is off
    if (!this.game || this.phase === 'off') return null;
    const g = this.config.game(this.game);
    if (!g || !g.enabled) return null;

    switch (this.phase) {
      case 'menu':
        return !!g.playInMenus;
      case 'prep':
        return !!g.playInPrep;
      case 'end':
        // For a round-based game the gap between rounds is the prep setting;
        // for the others 'end' is the post-game screen, which is a menu.
        return GAMES[this.game].hasPrep ? !!g.playInPrep : !!g.playInMenus;
      case 'live':
        // A live 1v1 with hype mode on is the one time music plays while alive.
        if (this.isHyped()) return true;
        // Unknown alive state (spectating, no death text yet) => assume playing,
        // which means silence. Better than music during a fight.
        if (this.alive === null) return false;
        return !!g.playWhenDead && !this.alive;
      default:
        return null;
    }
  }

  schedule(delay = 250) {
    const want = this.computeDesired();
    if (want === this.desired) return;
    this.desired = want;
    this.emit('desired', { desired: want, game: this.game, phase: this.phase, alive: this.alive });
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (want === null) return;   // nothing to push
    this.settleTimer = setTimeout(() => this.apply(), delay);
  }

  /**
   * Force the current decision onto the backend even though the decision itself
   * hasn't changed — needed when the player is swapped mid-session, since the
   * new backend was never told anything.
   */
  resync() {
    this.applied = null;
    this.desired = this.computeDesired();
    if (this.desired === null) return;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.apply(), 0);
  }

  async apply() {
    if (this.busy) { setTimeout(() => this.apply(), 300); return; }
    const player = this.getPlayer();
    if (!player || !player.connected) return;
    const want = this.desired;
    if (want === null || want === this.applied) return;

    this.busy = true;
    try {
      // Straight play/pause — the app never touches your volume.
      if (want) {
        const res = await player.play();
        if (res && res._noDevice) {
          throw new Error('Nothing to play — start playback once, then retry.');
        }
      } else {
        const res = await player.pause();
        if (res && res._noDevice) throw new Error('Nothing is playing.');
      }

      this.applied = want;
      this.lastError = null;
      this.emit('applied', { playing: want });
    } catch (e) {
      this.lastError = e.message;
      this.emit('error', e.message);
    } finally {
      this.busy = false;
      if (this.desired !== null && this.desired !== this.applied) {
        setTimeout(() => this.apply(), 400);
      }
    }
  }

  status() {
    return {
      game: this.game,
      phase: this.phase,
      alive: this.alive,
      desired: this.desired,
      applied: this.applied,
      lastError: this.lastError
    };
  }
}

module.exports = { Controller };
