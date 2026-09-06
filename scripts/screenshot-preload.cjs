const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('adjent', {
  onState: (callback) => ipcRenderer.invoke('preview:state').then(callback),
  onView: () => {},
  close: () => {},
  refresh: () => {},
  setSettings: () => {},
  openPanel: () => {},
  openTaskbarSettings: () => {},
  clearAlarms: () => {},
  limitDetail: () => Promise.resolve(null),
  rulesLoad: () => Promise.resolve({ text: '', diagnostics: [], effective: { rules: [] } }),
  rulesCheck: () => Promise.resolve({ diagnostics: [], effective: { rules: [] } }),
  rulesSave: () => Promise.resolve({ ok: false }),
  rulesPreset: () => Promise.resolve(null),
  rulesPresets: () => Promise.resolve([]),
});
