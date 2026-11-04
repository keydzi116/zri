'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, fn) => {
  const h = (_e, d) => fn(d);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

const I18N = ipcRenderer.sendSync('i18n') || { lang: 'en', strings: {} };
function t(key, ...args) {
  let s = I18N.strings[key] != null ? I18N.strings[key] : key;
  args.forEach((a, i) => { s = s.replace(`{${i}}`, a); });
  return s;
}

contextBridge.exposeInMainWorld('zri', {
  platform: process.platform,
  lang: I18N.lang,
  t,

  getSettings: () => ipcRenderer.invoke('settings-get'),
  setSettings: (patch) => ipcRenderer.invoke('settings-set', patch),
  onSettings: (fn) => on('settings', fn),

  getSources: () => ipcRenderer.invoke('get-sources'),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  permissions: () => ipcRenderer.invoke('permissions'),
  openPrivacy: (kind) => ipcRenderer.invoke('open-privacy', kind),
  relaunch: () => ipcRenderer.invoke('relaunch'),
  shortcuts: () => ipcRenderer.invoke('shortcuts'),
  onShortcuts: (fn) => on('shortcuts', fn),
  showControls: (o) => ipcRenderer.invoke('rec-controls', o),

  // recording
  setCaptureTarget: (t) => ipcRenderer.invoke('capture-target', t),
  prepare: (o) => ipcRenderer.invoke('rec-prepare', o),
  countdown: () => ipcRenderer.invoke('rec-countdown'),
  begin: (o) => ipcRenderer.invoke('rec-begin', o),
  chunk: (u8) => ipcRenderer.send('rec-chunk', u8),
  state: (s) => ipcRenderer.send('rec-state', s),
  level: (v) => ipcRenderer.send('rec-level', v),
  finish: (o) => ipcRenderer.invoke('rec-finish', o),
  abort: () => ipcRenderer.invoke('rec-abort'),
  fail: () => ipcRenderer.invoke('rec-fail'),
  onCommand: (fn) => on('rec-command', fn),
  onRecState: (fn) => on('rec-state', fn),
  onLevel: (fn) => on('rec-level', fn),
  onProgress: (fn) => on('processing-progress', fn),
  onRecovered: (fn) => on('recovered', fn),
  command: (cmd) => ipcRenderer.send('command', cmd),

  // files
  openFile: (f) => ipcRenderer.invoke('open-file', f),
  showInFolder: (f) => ipcRenderer.invoke('show-in-folder', f),
  openSaveDir: () => ipcRenderer.invoke('open-save-dir'),
  saveDir: () => ipcRenderer.invoke('save-dir'),
  chooseSaveDir: () => ipcRenderer.invoke('choose-save-dir'),

  // window
  minimize: () => ipcRenderer.send('win-minimize'),
  close: () => ipcRenderer.send('win-close'),

  // camera bubble
  bubble: {
    move: (x, y) => ipcRenderer.send('bubble-move', { x, y }),
    moveEnd: () => ipcRenderer.send('bubble-move-end'),
    resize: (delta) => ipcRenderer.send('bubble-resize', delta),
    shape: () => ipcRenderer.send('bubble-shape'),
    mirror: () => ipcRenderer.send('bubble-mirror'),
    hide: () => ipcRenderer.send('bubble-hide'),
  },

  // overlay
  onMouse: (fn) => on('ov-mouse', fn),
  onCursor: (fn) => on('ov-cursor', fn),
  onCountdown: (fn) => on('ov-countdown', fn),
});
