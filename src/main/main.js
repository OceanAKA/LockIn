'use strict';
const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, shell, session,
  Tray, Menu, nativeImage
} = require('electron');

// The app was called ValoTunes before it grew past Valorant. Renaming it moves
// the profile directory, so carry the old one over on first run.
//
// This MUST happen at module load, before Electron initialises OSCrypt: the
// Spotify refresh token is encrypted with a key kept in Chromium's "Local
// State", and if that file isn't already in place a fresh key gets generated
// and the token becomes undecryptable.
(function migrateLegacyProfile() {
  try {
    const target = app.getPath('userData');
    if (fs.existsSync(path.join(target, 'config.json'))) return;   // already carried over
    const legacy = path.join(app.getPath('appData'), 'valotunes');
    if (!fs.existsSync(path.join(legacy, 'config.json'))) return;  // nothing to rescue
    fs.mkdirSync(target, { recursive: true });
    for (const f of ['config.json', 'Local State']) {
      const src = path.join(legacy, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(target, f));
    }
  } catch { /* fresh install */ }
})();

const { Config, KILL_REGIONS } = require('./config');
const { MediaSession } = require('./mediaSession');
const { Reminder } = require('./reminder');
const { DeathEdge } = require('./deathEdge');
const { Ocr } = require('./ocr');
const { parseKilledBy, canonical } = require('./killedBy');
const { readCounts } = require('./clutch');
const { HypeMode } = require('./hype');
const { Controller } = require('./controller');
const { GameManager } = require('./games');
const { GAMES, GAME_IDS } = require('./games/defs');
const { LOG_PATH } = require('./logWatcher');

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');

let win = null;
let captureWin = null;
let tray = null;
let config, media, games, controller, reminder, hype;
let hypeTimer = null;
let hypeBusy = false;
let pixelSeq = 0;
const pixelWaiters = new Map();
let lastHypePreview = null;        // what the 1v1 scanner last saw, for the settings pane
const deathEdge = new DeathEdge();
let deathCount = 0;                // this session only

const ocr = new Ocr();
let ocrTimer = null;
let ocrBusy = false;
let grabSeq = 0;
const grabWaiters = new Map();
let lastKiller = null;             // most recent parse, shown in the UI
let bannerSeen = false;            // banner currently on screen
let ocrError = null;

/** The only playback backend now: Windows' system media controls. */
function activePlayer() { return media; }

let captureError = null;
let mediaSessions = [];            // cached; each refresh costs a PowerShell spawn

// The default face of the app is a small corner widget; settings expand it.
const COMPACT = { width: 320, height: 150 };
const EXPANDED = { width: 560, height: 820 };
const EDGE_MARGIN = 16;

/** Sizes and parks the window for whichever mode is active. */
function applyWindowMode() {
  if (!win || win.isDestroyed()) return;
  const compact = config.get('compact') !== false;
  const { workArea } = screen.getPrimaryDisplay();
  const size = compact ? COMPACT : EXPANDED;

  win.setResizable(!compact);
  // A bare setAlwaysOnTop(true) silently fails to stick on this Windows build,
  // and so does the 'floating' level; 'screen-saver' is the one that holds.
  if (config.get('alwaysOnTop')) win.setAlwaysOnTop(true, 'screen-saver');
  else win.setAlwaysOnTop(false);

  if (compact) {
    // Bottom-right corner of the work area, clear of the taskbar.
    win.setBounds({
      x: Math.round(workArea.x + workArea.width - size.width - EDGE_MARGIN),
      y: Math.round(workArea.y + workArea.height - size.height - EDGE_MARGIN),
      ...size
    });
  } else {
    const b = win.getBounds();
    win.setBounds({
      x: Math.max(workArea.x, Math.min(b.x, workArea.x + workArea.width - size.width)),
      y: Math.max(workArea.y, Math.min(b.y, workArea.y + workArea.height - size.height)),
      ...size
    });
  }
}

