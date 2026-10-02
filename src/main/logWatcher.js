'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const LOG_PATH = path.join(
  process.env.LOCALAPPDATA || '',
  'VALORANT', 'Saved', 'Logs', 'ShooterGame.log'
);

// Barriers drop ~30s into a normal round, ~45s on the first round of a half.
// A "Gameplay started at local time" below this threshold is the buy phase.
const BARRIER_DROP_SECONDS = 25;

const RE_GAMEPLAY_START = /Gameplay started at local time ([0-9.]+)/;
const RE_ROUND_ENDED    = /AShooterGameState::OnRoundEnded for round '(\d+)'/;
const RE_FLOW_STATE     = /LogGameFlowStateManager: \[PlatformTime: [0-9.]+\] Broadcasting state changed to (\w+)/;
const RE_POSSESSION     = /AcknowledgePossession\('(\w+?)_PC_C_\d+'\)/;

/**
 * Tails ShooterGame.log and emits high-level Valorant state.
 *
 * Events:
 *   'phase'  { phase: 'menu'|'pregame'|'buy'|'live', round, agent }
 *   'spawn'  { agent }          — local player possessed a fresh pawn
 *   'status' { watching, path } — file availability changed
 */
class LogWatcher extends EventEmitter {
  constructor(logPath = LOG_PATH, pollMs = 250) {
    super();
    this.logPath = logPath;
    this.pollMs = pollMs;
    this.position = 0;
    this.remainder = '';
    this.timer = null;
    this.watching = false;
    this.phase = 'menu';
    this.round = null;
    this.agent = null;
  }

  start() {
    if (this.timer) return;
    // Start from the end of the existing file so we don't replay old matches.
    try {
      this.position = fs.statSync(this.logPath).size;
      this.setWatching(true);
    } catch {
      this.position = 0;
      this.setWatching(false);
    }
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setWatching(v) {
    if (this.watching === v) return;
    this.watching = v;
    this.emit('status', { watching: v, path: this.logPath });
  }

  poll() {
    let stat;
    try {
      stat = fs.statSync(this.logPath);
    } catch {
      this.setWatching(false);
      this.position = 0;
      return;
    }
    this.setWatching(true);

    // Valorant rotates the log on relaunch: the file shrinks or is recreated.
    if (stat.size < this.position) {
      this.position = 0;
      this.remainder = '';
    }
    if (stat.size === this.position) return;

    const stream = fs.createReadStream(this.logPath, {
      start: this.position,
      end: stat.size - 1,
      encoding: 'utf8'
    });
    let chunk = '';
    stream.on('data', d => { chunk += d; });
    stream.on('end', () => {
      this.position = stat.size;
      const text = this.remainder + chunk;
      const lines = text.split(/\r?\n/);
      this.remainder = lines.pop() || '';
      for (const line of lines) this.handleLine(line);
    });
    stream.on('error', () => { /* transient read race; next poll retries */ });
  }

  handleLine(line) {
    let m;

    if ((m = RE_POSSESSION.exec(line))) {
      this.agent = m[1];
      this.emit('spawn', { agent: this.agent });
      return;
    }

    if ((m = RE_GAMEPLAY_START.exec(line))) {
      const t = parseFloat(m[1]);
      // t≈0 → buy phase just opened. t≈30/45 → barriers dropped, round is live.
      this.setPhase(t >= BARRIER_DROP_SECONDS ? 'live' : 'buy');
      return;
    }

    if ((m = RE_ROUND_ENDED.exec(line))) {
      this.round = parseInt(m[1], 10);
      this.setPhase('roundend');
      return;
    }

    if ((m = RE_FLOW_STATE.exec(line))) {
      const state = m[1];
      if (state === 'MainMenu') this.setPhase('menu');
      else if (state === 'Pregame') this.setPhase('pregame');
      // InGame is handled by the round markers above, which are finer-grained.
      return;
    }
  }

  setPhase(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit('phase', { phase, round: this.round, agent: this.agent });
  }
}

module.exports = { LogWatcher, LOG_PATH, BARRIER_DROP_SECONDS };
