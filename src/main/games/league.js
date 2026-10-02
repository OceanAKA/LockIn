'use strict';
const { EventEmitter } = require('events');
const { getJson } = require('./localHttp');

// Riot's Live Client Data API. Unauthenticated, self-signed, and only listening
// while a game is actually in progress — its reachability *is* the in-game test.
const LIVE_URL = 'https://127.0.0.1:2999/liveclientdata/allgamedata';
const POLL_MS = 1000;

/**
 * League adapter.
 *
 * There are no rounds, so the mapping is: the client being up means menus
 * (lobby, queue, champ select), and a live game means `live` with alive/dead
 * read straight from the API — no screen calibration needed.
 */
class LeagueAdapter extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    this.phase = 'off';
    this.alive = null;
    this.clientRunning = false;
    this.summoner = null;
    this.lastError = null;
  }

  get id() { return 'league'; }
  get needsScreen() { return false; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.poll();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.set('off', null);
  }

  /** Told by the detector whether the League client / game processes are up. */
  setProcesses({ client, game }) {
    this.clientRunning = client || game;
    if (!this.clientRunning) this.set('off', null);
  }

  async poll() {
    if (!this.clientRunning) { this.set('off', null); return; }

    let data = null;
    try {
      data = await getJson(LIVE_URL);
      this.lastError = null;
    } catch (e) {
      // Expected whenever the client is up but no game is running.
      this.lastError = e.message;
    }

    if (!data || !data.allPlayers) {
      this.set('menu', null);
      return;
    }

    const me = this.findActivePlayer(data);
    if (!me) {
      // Spectating, or the player list hasn't populated yet.
      this.set('live', null);
      return;
    }
    this.summoner = me.riotId || me.summonerName || null;
    this.set('live', !me.isDead);
  }

  /** activePlayer identifies itself differently across client versions. */
  findActivePlayer(data) {
    const ap = data.activePlayer || {};
    const candidates = [
      ap.riotId,
      ap.riotIdGameName && ap.riotIdTagLine
        ? ap.riotIdGameName + '#' + ap.riotIdTagLine
        : null,
      ap.summonerName
    ].filter(Boolean).map(s => s.toLowerCase());

    if (!candidates.length) return null;
    return data.allPlayers.find(p => {
      const names = [
        p.riotId,
        p.riotIdGameName && p.riotIdTagLine
          ? p.riotIdGameName + '#' + p.riotIdTagLine
          : null,
        p.summonerName
      ].filter(Boolean).map(s => s.toLowerCase());
      return names.some(n => candidates.includes(n));
    }) || null;
  }

  set(phase, alive) {
    if (this.phase === phase && this.alive === alive) return;
    this.phase = phase;
    this.alive = alive;
    this.emit('state', { phase, alive, detail: this.summoner });
  }
}

module.exports = { LeagueAdapter };