function createWindow({ hidden = false } = {}) {
  const compact = config.get('compact') !== false;
  win = new BrowserWindow({
    ...(compact ? COMPACT : EXPANDED),
    minWidth: COMPACT.width,
    title: 'Lock In',
    icon: ICON_PATH,
    show: false,
    frame: false,              // custom titlebar; the widget has no chrome
    resizable: !compact,
    skipTaskbar: false,
    backgroundColor: '#0f1114',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => {
    applyWindowMode();
    if (!hidden) win.show();
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // Closing really quits. The hidden capture window means 'window-all-closed'
  // would never fire on its own, so say so explicitly rather than leaving the
  // app running invisibly and still driving Spotify.
  win.on('close', () => { app.isQuitting = true; app.quit(); });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

function startWithWindows(value) {
  if (value === undefined) return app.getLoginItemSettings().openAtLogin;
  app.setLoginItemSettings({ openAtLogin: !!value, args: ['--hidden'] });
  return !!value;
}

function trayTooltip() {
  if (!controller) return 'Lock In';
  const s = controller.status();
  const g = s.game ? GAMES[s.game].name : 'no game';
  const music = s.desired === null ? 'standing by'
    : (s.desired ? 'music on' : 'music off');
  return 'Lock In — ' + g + ' — ' + music;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show Lock In', click: showWindow },
    { label: 'Hide to tray', click: () => { if (win) win.hide(); } },
    { type: 'separator' },
    {
      label: 'Keep on top of other windows',
      type: 'checkbox',
      checked: !!config.get('alwaysOnTop'),
      click: item => {
        config.set('alwaysOnTop', item.checked);
        applyWindowMode();
        pushState();
      }
    },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: startWithWindows(),
      click: item => { startWithWindows(item.checked); pushState(); }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
}

function createTray() {
  const img = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Lock In');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function createCaptureWindow() {
  captureWin = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'capture', 'preload.js'),
      backgroundThrottling: false
    }
  });
  captureWin.loadFile(path.join(__dirname, '..', 'capture', 'capture.html'));
  captureWin.on('closed', () => { captureWin = null; });
}

/** Auto-grants the primary screen so capture never shows a picker dialog. */
function installDisplayHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const primaryId = String(screen.getPrimaryDisplay().id);
      const source = sources.find(s => s.display_id === primaryId) || sources[0];
      callback(source ? { video: source } : {});
    } catch {
      callback({});
    }
  }, { useSystemPicker: false });
}

// --- screen capture -------------------------------------------------------

let lastCaptureCfg = null;

/**
 * Pushes capture settings to the hidden grabber, but only when they actually
 * change, so it is safe to call from every code path that could affect them.
 *
 * It has to be cheap and idempotent: whether capture should run depends on the
 * round phase, and missing a single call leaves the stream off for the whole
 * match — which is exactly how death detection silently stopped working.
 */
function syncCapture() {
  if (!captureWin || captureWin.isDestroyed()) return;
  // The grabber only needs to be streaming while something wants to read the
  // screen: the death-text poller or the 1v1 scanner.
  const cfg = { active: killTrackerOn() || hypeScanOn() };
  const key = JSON.stringify(cfg);
  if (key === lastCaptureCfg) return;
  lastCaptureCfg = key;
  captureWin.webContents.send('capture:configure', cfg);
}

// --- "KILLED BY" tracking -------------------------------------------------

/** Asks the capture window for a PNG of the configured region. */
function grabRegion(region, maxWidth) {
  if (!captureWin || captureWin.isDestroyed()) return Promise.reject(new Error('no capture window'));
  const id = ++grabSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      grabWaiters.delete(id);
      reject(new Error('grab timeout'));
    }, 5000);
    grabWaiters.set(id, { resolve, reject, timer });
    captureWin.webContents.send('capture:grab', { id, region, maxWidth });
  });
}

/** True when the "KILLED BY" banner is the authoritative alive/dead source. */
function ocrOwnsDeath() {
  const k = config.get('killTracker') || {};
  return !!k.enabled && k.useAsDeathSignal !== false;
}

