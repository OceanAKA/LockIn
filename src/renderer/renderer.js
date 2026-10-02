'use strict';
const $ = id => document.getElementById(id);

let state = null;
let selectedGame = null;      // null = follow the active game
const dirty = new Set();      // fields the user is mid-edit; don't clobber them

const PHASE_LABEL = {
  off: 'not running', menu: 'menus', prep: 'buy phase',
  live: 'match live', end: 'between rounds'
};
const SOURCE_NOTE = {
  log: 'Rounds come from the game log — exact.',
  api: "Alive and dead come straight from Riot's local API — exact, nothing to set up.",
  screen: 'This game encrypts its logs, so on-screen text is the only handle.'
};

function el(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of [].concat(kids)) if (kid) n.appendChild(kid);
  return n;
}

function setField(el, text, cls) {
  el.textContent = text;
  el.className = cls || '';
}

// --- status bar -----------------------------------------------------------

function renderStatus(s) {
  const def = s.gameDefs.find(g => g.id === s.status.activeGame);
  setField($('activeGame'), def ? def.name : 'none', def ? 'ok' : 'dim');

  const phase = s.status.phase || 'off';
  setField($('phase'), PHASE_LABEL[phase] || phase,
    phase === 'off' ? 'dim' : (phase === 'live' ? 'warn' : 'ok'));

  const alive = s.status.alive;
  if (!def || phase === 'off') setField($('alive'), '—', 'dim');
  else if (alive === null) setField($('alive'), 'unknown', 'warn');
  else setField($('alive'), alive ? 'alive' : 'dead', alive ? 'ok' : 'bad');

  if (!s.config.enabled) setField($('verdict'), 'off', 'dim');
  else if (!(s.mediaSessions || []).length) setField($('verdict'), 'no player', 'bad');
  else if (s.status.desired === null) setField($('verdict'), 'standing by', 'dim');
  else if (s.status.desired) setField($('verdict'), 'playing', 'ok');
  else setField($('verdict'), 'paused', 'bad');

  const err = s.status.lastError || s.captureError || s.ocrError;
  $('err').textContent = err || '';
  $('err').classList.toggle('hidden', !err);
}

// --- music ----------------------------------------------------------------

function renderMusic(s) {
  const sel = $('mediaAppId');
  const wanted = s.config.mediaAppId || '';
  const opts = [{ appId: '', name: 'Automatic — whatever is playing', status: '' }]
    .concat(s.mediaSessions || []);
  // Rebuild only on a real change, so it can't fight the user mid-selection.
  const signature = opts.map(o => o.appId + ':' + o.status).join('|') + '>' + wanted;
  if (sel.dataset.signature !== signature) {
    sel.dataset.signature = signature;
    sel.textContent = '';
    for (const o of opts) {
      sel.appendChild(el('option', {
        value: o.appId,
        text: o.status ? o.name + '  (' + o.status.toLowerCase() + ')' : o.name
      }));
    }
    if (wanted && !opts.some(o => o.appId === wanted)) {
      sel.appendChild(el('option', { value: wanted, text: wanted + '  (not running)' }));
    }
    sel.value = wanted;
  }
  $('test').disabled = !s.playerReady;
}

// --- death detection ------------------------------------------------------

function renderDeath(s) {
  const k = s.config.killTracker || {};
  $('kEnabled').checked = !!k.enabled;
  $('kDeathSignal').checked = k.useAsDeathSignal !== false;
  for (const id of ['kDeathSignal', 'kRegion', 'kTest']) $(id).disabled = !k.enabled;
  if ($('kRegion').value !== (k.regionPreset || 'right')) {
    $('kRegion').value = k.regionPreset || 'right';
  }

  const ocr = $('kOcr');
  if (s.ocrError) { ocr.textContent = 'error'; ocr.className = 'pill bad'; }
  else if (s.ocrReady) { ocr.textContent = s.ocrLang || 'ready'; ocr.className = 'pill ok'; }
  else { ocr.textContent = k.enabled ? 'starting…' : 'off'; ocr.className = 'pill' + (k.enabled ? ' warn' : ''); }

  const lk = s.lastKiller;
  $('kLast').textContent = lk ? lk.label : '—';
  $('kLast').className = 'pill' + (lk ? ' bad' : '');

  const rows = Object.values(s.killTally || {}).sort((a, b) => b.count - a.count).slice(0, 10);
  const box = $('kTally');
  const sig = rows.map(r => r.label + ':' + r.count).join('|');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.textContent = '';
  if (!rows.length) {
    box.appendChild(el('p', { class: 'note', text: 'Nothing yet.' }));
    return;
  }
  for (const r of rows) {
    const who = el('span', { class: 'who', text: r.label });
    if (r.agent && r.agent !== r.label) who.appendChild(el('small', { text: '  ' + r.agent }));
    box.appendChild(el('div', { class: 'row' }, [
      who, el('b', { class: 'pill', text: r.count + '×' })
    ]));
  }
}

