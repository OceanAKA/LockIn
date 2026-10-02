'use strict';
/**
 * Generates build/icon.ico (and icon.png) for packaging.
 *
 * The artwork is drawn on a canvas at each required size rather than scaled
 * from one bitmap, so the small sizes stay crisp — a 16px icon downscaled from
 * 256px turns to mush. The .ico container embeds PNG-compressed entries, which
 * Windows has accepted since Vista.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const OUT_DIR = __dirname;

const DRAW = `
function draw(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const S = size;

  // Rounded dark tile.
  const r = S * 0.22;
  x.beginPath();
  x.moveTo(r, 0);
  x.arcTo(S, 0, S, S, r);
  x.arcTo(S, S, 0, S, r);
  x.arcTo(0, S, 0, 0, r);
  x.arcTo(0, 0, S, 0, r);
  x.closePath();
  const g = x.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, '#1b2029');
  g.addColorStop(1, '#0e1116');
  x.fillStyle = g;
  x.fill();

  // Equaliser bars — reads as "audio" even at 16px.
  const heights = [0.34, 0.62, 0.46, 0.78];
  const barW = S * 0.108;
  const gap = S * 0.068;
  const total = heights.length * barW + (heights.length - 1) * gap;
  let bx = (S - total) / 2;
  const midY = S * 0.54;
  x.fillStyle = '#1DB954';
  for (const h of heights) {
    const bh = S * h;
    const by = midY - bh / 2;
    const rr = Math.min(barW / 2, S * 0.05);
    x.beginPath();
    x.moveTo(bx + rr, by);
    x.arcTo(bx + barW, by, bx + barW, by + bh, rr);
    x.arcTo(bx + barW, by + bh, bx, by + bh, rr);
    x.arcTo(bx, by + bh, bx, by, rr);
    x.arcTo(bx, by, bx + barW, by, rr);
    x.closePath();
    x.fill();
    bx += barW + gap;
  }
  return c.toDataURL('image/png').split(',')[1];
}
JSON.stringify([${SIZES.join(',')}].map(draw));
`;

/** Minimal ICO container around already-encoded PNG buffers. */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;

  entries.forEach((e, i) => {
    const o = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o);      // 0 means 256
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
    dir.writeUInt8(0, o + 2);              // palette size
    dir.writeUInt8(0, o + 3);              // reserved
    dir.writeUInt16LE(1, o + 4);           // colour planes
    dir.writeUInt16LE(32, o + 6);          // bits per pixel
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });

  return Buffer.concat([header, dir, ...entries.map(e => e.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 300, height: 300 });
  await win.loadURL('data:text/html,<body></body>');

  const b64list = JSON.parse(await win.webContents.executeJavaScript(DRAW));
  const entries = b64list.map((b64, i) => ({
    size: SIZES[i],
    data: Buffer.from(b64, 'base64')
  }));

  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(entries));
  const big = entries[entries.length - 1];
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), big.data);

  console.log('icon.ico  sizes: ' + SIZES.join(', '));
  console.log('icon.ico  bytes: ' + fs.statSync(path.join(OUT_DIR, 'icon.ico')).size);
  console.log('icon.png  bytes: ' + big.data.length);
  app.quit();
});
