'use strict';
const { execFile } = require('child_process');

/**
 * Playback control via Windows' Global System Media Transport Controls.
 *
 * YouTube has no local API to drive, but every browser playing it registers a
 * system media session — the same one the volume-flyout media widget shows. So
 * this backend controls YouTube in any browser, YouTube Music, the Spotify
 * desktop app, or anything else that registers a session, with no account, no
 * Premium, and no browser extension.
 *
 * Play and Pause here are explicit commands rather than a media-key toggle, so
 * the app can't drift out of sync with what's actually playing.
 *
 * WinRT is reached through PowerShell because Electron has no binding for it;
 * a spawn costs roughly half a second, which is immaterial next to round
 * transitions that are tens of seconds apart.
 */

const PRELUDE = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$m = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {',
  '  $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and',
  // Single quotes matter: in a double-quoted PowerShell string the backtick is
  // an escape character and this type name would be mangled.
  "  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' }",
  '$asTaskGeneric = $m[0]',
  'function Await($t, $rt) {',
  '  $at = $asTaskGeneric.MakeGenericMethod($rt)',
  '  $nt = $at.Invoke($null, @($t))',
  '  $nt.Wait(-1) | Out-Null',
  '  $nt.Result }',
  '[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media, ContentType = WindowsRuntime] | Out-Null',
  '$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])',
  '$sessions = @($mgr.GetSessions())',
  // Prefer an explicitly chosen app; otherwise whatever is actually playing;
  // otherwise whatever Windows considers current.
  'function Pick($appId) {',
  '  if ($appId) {',
  '    $s = $sessions | Where-Object { $_.SourceAppUserModelId -eq $appId } | Select-Object -First 1',
  '    if ($s) { return $s } }',
  '  $p = $sessions | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq "Playing" } | Select-Object -First 1',
  '  if ($p) { return $p }',
  '  $c = $mgr.GetCurrentSession()',
  '  if ($c) { return $c }',
  '  return ($sessions | Select-Object -First 1) }'
].join('\n');

const SCRIPTS = {
  list: [
    '$out = $sessions | ForEach-Object {',
    '  $i = $_.GetPlaybackInfo()',
    '  [pscustomobject]@{ appId = [string]$_.SourceAppUserModelId; status = [string]$i.PlaybackStatus } }',
    'ConvertTo-Json -InputObject @($out) -Compress'
  ].join('\n'),

  play: [
    '$s = Pick $env:LOCKIN_APPID',
    'if (-not $s) { Write-Output \'{"ok":false,"error":"no media session"}\'; exit 0 }',
    '$r = Await ($s.TryPlayAsync()) ([bool])',
    'ConvertTo-Json -InputObject @{ ok = [bool]$r; appId = [string]$s.SourceAppUserModelId } -Compress'
  ].join('\n'),

  pause: [
    '$s = Pick $env:LOCKIN_APPID',
    'if (-not $s) { Write-Output \'{"ok":false,"error":"no media session"}\'; exit 0 }',
    '$r = Await ($s.TryPauseAsync()) ([bool])',
    'ConvertTo-Json -InputObject @{ ok = [bool]$r; appId = [string]$s.SourceAppUserModelId } -Compress'
  ].join('\n')
};

/** Friendly names for the app ids Windows reports. */
function friendlyName(appId) {
  if (!appId) return 'Unknown';
  const id = String(appId);
  const known = [
    [/spotify/i, 'Spotify'],
    [/brave/i, 'Brave'],
    [/chrome/i, 'Chrome'],
    [/msedge|edge/i, 'Edge'],
    [/firefox/i, 'Firefox'],
    [/opera/i, 'Opera'],
    [/zen/i, 'Zen'],
    [/vivaldi/i, 'Vivaldi'],
    [/youtube/i, 'YouTube Music'],
    [/vlc/i, 'VLC'],
    [/foobar/i, 'foobar2000'],
    [/musicbee/i, 'MusicBee'],
    [/itunes|apple/i, 'Apple Music']
  ];
  for (const [re, name] of known) if (re.test(id)) return name;
  return id.replace(/\.exe$/i, '').split('!').pop().split('_')[0];
}

class MediaSession {
  constructor(config) {
    this.config = config;
    this.lastError = null;
    this.available = process.platform === 'win32';
  }

  /** The system media layer needs no account, so it's ready whenever Windows is. */
  get connected() { return this.available; }

  run(kind, { timeoutMs = 8000 } = {}) {
    // Wrapped so failures arrive as JSON on stdout. PowerShell otherwise
    // serialises its error stream as CLIXML, which hides the actual message.
    const script = [
      'try {',
      PRELUDE,
      SCRIPTS[kind],
      '} catch {',
      '  ConvertTo-Json -InputObject @{ ok = $false; error = [string]$_.Exception.Message } -Compress',
      '}'
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const env = { ...process.env, LOCKIN_APPID: this.config.get('mediaAppId') || '' };

    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 20 },
        (err, stdout) => {
          const text = (stdout || '').trim();
          if (!text) {
            reject(new Error(err ? 'PowerShell failed: ' + err.message : 'no output'));
            return;
          }
          let parsed;
          try { parsed = JSON.parse(text); }
          catch { reject(new Error('unexpected output: ' + text.slice(0, 160))); return; }
          if (parsed && parsed.ok === false && parsed.error) {
            reject(new Error(parsed.error));
            return;
          }
          resolve(parsed);
        }
      );
    });
  }

  async listSessions() {
    const raw = await this.run('list');
    const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    return arr
      .filter(s => s && s.appId)
      .map(s => ({ appId: s.appId, name: friendlyName(s.appId), status: s.status }));
  }

  async play() {
    const r = await this.run('play');
    if (!r || !r.ok) throw new Error((r && r.error) || 'Nothing is playing — start a video or track first.');
    return null;
  }

  async pause() {
    const r = await this.run('pause');
    if (!r || !r.ok) throw new Error((r && r.error) || 'No media session to pause.');
    return null;
  }

  /** Mirrors the Spotify client's shape so the controller can treat them alike. */
  async getState() {
    const sessions = await this.listSessions();
    if (!sessions.length) return { _noDevice: true };
    const target = this.config.get('mediaAppId');
    const picked = sessions.find(s => s.appId === target)
      || sessions.find(s => s.status === 'Playing')
      || sessions[0];
    return { device: { name: picked.name }, is_playing: picked.status === 'Playing' };
  }
}

module.exports = { MediaSession, friendlyName };