/** The wording that means "you died" for a given game, '' if it has none. */
function deathPhraseFor(gameId) {
  if (!gameId) return '';
  const g = config.game(gameId);
  return (g && g.deathPhrase) || '';
}

function killTrackerOn() {
  const k = config.get('killTracker') || {};
  return !!k.enabled && !!games.activeId && controller.phase === 'live'
    && !!deathPhraseFor(games.activeId);
}

function syncOcr() {
  const on = killTrackerOn();
  if (on && !ocrTimer) {
    const ms = Math.max(500, Math.min(5000, (config.get('killTracker') || {}).pollMs || 1200));
    ocr.start();
    ocrTimer = setInterval(pollKilledBy, ms);
  } else if (!on && ocrTimer) {
    clearInterval(ocrTimer);
    ocrTimer = null;
    bannerSeen = false;
  }
}

async function pollKilledBy() {
  if (ocrBusy || !killTrackerOn()) return;
  ocrBusy = true;
  try {
    const k = config.get('killTracker');
    const { dataUrl, error } = await grabRegion(k.region, 1280);
    if (error) throw new Error(error);
    const png = Buffer.from(dataUrl.split(',')[1], 'base64');
    const text = await ocr.recognize(png);
    ocrError = null;

    const hit = parseKilledBy(text, deathPhraseFor(games.activeId));
    if (!hit) {
      bannerSeen = false;
      // In Valorant the report can be dismissed with [N], so its absence proves
      // nothing and death is only ever asserted from positive evidence. A
      // screen-only game has no such key and no log to fall back on, so there
      // the banner clearing is the only signal that you respawned.
      const def = GAMES[games.activeId];
      if (def && def.source === 'screen') games.setScreenLabel('alive');
      return;
    }
    if (bannerSeen) return;          // same death, already recorded
    bannerSeen = true;
    recordKill(hit);
  } catch (e) {
    ocrError = e.message;
  } finally {
    ocrBusy = false;
  }
}

function recordKill(hit) {
  const label = hit.player || hit.name;
  lastKiller = { label, agent: hit.name, player: hit.player || null, at: Date.now() };

  const tally = { ...(config.get('killTally') || {}) };
  const key = canonical(label);
  const prev = tally[key] || { label, agent: hit.name, player: hit.player || null, count: 0 };
  tally[key] = {
    label,
    agent: hit.name,
    player: hit.player || prev.player || null,
    count: prev.count + 1
  };
  config.set('killTally', tally);

  // Seeing the banner is proof of death — nothing to calibrate, nothing to guess.
  if ((config.get('killTracker') || {}).useAsDeathSignal) {
    games.setScreenLabel('dead');
  }
  pushState();
}

// --- hype mode: 1v1 scan ----------------------------------------------------

function grabPixels(region, { maxWidth = 960, preview = false } = {}) {
  if (!captureWin || captureWin.isDestroyed()) return Promise.reject(new Error('no capture window'));
  const id = ++pixelSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pixelWaiters.delete(id);
      reject(new Error('pixel grab timeout'));
    }, 5000);
    pixelWaiters.set(id, { resolve, reject, timer });
    captureWin.webContents.send('capture:pixels', { id, region, maxWidth, preview });
  });
}

/** Scan only while it could matter: hype on, Valorant live, and you are alive. */
function hypeScanOn() {
  const h = config.get('hype') || {};
  return !!h.enabled && games.activeId === 'valorant' &&
    controller.phase === 'live' && controller.alive === true;
}

function syncHype() {
  const on = hypeScanOn();
  if (on && !hypeTimer) {
    const ms = Math.max(300, Math.min(3000, (config.get('hype') || {}).pollMs || 700));
    hypeTimer = setInterval(pollClutch, ms);
    pollClutch();
  } else if (!on && hypeTimer) {
    clearInterval(hypeTimer);
    hypeTimer = null;
  }
  // Leaving the live-and-alive state ends any clutch in progress.
  if (!on) hype.reset();
}

