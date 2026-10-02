'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { shell } = require('electron');

/**
 * Hype mode: when it comes down to you against one of them, music kicks in.
 *
 * The music source is whatever the user pastes:
 *  - a folder (or single file) of audio → played by the app itself, through the
 *    hidden capture window. The regular player stays paused, so nothing fights.
 *  - a Spotify link/URI or YouTube URL → handed to the OS, which opens the
 *    player and starts it. From then on the normal controller treats it like
 *    any other playing session.
 *
 * Only the *edges* matter: one action when the 1v1 begins, one when it ends.
 * Re-firing every poll would restart the track every second.
 */

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.flac', '.webm']);

class HypeMode extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.active = false;
    this.lastCounts = null;
    this.playingLocal = false;
    this.lastError = null;
    this.audioSink = null;       // function(cmd) — routes to the capture window
  }

  get settings() { return this.config.get('hype') || {}; }

  /** What kind of thing the user pasted. */
  static classify(source) {
    const s = String(source || '').trim();
    if (!s) return { kind: 'none' };
    if (/^spotify:/i.test(s)) return { kind: 'spotify', uri: s };
    if (/open\.spotify\.com\/(track|album|playlist|artist)\/([A-Za-z0-9]+)/i.test(s)) {
      const m = s.match(/open\.spotify\.com\/(track|album|playlist|artist)\/([A-Za-z0-9]+)/i);
      // Handing Spotify a spotify: URI skips the browser round-trip.
      return { kind: 'spotify', uri: 'spotify:' + m[1].toLowerCase() + ':' + m[2] };
    }
    if (/^https?:\/\//i.test(s)) return { kind: 'url', url: s };
    try {
      const st = fs.statSync(s);
      if (st.isDirectory() || st.isFile()) return { kind: 'local', path: s };
    } catch { /* not a path */ }
    return { kind: 'unknown', raw: s };
  }

  /** Audio files under a folder (or the single file), sorted for determinism. */
  static localFiles(p) {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) return AUDIO_EXT.has(path.extname(p).toLowerCase()) ? [p] : [];
      return fs.readdirSync(p)
        .filter(f => AUDIO_EXT.has(path.extname(f).toLowerCase()))
        .sort()
        .map(f => path.join(p, f));
    } catch {
      return [];
    }
  }

  /** Whether the controller should force music ON right now (link sources only). */
  get overridesPlayback() {
    if (!this.active) return false;
    const k = HypeMode.classify(this.settings.source).kind;
    return k === 'spotify' || k === 'url';
  }

  /**
   * Called each poll with a fresh reading of the HUD pills.
   * @param reading result of clutch.readCounts(), or null when none was possible
   * @param ctx     {phase, alive}
   */
  update(reading, { phase, alive }) {
    this.lastCounts = reading;
    const s = this.settings;
    const want = !!s.enabled && phase === 'live' && alive === true &&
      !!reading && reading.clutch === true;
    if (want === this.active) return;
    this.active = want;
    if (want) this.start(); else this.stop();
    this.emit('change', { active: want, reading });
  }

  /** Force off, e.g. when the round ends or the game closes. */
  reset() {
    if (!this.active) return;
    this.active = false;
    this.stop();
    this.emit('change', { active: false, reading: null });
  }

  start() {
    const src = HypeMode.classify(this.settings.source);
    this.lastError = null;
    try {
      if (src.kind === 'local') {
        const files = HypeMode.localFiles(src.path);
        if (!files.length) throw new Error('No audio files found in ' + src.path);
        if (!this.audioSink) throw new Error('audio player not ready');
        this.audioSink({
          action: 'play',
          files: files.map(f => 'file:///' + f.replace(/\\/g, '/')),
          volume: (this.settings.volume ?? 100) / 100
        });
        this.playingLocal = true;
      } else if (src.kind === 'spotify') {
        shell.openExternal(src.uri);
      } else if (src.kind === 'url') {
        shell.openExternal(src.url);
      } else if (src.kind === 'none') {
        throw new Error('No hype music set — paste a Spotify/YouTube link or a folder of tracks.');
      } else {
        throw new Error("Couldn't tell what that source is: " + src.raw);
      }
    } catch (e) {
      this.lastError = e.message;
      this.emit('error', e.message);
    }
  }

  stop() {
    if (this.playingLocal && this.audioSink) {
      this.audioSink({ action: 'stop' });
      this.playingLocal = false;
    }
    // Link sources are left to the controller, which pauses them like any
    // other session once the round is no longer a live 1v1.
  }

  status() {
    return {
      active: this.active,
      counts: this.lastCounts,
      source: HypeMode.classify(this.settings.source).kind,
      lastError: this.lastError
    };
  }
}

module.exports = { HypeMode, AUDIO_EXT };
