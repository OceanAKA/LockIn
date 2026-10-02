'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onShow: cb => ipcRenderer.on('overlay:show', (_e, payload) => cb(payload)),
  onHide: cb => ipcRenderer.on('overlay:hide', () => cb())
});
