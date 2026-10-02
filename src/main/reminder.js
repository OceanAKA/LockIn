'use strict';
const path = require('path');
const { execFile } = require('child_process');
const { BrowserWindow, screen } = require('electron');

/**
 * The "you died, go do pushups" nudge.
 *
 * Two delivery paths, because neither works everywhere:
 *
 *  - A frameless always-on-top window. It is a plain desktop window, not an
 *    injected game overlay, so anti-cheat has no quarrel with it — but Windows
 *    will not draw any window over a game running in *exclusive* fullscreen.
 *    Borderless / windowed is fine.
 *  - Windows text-to-speech, which is heard regardless of display mode and is
 *    the fallback for exclusive fullscreen.
 *
 * The window is deliberately non-focusable and click-through: stealing focus
 * mid-round would tab the player out of their game.
 */

const WIDTH = 460;
const HEIGHT = 110;
const TOP_MARGIN = 64;

class Reminder {
  constructor(config) {
    this.config = config;
    this.win = null;
    this.hideTimer = null;
    this.speaking = null;
  }

  create() {
    this.win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,        // never take focus away from the game
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, '..', 'overlay', 'preload.js') }
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setIgnoreMouseEvents(true);          // clicks pass straight through
    this.win.setVisibleOnAllWorkspaces(true);
    this.win.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));
    this.win.on('closed', () => { this.win = null; });
    this.reposition();
  }

  /** Top-centre of the primary display, clear of the death banner being read. */
  reposition() {
    if (!this.win || this.win.isDestroyed()) return;
    const { workArea } = screen.getPrimaryDisplay();
    this.win.setBounds({
      x: Math.round(workArea.x + (workArea.width - WIDTH) / 2),
      y: Math.round(workArea.y + TOP_MARGIN),
      width: WIDTH,
      height: HEIGHT
    });
  }

  get settings() {
    return this.config.get('reminder') || {};
  }

  /**
   * @param note optional secondary line, e.g. a running death tally.
   */
  trigger({ message, note } = {}) {
    const s = this.settings;
    const text = message || s.text || 'Do 5 pushups';
    if (s.showOverlay !== false) this.showOverlay(text, note);
    if (s.speak) this.speak(text);
  }

  showOverlay(message, note) {
    if (!this.win || this.win.isDestroyed()) return;
    this.reposition();
    this.win.webContents.send('overlay:show', { message, note: note || '' });
    // showInactive keeps the game focused; show() would not.
    if (!this.win.isVisible()) this.win.showInactive();
    this.win.setAlwaysOnTop(true, 'screen-saver');

    const seconds = Math.max(1, Math.min(30, Number(this.settings.seconds) || 4));
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), seconds * 1000);
  }

  hide() {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send('overlay:hide');
    // Let the fade finish before pulling the window.
    setTimeout(() => {
      if (this.win && !this.win.isDestroyed()) this.win.hide();
    }, 220);
  }

  /** Windows SAPI. Fire-and-forget; a stuck voice must never block the app. */
  speak(text) {
    const safe = String(text).replace(/[^\p{L}\p{N} ,.!?'-]/gu, ' ').slice(0, 120);
    if (!safe.trim()) return;
    const script = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      '$s.Rate = 1',
      '$s.Speak($env:LOCKIN_SAY)'
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    try {
      if (this.speaking && !this.speaking.killed) this.speaking.kill();
    } catch { /* already gone */ }
    this.speaking = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 15000, env: { ...process.env, LOCKIN_SAY: safe } },
      () => { this.speaking = null; }
    );
  }

  destroy() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    try { if (this.speaking && !this.speaking.killed) this.speaking.kill(); } catch { /* ignore */ }
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { Reminder };