// --- hype mode ------------------------------------------------------------

let lastPreviewKey = null;

function renderHype(s) {
  const h = s.config.hype || {};
  const st = s.hype || {};
  $('hEnabled').checked = !!h.enabled;
  if (!dirty.has('hSource')) $('hSource').value = h.source || '';
  const pills = h.pills || {};
  if (!dirty.has('hOffset')) $('hOffset').value = ((pills.offset ?? 0.07) * 100).toFixed(1);
  if (!dirty.has('hTop')) $('hTop').value = ((pills.top ?? 0.018) * 100).toFixed(1);
  $('hCard').checked = h.showCard !== false;
  for (const id of ['hSource', 'hTest', 'hScan', 'hOffset', 'hTop', 'hCard']) {
    $(id).disabled = !h.enabled;
  }

  const state = $('hState');
  if (!h.enabled) { state.textContent = 'off'; state.className = 'pill'; }
  else if (st.active) { state.textContent = 'HYPE'; state.className = 'pill ok'; }
  else if (st.source === 'none') { state.textContent = 'no music set'; state.className = 'pill warn'; }
  else { state.textContent = 'watching'; state.className = 'pill'; }

  // Only a "1" can be identified for certain; anything wider shows as 2+.
  const c = st.counts;
  const side = r => !r || !r.found ? '—' : (r.isOne ? '1' : '2+');
  $('hCounts').textContent = c ? side(c.allies) + ' / ' + side(c.enemies) : '—';
  $('hCounts').className = 'pill' + (c && c.clutch ? ' ok' : '');

  if (st.lastError && !$('hResult').textContent) $('hResult').textContent = 'Problem: ' + st.lastError;

  // Scanner preview: each pill crop with the digit it found outlined.
  const pv = s.hypePreview;
  const wrap = $('hPreviewWrap');
  if (!pv || !pv.left || !pv.left.dataUrl) { wrap.classList.add('hidden'); return; }
  const key = pv.left.dataUrl.length + ':' + pv.right.dataUrl.length + ':' + pv.clutch;
  if (key === lastPreviewKey) return;
  lastPreviewKey = key;
  wrap.classList.remove('hidden');
  drawPill($('hPreviewL'), pv.left);
  drawPill($('hPreviewR'), pv.right);
}

function drawPill(cv, p) {
  const img = new Image();
  img.onload = () => {
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    if (p.box) {
      ctx.lineWidth = Math.max(2, img.width / 60);
      ctx.strokeStyle = p.isOne ? '#1db954' : '#ffb43c';
      ctx.strokeRect(p.box.x - 2, p.box.y - 2, p.box.w + 4, p.box.h + 4);
    }
  };
  img.src = p.dataUrl;
}

// --- reminder + app -------------------------------------------------------

function renderApp(s) {
  const r = s.config.reminder || {};
  $('rEnabled').checked = r.enabled !== false;
  if (!dirty.has('rText')) $('rText').value = r.text || '';
  if (!dirty.has('rSeconds')) $('rSeconds').value = r.seconds;
  $('rOverlay').checked = r.showOverlay !== false;
  $('rSpeak').checked = !!r.speak;
  $('rCount').checked = !!r.countDeaths;
  $('rDeaths').value = String(s.deathCount || 0);
  for (const id of ['rText', 'rSeconds', 'rOverlay', 'rSpeak', 'rCount', 'rTest']) {
    $(id).disabled = r.enabled === false;
  }

  $('alwaysOnTop').checked = !!s.config.alwaysOnTop;
  $('startWithWindows').checked = !!s.startWithWindows;
}

// --- per-game -------------------------------------------------------------