/** The two alive-count pills, mirrored about the screen's centre line. */
function pillRegions() {
  const p = (config.get('hype') || {}).pills || {};
  const off = p.offset ?? 0.07, top = p.top ?? 0.018, w = p.w ?? 0.05, h = p.h ?? 0.062;
  return {
    left:  { x: 0.5 - off - w / 2, y: top, w, h },
    right: { x: 0.5 + off - w / 2, y: top, w, h }
  };
}

async function readPills(opts = {}) {
  const { left, right } = pillRegions();
  const [l, r] = await Promise.all([grabPixels(left, opts), grabPixels(right, opts)]);
  if (l.error) throw new Error(l.error);
  if (r.error) throw new Error(r.error);
  const reading = readCounts(
    { rgba: l.data, width: l.width, height: l.height },
    { rgba: r.data, width: r.width, height: r.height }
  );
  return { reading, l, r };
}

async function pollClutch() {
  if (hypeBusy || !hypeScanOn()) return;
  hypeBusy = true;
  try {
    const { reading } = await readPills();
    hype.update(reading, { phase: controller.phase, alive: controller.alive });
  } catch (e) {
    hype.lastError = e.message;
  } finally {
    hypeBusy = false;
  }
}

/** Fires the reminder on the alive -> dead edge of a live round. */
function noteDeath(s) {
  if (!deathEdge.update(s)) return;

  deathCount++;
  const r = config.get('reminder') || {};
  if (!r.enabled) return;

  const reps = extractReps(r.text);
  const bits = [];
  // The OCR poll may land a moment after the death edge, so accept a recent hit.
  if (lastKiller && Date.now() - lastKiller.at < 8000) {
    bits.push('killed by ' + lastKiller.label);
  }
  if (r.countDeaths) {
    bits.push(reps
      ? 'death ' + deathCount + ' · ' + (deathCount * reps) + ' owed'
      : 'death ' + deathCount);
  }
  reminder.trigger({ message: r.text, note: bits.join('  ·  ') });
}

/** Pulls the rep count out of the message so the tally can add up. */
function extractReps(text) {
  const m = /(\d+)/.exec(String(text || ''));
  return m ? parseInt(m[1], 10) : 0;
}

async function refreshMediaSessions() {
  try { mediaSessions = await media.listSessions(); }
  catch { mediaSessions = []; }
}

// --- UI state -------------------------------------------------------------

function pushState() {
  if (tray && !tray.isDestroyed()) tray.setToolTip(trayTooltip());
  if (!win || win.isDestroyed()) return;
  const view = config.publicView();
  const gs = games.status();
  win.webContents.send('state:update', {
    config: view,
    status: { ...controller.status(), ...gs },
    gameDefs: GAME_IDS.map(id => ({
      id,
      name: GAMES[id].name,
      source: GAMES[id].source,
      deathText: GAMES[id].deathText,
      hasPrep: GAMES[id].hasPrep,
      prepLabel: GAMES[id].prepLabel
    })),
    playerReady: media.connected,
    mediaSessions,
    logPath: LOG_PATH,
    captureError,
    startWithWindows: startWithWindows(),
    deathCount,
    hype: hype.status(),
    hypePreview: lastHypePreview,
    lastKiller,
    killTally: config.get('killTally') || {},
    ocrReady: ocr.ready,
    ocrLang: ocr.lang,
    ocrError
  });
}

