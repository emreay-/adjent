// Preload (CommonJS — Electron sandboxed preload). Exposes the one-way state
// push and two panel controls; nothing else crosses the bridge.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adjent', {
  onState: (cb) => ipcRenderer.on('state', (_e, payload) => cb(payload)),
  close: () => ipcRenderer.send('panel:close'),
  refresh: () => ipcRenderer.send('panel:refresh'),
});