function renderTabs(s) {
  const tabs = $('tabs');
  tabs.textContent = '';
  const shown = selectedGame || s.status.activeGame || s.gameDefs[0].id;
  for (const def of s.gameDefs) {
    const running = def.id === s.status.activeGame;
    tabs.appendChild(el('button', {
      class: 'tab' + (def.id === shown ? ' on' : '') + (running ? ' running' : ''),
      text: def.name + (running ? ' ●' : ''),
      onclick: () => { selectedGame = def.id; render(state); }
    }));
  }
  return shown;
}

function renderGamePanel(s, gameId) {
  // This panel is rebuilt from scratch, so redrawing it while the phrase field
  // has focus would throw away whatever is being typed.
  if (dirty.has('phrase:' + gameId)) return;

  const def = s.gameDefs.find(g => g.id === gameId);
  const g = s.config.games[gameId];
  const panel = $('gamePanel');
  panel.textContent = '';

  panel.appendChild(el('p', { class: 'note', text: SOURCE_NOTE[def.source] }));

  const check = (key, text) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = !!g[key];
    input.addEventListener('change', () => window.api.setGame(gameId, { [key]: input.checked }));
    return el('label', { class: 'check' }, [input, el('span', { text })]);
  };

  panel.appendChild(check('enabled', 'Watch this game'));
  panel.appendChild(el('div', { class: 'sep' }));
  panel.appendChild(el('h2', { text: 'Play music when' }));
  panel.appendChild(check('playInMenus', 'In menus, lobby or character select'));
  if (def.hasPrep) panel.appendChild(check('playInPrep', def.prepLabel));
  panel.appendChild(check('playWhenDead', "I'm dead"));

  if (!def.deathText) return;   // League reads death from the API

  panel.appendChild(el('div', { class: 'sep' }));
  panel.appendChild(el('h2', { text: 'Death text' }));
  panel.appendChild(el('p', {
    class: 'note',
    text: gameId === 'valorant'
      ? 'The wording shown on the death screen. Valorant says "KILLED BY".'
      : 'Whatever this game prints when you die. Leave blank to skip death detection here.'
  }));
  const phrase = el('input', { placeholder: 'e.g. KILLED BY' });
  phrase.value = g.deathPhrase || '';
  phrase.addEventListener('focus', () => dirty.add('phrase:' + gameId));
  phrase.addEventListener('blur', () => {
    dirty.delete('phrase:' + gameId);
    window.api.setGame(gameId, { deathPhrase: phrase.value.trim() });
  });
  phrase.addEventListener('keydown', e => { if (e.key === 'Enter') phrase.blur(); });
  panel.appendChild(phrase);
}

// --- compact widget -------------------------------------------------------

function renderCompact(s) {
  const on = s.config.enabled !== false;
  document.body.classList.toggle('compact', s.config.compact !== false);
  $('power').classList.toggle('on', on);
  $('powerLabel').textContent = on ? 'ON' : 'OFF';

  const def = s.gameDefs.find(g => g.id === s.status.activeGame);
  $('cGame').textContent = def ? def.name : 'nothing detected';

  const m = $('cMusic');
  if (!on) { m.textContent = 'off'; m.className = 'cmusic'; }
  else if (!(s.mediaSessions || []).length) { m.textContent = 'no player found'; m.className = 'cmusic'; }
  else if (s.status.desired === null) { m.textContent = 'standing by'; m.className = 'cmusic'; }
  else if (s.status.desired) { m.textContent = 'music playing'; m.className = 'cmusic playing'; }
  else { m.textContent = 'music paused'; m.className = 'cmusic paused'; }
}

// --- wiring ---------------------------------------------------------------

function render(s) {
  state = s;
  renderCompact(s);
  if (s.config.compact !== false) return;   // settings pane isn't visible
  renderStatus(s);
  renderMusic(s);
  renderDeath(s);
  renderHype(s);
  renderApp(s);
  renderGamePanel(s, renderTabs(s));
}

for (const tab of document.querySelectorAll('.navtab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.navtab')) t.classList.toggle('on', t === tab);
    for (const p of document.querySelectorAll('.pane')) {
      p.classList.toggle('on', p.dataset.pane === tab.dataset.pane);
    }
  });
}

function bindText(id, apply, parse) {
  const e = $(id);
  e.addEventListener('focus', () => dirty.add(id));
  e.addEventListener('blur', () => { dirty.delete(id); apply(parse(e.value)); });
  e.addEventListener('keydown', ev => { if (ev.key === 'Enter') e.blur(); });
}

// music
$('mediaAppId').addEventListener('change', () =>
  window.api.setConfig({ mediaAppId: $('mediaAppId').value }));
