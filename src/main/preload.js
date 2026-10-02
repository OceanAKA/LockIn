'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onState: cb => ipcRenderer.on('state:update', (_e, s) => cb(s)),
  getState: () => ipcRenderer.invoke('ui:getState'),
  setConfig: patch => ipcRenderer.invoke('ui:setConfig', patch),
  setGame: (game, patch) => ipcRenderer.invoke('ui:setGame', { game, patch }),
  testSpotify: () => ipcRenderer.invoke('ui:testSpotify'),
  refreshMediaSessions: () => ipcRenderer.invoke('ui:refreshMediaSessions'),
  setReminder: patch => ipcRenderer.invoke('ui:setReminder', patch),
  testReminder: () => ipcRenderer.invoke('ui:testReminder'),
  resetDeaths: () => ipcRenderer.invoke('ui:resetDeaths'),
  setKillTracker: patch => ipcRenderer.invoke('ui:setKillTracker', patch),
  clearTally: () => ipcRenderer.invoke('ui:clearTally'),
  testOcr: () => ipcRenderer.invoke('ui:testOcr'),
  setHype: patch => ipcRenderer.invoke('ui:setHype', patch),
  previewClutch: () => ipcRenderer.invoke('ui:previewClutch'),
  testHype: () => ipcRenderer.invoke('ui:testHype'),
  setStartWithWindows: v => ipcRenderer.invoke('ui:setStartWithWindows', v),
  hideToTray: () => ipcRenderer.invoke('ui:hideToTray'),
  minimize: () => ipcRenderer.invoke('ui:minimize'),
  setCompact: v => ipcRenderer.invoke('ui:setCompact', v),
  quit: () => ipcRenderer.invoke('ui:quit')
});
