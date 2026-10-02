'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/**
 * Text recognition using the OCR engine built into Windows
 * (`Windows.Media.Ocr`) — no bundled model, no native module.
 *
 * Recognition itself is single-digit milliseconds, but starting PowerShell
 * costs a few hundred, so one worker process is kept alive and fed image paths
 * over stdin. That's what makes polling during a round affordable.
 *
 * Requests are answered in order, so pending promises are matched FIFO.
 */

const WORKER = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$m = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {',
  '  $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and',
  "  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' }",
  '$asTaskGeneric = $m[0]',
  'function Await($t, $rt) {',
  '  $at = $asTaskGeneric.MakeGenericMethod($rt)',
  '  $nt = $at.Invoke($null, @($t))',
  '  $nt.Wait(-1) | Out-Null',
  '  $nt.Result }',
  '[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null',
  '[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null',
  '[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType=WindowsRuntime] | Out-Null',
  '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
  'if (-not $engine) {',
  '  [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ ready = $false; error = "no OCR language installed" } -Compress))',
  '  exit 0 }',
  '[Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ ready = $true; lang = [string]$engine.RecognizerLanguage.DisplayName } -Compress))',
  '[Console]::Out.Flush()',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line -or $line -eq "quit") { break }',
  '  try {',
  '    $sf = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($line)) ([Windows.Storage.StorageFile])',
  '    $st = Await ($sf.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
  '    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($st)) ([Windows.Graphics.Imaging.BitmapDecoder])',
  '    $sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
  '    $res = Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])',
  '    $st.Dispose()',
  '    $out = ConvertTo-Json -InputObject @{ ok = $true; text = [string]$res.Text } -Compress',
  '  } catch {',
  '    $out = ConvertTo-Json -InputObject @{ ok = $false; error = [string]$_.Exception.Message } -Compress',
  '  }',
  '  [Console]::Out.WriteLine($out)',
  '  [Console]::Out.Flush()',
  '}'
].join('\n');

class Ocr {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.lang = null;
    this.lastError = null;
    this.queue = [];              // pending {resolve, reject, timer}
    this.buffer = '';
    this.readyWaiters = [];
    this.seq = 0;
    this.dir = os.tmpdir();
  }

  /**
   * A fresh filename per request. Reusing one path races the worker, which may
   * still hold a handle on the previous image when the next write lands.
   */
  nextPath() {
    this.seq = (this.seq + 1) % 1e6;
    return path.join(this.dir, 'lockin-ocr-' + process.pid + '-' + this.seq + '.png');
  }

  start() {
    if (this.proc) return;
    const encoded = Buffer.from(WORKER, 'utf16le').toString('base64');
    this.proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', chunk => this.onData(chunk));
    this.proc.on('exit', () => {
      this.proc = null;
      this.ready = false;
      this.failAll('OCR worker exited');
    });
    this.proc.on('error', e => {
      this.lastError = e.message;
      this.proc = null;
      this.ready = false;
      this.failAll(e.message);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.ready !== undefined) {
        this.ready = !!msg.ready;
        this.lang = msg.lang || null;
        if (!this.ready) this.lastError = msg.error || 'OCR unavailable';
        for (const w of this.readyWaiters.splice(0)) w(this.ready);
        continue;
      }

      const pending = this.queue.shift();
      if (!pending) continue;
      clearTimeout(pending.timer);
      if (pending.file) fs.unlink(pending.file, () => {});
      if (msg.ok) pending.resolve(String(msg.text || ''));
      else pending.reject(new Error(msg.error || 'OCR failed'));
    }
  }

  failAll(reason) {
    for (const p of this.queue.splice(0)) {
      clearTimeout(p.timer);
      if (p.file) fs.unlink(p.file, () => {});
      p.reject(new Error(reason));
    }
    for (const w of this.readyWaiters.splice(0)) w(false);
  }

  whenReady(timeoutMs = 15000) {
    if (this.ready) return Promise.resolve(true);
    if (!this.proc) this.start();
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(this.ready), timeoutMs);
      this.readyWaiters.push(v => { clearTimeout(t); resolve(v); });
    });
  }

  /** @param pngBuffer full PNG bytes of the region to read. */
  async recognize(pngBuffer, { timeoutMs = 8000 } = {}) {
    if (!this.proc) this.start();
    if (!this.ready && !(await this.whenReady())) {
      throw new Error(this.lastError || 'OCR not ready');
    }
    const file = this.nextPath();
    fs.writeFileSync(file, pngBuffer);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex(p => p.timer === timer);
        if (idx >= 0) this.queue.splice(idx, 1);
        fs.unlink(file, () => {});
        reject(new Error('OCR timeout'));
      }, timeoutMs);
      this.queue.push({ resolve, reject, timer, file });
      try {
        this.proc.stdin.write(file + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.queue.pop();
        fs.unlink(file, () => {});
        reject(e);
      }
    });
  }

  stop() {
    this.failAll('stopped');
    if (!this.proc) return;
    try { this.proc.stdin.write('quit\n'); } catch { /* already gone */ }
    const p = this.proc;
    this.proc = null;
    this.ready = false;
    setTimeout(() => { try { if (!p.killed) p.kill(); } catch { /* ignore */ } }, 500);
  }
}

module.exports = { Ocr };