$('refreshSessions').addEventListener('click', () => window.api.refreshMediaSessions());
$('test').addEventListener('click', async () => {
  $('testResult').textContent = 'Checking…';
  const r = await window.api.testSpotify();
  $('testResult').textContent = r.ok
    ? 'OK — "' + r.device + '", ' + (r.playing ? 'playing' : 'paused') + '.'
    : 'Problem: ' + r.error;
});

// death detection
$('kEnabled').addEventListener('change', () =>
  window.api.setKillTracker({ enabled: $('kEnabled').checked }));
$('kDeathSignal').addEventListener('change', () =>
  window.api.setKillTracker({ useAsDeathSignal: $('kDeathSignal').checked }));
$('kRegion').addEventListener('change', () =>
  window.api.setKillTracker({ regionPreset: $('kRegion').value }));
$('kClear').addEventListener('click', () => window.api.clearTally());
$('kTest').addEventListener('click', async () => {
  $('kTest').disabled = true;
  $('kResult').textContent = 'Reading the screen…';
  const r = await window.api.testOcr();
  if (!r.ok) $('kResult').textContent = 'Problem: ' + r.error;
  else if (r.found) {
    $('kResult').textContent = 'Found it — killed by ' + r.killer +
      (r.agent && r.agent !== r.killer ? ' (' + r.agent + ')' : '');
  } else {
    $('kResult').textContent = 'No death text on screen right now. Read ' +
      r.chars + ' characters: "' + r.preview + '"';
  }
  $('kTest').disabled = false;
});

// hype mode
$('hEnabled').addEventListener('change', () =>
  window.api.setHype({ enabled: $('hEnabled').checked }));
$('hCard').addEventListener('change', () =>
  window.api.setHype({ showCard: $('hCard').checked }));
bindText('hSource', v => window.api.setHype({ source: v }), v => v.trim());
bindText('hOffset', v => window.api.setHype({ pills: { offset: v } }),
         v => Math.max(0.02, Math.min(0.2, (Number(v) || 7) / 100)));
bindText('hTop', v => window.api.setHype({ pills: { top: v } }),
         v => Math.max(0, Math.min(0.1, (Number(v) || 1.8) / 100)));
$('hTest').addEventListener('click', async () => {
  $('hResult').textContent = 'Dropping the hype track for 8 seconds…';
  await window.api.testHype();
});
$('hScan').addEventListener('click', async () => {
  $('hScan').disabled = true;
  $('hResult').textContent = 'Reading the top of the screen…';
  const r = await window.api.previewClutch();
  $('hResult').textContent = r.ok
    ? 'Your side: ' + r.allies + '   Their side: ' + r.enemies +
      (r.clutch ? "   -  that's a 1v1." : (r.allies === 'none' && r.enemies === 'none' ? '   (no digits - is a round live?)' : ''))
    : 'Problem: ' + r.error;
  $('hScan').disabled = false;
});

// reminder
for (const pair of [['rEnabled', 'enabled'], ['rOverlay', 'showOverlay'],
                    ['rSpeak', 'speak'], ['rCount', 'countDeaths']]) {
  $(pair[0]).addEventListener('change', () =>
    window.api.setReminder({ [pair[1]]: $(pair[0]).checked }));
}
bindText('rText', v => window.api.setReminder({ text: v }), v => v.trim() || 'Do 5 pushups');
bindText('rSeconds', v => window.api.setReminder({ seconds: v }),
         v => Math.max(1, Math.min(30, Number(v) || 4)));
$('rTest').addEventListener('click', () => window.api.testReminder());
$('rReset').addEventListener('click', () => window.api.resetDeaths());

// app / window
$('alwaysOnTop').addEventListener('change', () =>
  window.api.setConfig({ alwaysOnTop: $('alwaysOnTop').checked }));
$('startWithWindows').addEventListener('change', () =>
  window.api.setStartWithWindows($('startWithWindows').checked));
$('toTray').addEventListener('click', () => window.api.hideToTray());

// chrome
$('power').addEventListener('click', () =>
  window.api.setConfig({ enabled: !(state && state.config.enabled !== false) }));
$('btnSettings').addEventListener('click', () => {
  const isCompact = !(state && state.config.compact === false);
  window.api.setCompact(!isCompact);
});
$('btnTray').addEventListener('click', () => window.api.minimize());
$('btnQuit').addEventListener('click', () => window.api.quit());

window.api.onState(render);
window.api.getState();
