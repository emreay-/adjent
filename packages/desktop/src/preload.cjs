// Preload (CommonJS - Electron sandboxed preload). Exposes the one-way state
// push, the view switch, settings writes, two panel controls, and the one
// request/response call (tier-3 limit detail). Nothing else crosses the bridge.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adjent', {
  onState: (cb) => ipcRenderer.on('state', (_e, payload) => cb(payload)),
  onView: (cb) => ipcRenderer.on('view', (_e, view) => cb(view)),
  close: () => ipcRenderer.send('panel:close'),
  refresh: () => ipcRenderer.send('panel:refresh'),
  setSettings: (patch) => ipcRenderer.send('settings:set', patch),
  openPanel: () => ipcRenderer.send('widget:open-panel'),
  openTaskbarSettings: () => ipcRenderer.send('help:taskbar'),
  clearAlarms: () => ipcRenderer.send('alarms:clear'),
  // Tier 3 is pull, not push: the panel asks for one limit's history and
  // exact token split only when the user opens it.
  limitDetail: (key) => ipcRenderer.invoke('limit:detail', key),
});
