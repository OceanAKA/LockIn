'use strict';
/* Hidden worker: owns the screen-capture stream, answers region grabs for OCR
   and for the alive-count scan, and plays hype-mode audio files. */

const video = document.getElementById('v');

let stream = null;

async function ensureStream() {
  if (stream) return stream;
  stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 10 },
    audio: false
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

// Kept only so the stream is warm before the first grab is asked for.
window.capture.onConfigure(async cfg => {
  if (!cfg.active) return;
  try { await ensureStream(); }
  catch (e) { window.capture.sendError('Screen capture unavailable: ' + e.message); }
});

/* --- full-colour region grab for OCR ------------------------------------ */

const grabCanvas = document.createElement('canvas');
const grabCtx = grabCanvas.getContext('2d');

window.capture.onGrab(async req => {
  const id = req && req.id;
  try {
    await ensureStream();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) { window.capture.sendGrab({ id, error: 'no video frame yet' }); return; }

    const r = (req && req.region) || { x: 0, y: 0, w: 1, h: 1 };
    const sx = Math.max(0, Math.round(r.x * vw));
    const sy = Math.max(0, Math.round(r.y * vh));
    const sw = Math.max(1, Math.min(vw - sx, Math.round(r.w * vw)));
    const sh = Math.max(1, Math.min(vh - sy, Math.round(r.h * vh)));

    // OCR cost scales with pixel count, so wide regions are capped — but small
    // text (the alive counts by the timer) reads better upscaled, so an explicit
    // scale is honoured when given.
    const maxW = (req && req.maxWidth) || 1280;
    const scale = (req && req.scale) || Math.min(1, maxW / sw);
    grabCanvas.width = Math.max(1, Math.round(sw * scale));
    grabCanvas.height = Math.max(1, Math.round(sh * scale));
    grabCtx.drawImage(video, sx, sy, sw, sh, 0, 0, grabCanvas.width, grabCanvas.height);

    window.capture.sendGrab({ id, dataUrl: grabCanvas.toDataURL('image/png') });
  } catch (e) {
    window.capture.sendGrab({ id, error: e.message });
  }
});

/* --- raw pixels for the HUD alive-count scan --------------------------- */

const pxCanvas = document.createElement('canvas');
const pxCtx = pxCanvas.getContext('2d', { willReadFrequently: true });

window.capture.onPixels(async req => {
  const id = req && req.id;
  try {
    await ensureStream();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) { window.capture.sendPixels({ id, error: 'no video frame yet' }); return; }

    const r = req.region;
    const sx = Math.max(0, Math.round(r.x * vw));
    const sy = Math.max(0, Math.round(r.y * vh));
    const sw = Math.max(1, Math.min(vw - sx, Math.round(r.w * vw)));
    const sh = Math.max(1, Math.min(vh - sy, Math.round(r.h * vh)));

    const scale = Math.min(1, (req.maxWidth || 960) / sw);
    pxCanvas.width = Math.max(1, Math.round(sw * scale));
    pxCanvas.height = Math.max(1, Math.round(sh * scale));
    pxCtx.drawImage(video, sx, sy, sw, sh, 0, 0, pxCanvas.width, pxCanvas.height);
    const img = pxCtx.getImageData(0, 0, pxCanvas.width, pxCanvas.height);

    window.capture.sendPixels({
      id, width: img.width, height: img.height, data: img.data,
      preview: req.preview ? pxCanvas.toDataURL('image/png') : null
    });
  } catch (e) {
    window.capture.sendPixels({ id, error: e.message });
  }
});

/* --- hype-mode local audio ---------------------------------------------- */

const audio = document.getElementById('a');
let playlist = [];
let cursor = -1;

function playNext() {
  if (!playlist.length) return;
  cursor = (cursor + 1) % playlist.length;
  audio.src = playlist[cursor];
  audio.play().then(
    () => window.capture.sendAudio({ playing: true, track: playlist[cursor] }),
    e => window.capture.sendAudio({ playing: false, error: e.message })
  );
}

audio.addEventListener('ended', playNext);
audio.addEventListener('error', () => {
  window.capture.sendAudio({ playing: false, error: 'could not play ' + audio.src });
  if (playlist.length > 1) playNext();
});

window.capture.onAudio(cmd => {
  if (cmd.action === 'play') {
    playlist = (cmd.files || []).slice();
    // Shuffle so the same opener doesn't play every clutch.
    for (let i = playlist.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playlist[i], playlist[j]] = [playlist[j], playlist[i]];
    }
    cursor = -1;
    audio.volume = Math.max(0, Math.min(1, cmd.volume == null ? 1 : cmd.volume));
    playNext();
  } else if (cmd.action === 'stop') {
    playlist = [];
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    window.capture.sendAudio({ playing: false });
  }
});