function wire() {
  config = new Config();
  media = new MediaSession(config);
  reminder = new Reminder(config);
  hype = new HypeMode(config);
  controller = new Controller(config, activePlayer, () => hype.overridesPlayback);
  games = new GameManager(config);

  games.syncSettings();
  refreshMediaSessions().then(pushState);

  games.on('state', s => {
    noteDeath(s);
    controller.setState({ game: s.game, phase: s.phase, alive: s.alive });
    syncOcr();
    syncHype();
    syncCapture();      // needsScreen depends on the phase that just changed
    pushState();
  });

  // A clutch starting or ending changes what the controller wants, and the
  // reminder card doubles as the LOCK IN banner.
  hype.on('change', ({ active }) => {
    controller.schedule(0);
    const h = config.get('hype') || {};
    if (active && h.showCard !== false) {
      reminder.trigger({ message: h.cardText || '1v1 - LOCK IN', note: 'hype mode' });
    }
    pushState();
  });
  hype.on('error', () => pushState());
  hype.audioSink = cmd => {
    if (captureWin && !captureWin.isDestroyed()) captureWin.webContents.send('audio:cmd', cmd);
  };
  games.on('active', s => {
    controller.setState({ game: s.game, phase: s.phase, alive: s.alive });
    syncOcr();
    syncHype();
    syncCapture();
    pushState();
  });
  games.start();

  controller.on('desired', () => pushState());
  controller.on('applied', () => pushState());
  controller.on('error', () => pushState());

  ipcMain.on('capture:error', (_e, msg) => { captureError = msg; pushState(); });

  ipcMain.on('capture:pixels-out', (_e, payload) => {
    const w = pixelWaiters.get(payload && payload.id);
    if (!w) return;
    pixelWaiters.delete(payload.id);
    clearTimeout(w.timer);
    w.resolve(payload);
  });

  ipcMain.on('audio:state', (_e, st) => {
    if (st && st.error) hype.lastError = st.error;
    pushState();
  });

  ipcMain.on('capture:grabbed', (_e, payload) => {
    const w = grabWaiters.get(payload && payload.id);
    if (!w) return;
    grabWaiters.delete(payload.id);
    clearTimeout(w.timer);
    w.resolve(payload);
  });

  // ---- UI channels -------------------------------------------------------
  ipcMain.handle('ui:getState', () => { pushState(); return true; });

  ipcMain.handle('ui:setConfig', (_e, patch) => {
    const master = 'enabled' in patch && patch.enabled !== config.get('enabled');
    config.update(patch);
    if (master) {
      // Switching the master off must release playback rather than leave it
      // wherever the last decision put it.
      if (!patch.enabled) controller.desired = null;
      controller.resync();
      syncOcr();
      syncCapture();
    } else {
      controller.schedule(0);
    }
    if ('compact' in patch || 'alwaysOnTop' in patch) applyWindowMode();
    pushState();
    return true;
  });

  ipcMain.handle('ui:setReminder', (_e, patch) => {
    config.set('reminder', { ...config.get('reminder'), ...patch });
    pushState();
    return true;
  });

  ipcMain.handle('ui:testReminder', () => {
    const r = config.get('reminder') || {};
    reminder.trigger({ message: r.text, note: r.countDeaths ? 'preview' : '' });
    return true;
  });

  ipcMain.handle('ui:resetDeaths', () => { deathCount = 0; pushState(); return true; });

  ipcMain.handle('ui:setKillTracker', (_e, patch) => {
    const next = { ...config.get('killTracker'), ...patch };
    // Picking a preset rewrites the actual coordinates.
    if (patch.regionPreset && KILL_REGIONS[patch.regionPreset]) {
      next.region = { ...KILL_REGIONS[patch.regionPreset] };
    }
    config.set('killTracker', next);
    syncOcr();
    syncCapture();
    pushState();
    return true;
  });

  ipcMain.handle('ui:setHype', (_e, patch) => {
    const cur = config.get('hype');
    const next = { ...cur, ...patch };
    if (patch.pills) next.pills = { ...cur.pills, ...patch.pills };
    config.set('hype', next);
    syncHype();
    syncCapture();
    controller.schedule(0);
    pushState();
    return true;
  });

  /** Grabs the HUD band right now and reports what the scanner sees. */
  ipcMain.handle('ui:previewClutch', async () => {
    try {
      // The stream may be idle if no round is live; wake it for this read.
      if (captureWin && !captureWin.isDestroyed()) {
        captureWin.webContents.send('capture:configure', { active: true });
        lastCaptureCfg = null;
      }
      const { reading, l, r } = await readPills({ preview: true });
      lastHypePreview = {
        left:  { dataUrl: l.preview, width: l.width, height: l.height, box: reading.allies.box,  isOne: reading.alliesOne,  found: reading.allies.found },
        right: { dataUrl: r.preview, width: r.width, height: r.height, box: reading.enemies.box, isOne: reading.enemiesOne, found: reading.enemies.found },
        clutch: reading.clutch
      };
      syncCapture();
      pushState();
      return {
        ok: true,
        allies: reading.allies.found ? (reading.alliesOne ? '1' : '2+') : 'none',
        enemies: reading.enemies.found ? (reading.enemiesOne ? '1' : '2+') : 'none',
        clutch: reading.clutch
      };
    } catch (e) {
      syncCapture();
      return { ok: false, error: e.message };
    }
  });

  /** Fires the hype sequence as if a 1v1 just began; stops itself shortly after. */
  ipcMain.handle('ui:testHype', () => {
    hype.active = false;
    hype.update({ clutch: true }, { phase: 'live', alive: true });
    setTimeout(() => hype.reset(), 8000);
    return true;
  });

  ipcMain.handle('ui:clearTally', () => {
    config.set('killTally', {});
    lastKiller = null;
    pushState();
    return true;
  });

  ipcMain.handle('ui:testOcr', async () => {
    try {
      const k = config.get('killTracker');
      const { dataUrl, error } = await grabRegion(k.region, 1280);
      if (error) throw new Error(error);
      const png = Buffer.from(dataUrl.split(',')[1], 'base64');
      const text = await ocr.recognize(png);
      const hit = parseKilledBy(text, deathPhraseFor(games.activeId));
      return {
        ok: true,
        found: !!hit,
        killer: hit ? (hit.player || hit.name) : null,
        agent: hit ? hit.name : null,
        chars: text.length,
        preview: text.replace(/\s+/g, ' ').trim().slice(0, 90)
      };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('ui:refreshMediaSessions', async () => {
    await refreshMediaSessions();
    pushState();
    return mediaSessions;
  });

  ipcMain.handle('ui:setGame', (_e, { game, patch }) => {
    if (!GAMES[game]) return false;
    config.setGame(game, patch);
    games.syncSettings();
    syncCapture();
    controller.schedule(0);
    pushState();
    return true;
  });





  ipcMain.handle('ui:setStartWithWindows', (_e, value) => {
    startWithWindows(value);
    if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
    pushState();
    return true;
  });

  ipcMain.handle('ui:hideToTray', () => { if (win) win.hide(); return true; });

  ipcMain.handle('ui:minimize', () => { if (win) win.minimize(); return true; });

  ipcMain.handle('ui:setCompact', (_e, compact) => {
    config.set('compact', !!compact);
    applyWindowMode();
    pushState();
    return true;
  });

  ipcMain.handle('ui:quit', () => { app.isQuitting = true; app.quit(); return true; });

  ipcMain.handle('ui:testSpotify', async () => {
    try {
      const state = await media.getState();
      if (!state || state._noDevice) {
        return { ok: false, error: 'No player found. Start a video or track, then retry.' };
      }
      return { ok: true, device: state.device && state.device.name, playing: state.is_playing };
    } catch (e) { return { ok: false, error: e.message }; }
  });
}

// Two copies would fight over Spotify, and autostart makes that easy to hit.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    installDisplayHandler();
    wire();
    // Launched by the autostart entry: come up in the tray, not in your face.
    const hidden = process.argv.includes('--hidden') ||
      app.getLoginItemSettings().wasOpenedAtLogin;
    createWindow({ hidden });
    createCaptureWindow();
    reminder.create();
    createTray();
    setInterval(() => { syncCapture(); pushState(); }, 1000);
  });

  app.on('before-quit', () => {
    games && games.stop();
    reminder && reminder.destroy();
    if (hypeTimer) clearInterval(hypeTimer);
    hype && hype.reset();
    if (ocrTimer) clearInterval(ocrTimer);
    ocr.stop();
    if (tray && !tray.isDestroyed()) tray.destroy();   // no ghost tray icon
  });
  app.on('window-all-closed', () => app.quit());
  app.on('activate', showWindow);
}
