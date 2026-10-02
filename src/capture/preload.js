'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  onConfigure: cb => ipcRenderer.on('capture:configure', (_e, cfg) => cb(cfg)),
  sendError: msg => ipcRenderer.send('capture:error', msg),
  // Full-colour region grab, used for OCR of the death banner.
  onGrab: cb => ipcRenderer.on('capture:grab', (_e, req) => cb(req)),
  sendGrab: payload => ipcRenderer.send('capture:grabbed', payload),
  // Raw RGBA of a region, for the alive-count scan of the top HUD.
  onPixels: cb => ipcRenderer.on('capture:pixels', (_e, req) => cb(req)),
  sendPixels: payload => ipcRenderer.send('capture:pixels-out', payload),
  // Local-file playback for hype mode; this hidden window is always alive.
  onAudio: cb => ipcRenderer.on('audio:cmd', (_e, cmd) => cb(cmd)),
  sendAudio: payload => ipcRenderer.send('audio:state', payload)
});
