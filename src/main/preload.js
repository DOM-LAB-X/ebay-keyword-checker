'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveWatch: (watch) => ipcRenderer.invoke('watch:save', watch),
  deleteWatch: (id) => ipcRenderer.invoke('watch:delete', id),
  toggleWatch: (id, enabled) => ipcRenderer.invoke('watch:toggle', id, enabled),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  checkNow: () => ipcRenderer.invoke('check:now'),
  checkWatch: (id) => ipcRenderer.invoke('check:watch', id),
  togglePause: () => ipcRenderer.invoke('check:pause'),
  testWebhook: (url) => ipcRenderer.invoke('webhook:test', url),
  clearMatches: () => ipcRenderer.invoke('matches:clear'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
});
