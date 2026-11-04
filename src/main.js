'use strict';
const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut,
  shell, systemPreferences, Notification, dialog, session, powerSaveBlocker,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { createMouseWatcher } = require('./mouse');
const { STRINGS, pickLang, makeT } = require('./i18n');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const APP_NAME = 'Zri';
const UI = (f) => path.join(__dirname, 'ui', f);
const PRELOAD = path.join(__dirname, 'preload.js');

// Recording runs in a window that is hidden while recording — never throttle it.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setName(APP_NAME);
if (IS_WIN) app.setAppUserModelId('com.zri.recorder');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  boot();
}

function boot() {
  // ---------------------------------------------------------------- settings
  const DEFAULTS = {
    sourceId: null,
    cameraOn: true,
    cameraId: null,
    micOn: true,
    micId: null,
    systemAudio: IS_WIN,
    noiseSuppression: true,
    fps: 30,
    quality: 'native', // native | 1080 | 720
    highlightClicks: true,
    highlightCursor: false,
    clickColor: '#ffd23f',
    countdown: true,
    saveDir: null,
    bubble: { size: 220, shape: 'circle', mirror: true, x: null, y: null },
    lang: 'auto', // auto | en | ru
  };
  const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
  let settings = loadSettings();
  let saveTimer = null;

  function loadSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
      return { ...DEFAULTS, ...raw, bubble: { ...DEFAULTS.bubble, ...(raw.bubble || {}) } };
    } catch {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
        fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
      } catch (e) { log('settings save failed', e.message); }
    }, 250);
  }
  async function writable(d) {
    try {
      await fs.promises.mkdir(d, { recursive: true });
      const probe = path.join(d, `.zri-${process.pid}-${Date.now()}`);
      await fs.promises.writeFile(probe, 'ok');
      await fs.promises.unlink(probe);
      return true;
    } catch { return false; }
  }
  let saveDirCache = null;
  function wantedSaveDir() {
    return settings.saveDir && fs.existsSync(settings.saveDir) ? settings.saveDir : app.getPath('desktop');
  }
  // Desktop may be blocked by macOS privacy settings — fall back to Movies/Zri, then app data.
  async function resolveSaveDir() {
    const want = wantedSaveDir();
    const candidates = [want, path.join(app.getPath('videos'), 'Zri'), path.join(app.getPath('userData'), 'Videos')];
    let dir = want;
    for (const d of candidates) { if (await writable(d)) { dir = d; break; } }
    saveDirCache = { want, dir };
    return dir;
  }
  function saveDir() {
    const want = wantedSaveDir();
    return saveDirCache && saveDirCache.want === want ? saveDirCache.dir : want;
  }
  function tmpDir() {
    const d = path.join(app.getPath('userData'), 'recording-temp');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  function log(...a) { console.log('[zri]', ...a); }

  // ---------------------------------------------------------------- language
  function systemLocales() {
    const env = process.env.ZRI_LANG ? [process.env.ZRI_LANG] : [];
    let sys = [];
    try { sys = app.getPreferredSystemLanguages(); } catch {}
    if (!sys.length) { try { sys = [app.getLocale()]; } catch {} }
    return [...env, ...sys];
  }
  let lang = pickLang(settings.lang, systemLocales());
  let t = makeT(lang);
  ipcMain.on('i18n', (e) => { e.returnValue = { lang, strings: STRINGS[lang] }; });

  function ffmpegPath() {
    const exe = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';
    if (app.isPackaged) return path.join(process.resourcesPath, 'ffmpeg', exe);
    return path.join(__dirname, '..', 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`, exe);
  }

  // ---------------------------------------------------------------- hotkeys
  const activeKeys = {};
  function keyLabel(acc) {
    if (!acc) return '';
    return IS_MAC
      ? acc.replace('Control+', '⌃').replace('Alt+', '⌥').replace('Shift+', '⇧').replace('Command+', '⌘')
      : acc.replace('Control+', 'Ctrl+');
  }
  function shortcutLabels() {
    return Object.fromEntries(Object.entries(activeKeys).map(([k, v]) => [k, keyLabel(v)]));
  }

  // ---------------------------------------------------------------- windows
  let panelWin = null;
  let bubbleWin = null;
  let controlsWin = null;
  const overlays = new Map(); // displayId -> BrowserWindow
  let quitting = false;

  const rec = {
    active: false, paused: false, file: null, out: null, bytes: 0,
    mime: '', displayId: null, startedAt: 0, finishing: false,
  };
  let captureTarget = { sourceId: null, systemAudio: false };

  function broadcast(channel, data) {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, data);
    }
  }

  function createPanel() {
    panelWin = new BrowserWindow({
      width: 400, height: 720, minWidth: 380, minHeight: 600,
      show: false, frame: false, resizable: true, maximizable: false,
      fullscreenable: false, backgroundColor: '#0f1012', title: 'Zri',
      icon: path.join(__dirname, '..', 'build', 'icon.png'),
      webPreferences: { preload: PRELOAD, backgroundThrottling: false },
    });
    panelWin.loadFile(UI('panel.html'));
    panelWin.once('ready-to-show', () => { if (!process.env.ZRI_HIDDEN) panelWin.show(); });
    panelWin.on('close', (e) => {
      if (rec.active && !quitting) { e.preventDefault(); stopFromAnywhere(); }
    });
    panelWin.on('closed', () => { panelWin = null; if (!quitting) app.quit(); });
    panelWin.webContents.on('render-process-gone', (_e, d) => {
      log('panel renderer gone', d.reason);
      if (rec.active) emergencyFinalize();
    });
  }

  // macOS: NSPanel-type windows float over full-screen apps, don't steal focus,
  // and take the first click without needing to activate Zri first.
  const FLOAT = IS_MAC ? { type: 'panel', acceptFirstMouse: true } : {};
  function floatOnTop(w) {
    w.setAlwaysOnTop(true, 'screen-saver');
    if (IS_MAC) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }

  // ---- camera bubble
  const BUBBLE_PAD = 16;
  function bubbleDims() {
    const s = Math.round(settings.bubble.size);
    if (settings.bubble.shape === 'wide') {
      const h = Math.round(s * 0.78);
      return { w: Math.round(h * 16 / 9), h };
    }
    return { w: s, h: s };
  }
  function defaultBubblePos(d) {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x + 32, y: wa.y + wa.height - d.h - BUBBLE_PAD * 2 - 32 };
  }
  function clampToScreens(x, y, w, h, strict = false) {
    const disp = screen.getDisplayNearestPoint({ x: Math.round(x + w / 2), y: Math.round(y + h / 2) });
    const wa = strict ? disp.workArea : disp.bounds;
    const over = strict ? -BUBBLE_PAD : 0.4;
    const ox = strict ? -over : w * over, oy = strict ? -over : h * over;
    const nx = Math.min(Math.max(x, wa.x - ox), wa.x + wa.width - w + ox);
    const ny = Math.min(Math.max(y, wa.y - oy), wa.y + wa.height - h + oy);
    return { x: Math.round(nx), y: Math.round(ny) };
  }
  function bubbleBounds() {
    const d = bubbleDims();
    const W = d.w + BUBBLE_PAD * 2, H = d.h + BUBBLE_PAD * 2;
    let { x, y } = settings.bubble;
    if (x == null || y == null) {
      const p = defaultBubblePos(d); x = p.x; y = p.y;
    } else {
      const visible = screen.getAllDisplays().some((disp) => {
        const b = disp.bounds;
        return x + W / 2 > b.x && x + W / 2 < b.x + b.width && y + H / 2 > b.y && y + H / 2 < b.y + b.height;
      });
      if (!visible) { const p = defaultBubblePos(d); x = p.x; y = p.y; }
    }
    return { x: Math.round(x), y: Math.round(y), width: W, height: H };
  }
  function ensureBubble() {
    if (!settings.cameraOn) {
      if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.destroy(); // releases the webcam
      bubbleWin = null;
      return;
    }
    if (!bubbleWin || bubbleWin.isDestroyed()) {
      const b = bubbleBounds();
      bubbleWin = new BrowserWindow({
        ...FLOAT, ...b, frame: false, transparent: true, resizable: false, maximizable: false,
        minimizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false,
        alwaysOnTop: true, show: false, title: 'Zri camera', backgroundColor: '#00000000',
        webPreferences: { preload: PRELOAD, backgroundThrottling: false },
      });
      floatOnTop(bubbleWin);
      bubbleWin.loadFile(UI('bubble.html'));
      bubbleWin.once('ready-to-show', () => bubbleWin && bubbleWin.showInactive());
      bubbleWin.on('closed', () => { bubbleWin = null; });
    } else {
      if (!bubbleWin.isVisible()) bubbleWin.showInactive();
    }
  }
  function resizeBubble(newSize) {
    const old = bubbleWin && !bubbleWin.isDestroyed() ? bubbleWin.getBounds() : null;
    settings.bubble.size = Math.max(120, Math.min(600, Math.round(newSize)));
    if (old) {
      const d = bubbleDims();
      const W = d.w + BUBBLE_PAD * 2, H = d.h + BUBBLE_PAD * 2;
      const cx = old.x + old.width / 2, cy = old.y + old.height / 2;
      const p = clampToScreens(cx - W / 2, cy - H / 2, W, H, true);
      bubbleWin.setBounds({ x: p.x, y: p.y, width: W, height: H });
      settings.bubble.x = p.x; settings.bubble.y = p.y;
    }
    saveSettings();
    broadcast('settings', settings);
  }
  function reshapeBubble() {
    if (bubbleWin && !bubbleWin.isDestroyed()) resizeBubble(settings.bubble.size);
  }

  // ---- click / cursor overlays (drawn on screen so they end up in the recording)
  function createOverlays() {
    destroyOverlays();
    for (const d of screen.getAllDisplays()) {
      const b = d.bounds;
      const w = new BrowserWindow({
        ...FLOAT, x: b.x, y: b.y, width: b.width, height: b.height - (IS_WIN ? 1 : 0),
        frame: false, transparent: true, resizable: false, movable: false, focusable: false,
        skipTaskbar: true, hasShadow: false, alwaysOnTop: true, fullscreenable: false,
        enableLargerThanScreen: true, show: false, title: 'Zri overlay',
        backgroundColor: '#00000000',
        webPreferences: { preload: PRELOAD, backgroundThrottling: false },
      });
      w.setIgnoreMouseEvents(true);
      floatOnTop(w);
      w.loadFile(UI('overlay.html'), { query: { display: String(d.id) } });
      overlays.set(d.id, w);
    }
    return Promise.all([...overlays.values()].map((w) => new Promise((res) => {
      w.once('ready-to-show', () => { if (!w.isDestroyed()) w.showInactive(); res(); });
      setTimeout(res, 3000);
    }))).then(() => {
      // keep interactive windows above the overlay
      if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.moveTop();
      if (controlsWin && !controlsWin.isDestroyed()) controlsWin.moveTop();
    });
  }
  function destroyOverlays() {
    for (const w of overlays.values()) if (!w.isDestroyed()) w.destroy();
    overlays.clear();
  }
  function overlayFor(displayId) {
    const w = overlays.get(displayId);
    return w && !w.isDestroyed() ? w : null;
  }

  // ---- floating recording controls (hidden from the recording)
  function createControls(displayId) {
    if (controlsWin && !controlsWin.isDestroyed()) return;
    const disp = screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
    const wa = disp.workArea;
    const W = 490, H = 92;
    controlsWin = new BrowserWindow({
      ...FLOAT, x: Math.round(wa.x + (wa.width - W) / 2), y: Math.round(wa.y + wa.height - H - 28),
      width: W, height: H, frame: false, transparent: true, resizable: false,
      maximizable: false, minimizable: false, fullscreenable: false, skipTaskbar: true,
      hasShadow: false, alwaysOnTop: true, show: false, title: 'Zri controls',
      backgroundColor: '#00000000',
      webPreferences: { preload: PRELOAD, backgroundThrottling: false },
    });
    controlsWin.setContentProtection(true);
    floatOnTop(controlsWin);
    controlsWin.loadFile(UI('controls.html'));
    controlsWin.once('ready-to-show', () => controlsWin && controlsWin.showInactive());
    controlsWin.on('closed', () => { controlsWin = null; });
  }

  // ---------------------------------------------------------------- global mouse clicks
  let mouse = null;
  let hookState = 'off'; // off | on | failed
  function startHook() {
    if (!mouse) {
      mouse = createMouseWatcher((e) => onGlobalMouse(e), log);
      if (!mouse) { hookState = 'failed'; return false; }
    }
    mouse.start();
    hookState = 'on';
    return true;
  }
  function stopHook() { if (mouse) mouse.stop(); if (hookState === 'on') hookState = 'off'; }
  function onGlobalMouse(e) {
    if (!overlays.size || !settings.highlightClicks) return;
    const p = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(p);
    const ov = overlayFor(d.id);
    if (ov) ov.webContents.send('ov-mouse', { type: e.type, button: e.button, x: p.x - d.bounds.x, y: p.y - d.bounds.y });
  }

  let cursorTimer = null;
  let lastCursor = '';
  function startCursorFollow() {
    stopCursorFollow();
    cursorTimer = setInterval(() => {
      if (!settings.highlightCursor) {
        if (lastCursor) { for (const w of overlays.values()) if (!w.isDestroyed()) w.webContents.send('ov-cursor', null); lastCursor = ''; }
        return;
      }
      const p = screen.getCursorScreenPoint();
      const key = p.x + ',' + p.y;
      if (key === lastCursor) return;
      lastCursor = key;
      const d = screen.getDisplayNearestPoint(p);
      for (const [id, w] of overlays) {
        if (w.isDestroyed()) continue;
        w.webContents.send('ov-cursor', id === d.id ? { x: p.x - d.bounds.x, y: p.y - d.bounds.y } : null);
      }
    }, 16);
  }
  function stopCursorFollow() { clearInterval(cursorTimer); cursorTimer = null; lastCursor = ''; }

  // ---------------------------------------------------------------- recording lifecycle
  function stamp(at) {
    const d = at ? new Date(at) : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${t('stampAt')} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
  }
  function uniquePath(p) {
    if (!fs.existsSync(p)) return p;
    const ext = path.extname(p), base = p.slice(0, -ext.length);
    for (let i = 2; ; i++) { const c = `${base} (${i})${ext}`; if (!fs.existsSync(c)) return c; }
  }

  function sendCommand(cmd) {
    if (!panelWin || panelWin.isDestroyed()) return;
    if (cmd === 'start') {
      // run with a user gesture so getDisplayMedia is allowed
      panelWin.webContents.executeJavaScript('window.__zriStart && window.__zriStart()', true).catch(() => {});
    } else {
      panelWin.webContents.send('rec-command', cmd);
    }
  }
  function stopFromAnywhere() { if (rec.active) sendCommand('stop'); }

  ipcMain.handle('capture-target', (_e, t) => { captureTarget = { ...captureTarget, ...t }; return true; });
  // Show the floating controls BEFORE screen capture begins — on macOS a protected
  // window is only excluded from capture if it already exists when the stream starts.
  ipcMain.handle('rec-controls', async (_e, o) => {
    createControls(o && o.displayId != null ? o.displayId : screen.getPrimaryDisplay().id);
    await new Promise((res) => {
      if (!controlsWin || controlsWin.isVisible()) return res();
      controlsWin.once('show', res);
      setTimeout(res, 1500);
    });
    return true;
  });

  ipcMain.handle('rec-prepare', async (_e, o) => {
    rec.displayId = o && o.displayId != null ? o.displayId : screen.getPrimaryDisplay().id;
    if (panelWin && !panelWin.isDestroyed()) panelWin.hide();
    await createOverlays();
    if (settings.highlightClicks) startHook();
    return { hook: hookState };
  });

  ipcMain.handle('rec-countdown', async () => {
    const ov = overlayFor(rec.displayId) || [...overlays.values()][0];
    for (let n = 3; n >= 1; n--) {
      if (ov && !ov.isDestroyed()) ov.webContents.send('ov-countdown', { n, hint: activeKeys.toggle ? t('toStop', keyLabel(activeKeys.toggle)) : '' });
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (ov && !ov.isDestroyed()) ov.webContents.send('ov-countdown', { n: 0 });
    await new Promise((r) => setTimeout(r, 120));
    return true;
  });

  ipcMain.handle('rec-begin', (_e, o) => {
    const ext = (o && o.ext) || 'webm';
    rec.file = path.join(tmpDir(), `rec-${Date.now()}.${ext}`);
    rec.out = fs.createWriteStream(rec.file);
    rec.out.on('error', (err) => log('write error', err.message));
    rec.bytes = 0;
    rec.mime = (o && o.mime) || '';
    rec.active = true;
    rec.paused = false;
    rec.finishing = false;
    rec.startedAt = Date.now();
    try { rec.psb = powerSaveBlocker.start('prevent-display-sleep'); } catch { rec.psb = null; }
    fs.writeFileSync(rec.file + '.json', JSON.stringify({ mime: rec.mime, startedAt: rec.startedAt }));
    createControls(rec.displayId);
    startCursorFollow();
    return { file: rec.file };
  });

  ipcMain.on('rec-chunk', (_e, data) => {
    if (!rec.out) return;
    const buf = Buffer.from(data);
    rec.bytes += buf.length;
    rec.out.write(buf);
  });

  ipcMain.on('rec-state', (_e, s) => {
    rec.paused = s.status === 'paused';
    if (controlsWin && !controlsWin.isDestroyed()) controlsWin.webContents.send('rec-state', { ...s, bytes: rec.bytes });
  });
  ipcMain.on('rec-level', (_e, v) => {
    if (controlsWin && !controlsWin.isDestroyed()) controlsWin.webContents.send('rec-level', v);
  });

  function closeOut() {
    return new Promise((res) => {
      if (!rec.out) return res();
      const o = rec.out; rec.out = null;
      o.end(() => res());
    });
  }
  function teardownRecordingUI() {
    stopCursorFollow();
    stopHook();
    try { if (rec.psb != null && powerSaveBlocker.isStarted(rec.psb)) powerSaveBlocker.stop(rec.psb); } catch {}
    rec.psb = null;
    destroyOverlays();
    if (controlsWin && !controlsWin.isDestroyed()) controlsWin.destroy();
    controlsWin = null;
  }

  ipcMain.handle('rec-finish', async (_e, o) => {
    rec.active = false;
    rec.finishing = true;
    await closeOut();
    teardownRecordingUI();
    if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); }
    const result = await finalize(rec.file, { mime: rec.mime, durationMs: (o && o.durationMs) || 0, startedAt: rec.startedAt });
    rec.finishing = false;
    if (result.ok && Notification.isSupported() && !process.env.ZRI_TEST) {
      const n = new Notification({ title: t('savedNotification'), body: path.basename(result.file) });
      n.on('click', () => shell.showItemInFolder(result.file));
      n.show();
    }
    if (quitting) setTimeout(() => app.quit(), 200);
    return result;
  });

  ipcMain.handle('rec-abort', async () => {
    rec.active = false;
    await closeOut();
    teardownRecordingUI();
    try { fs.unlinkSync(rec.file); } catch {}
    try { fs.unlinkSync(rec.file + '.json'); } catch {}
    if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); }
    return true;
  });

  ipcMain.handle('rec-fail', async () => {
    // something broke before recording started — restore UI
    rec.active = false;
    await closeOut();
    teardownRecordingUI();
    if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); }
    return true;
  });

  async function emergencyFinalize() {
    rec.active = false;
    await closeOut();
    teardownRecordingUI();
    const r = await finalize(rec.file, { mime: rec.mime, durationMs: Date.now() - rec.startedAt, startedAt: rec.startedAt });
    if (r.ok) dialog.showMessageBox({ message: t('interruptedSaved'), detail: r.file });
  }

  // ---------------------------------------------------------------- ffmpeg
  function runFfmpeg(args, durationMs) {
    return new Promise((resolve) => {
      let err = '';
      let p;
      try {
        p = spawn(ffmpegPath(), args, { windowsHide: true });
      } catch (e) { return resolve({ ok: false, err: e.message }); }
      p.stderr.on('data', (d) => {
        const s = d.toString();
        err = (err + s).slice(-4000);
        const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(s);
        if (m && durationMs > 0) {
          const t = (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000;
          broadcast('processing-progress', Math.min(0.99, t / durationMs));
        }
      });
      p.on('error', (e) => resolve({ ok: false, err: e.message }));
      p.on('close', (code) => resolve({ ok: code === 0, err }));
    });
  }

  async function finalize(tmpFile, info) {
    if (!tmpFile || !fs.existsSync(tmpFile) || fs.statSync(tmpFile).size < 1024) {
      return { ok: false, error: t('emptyVideo') };
    }
    const out = uniquePath(path.join(await resolveSaveDir(), `${t('fileName', stamp(info.startedAt))}.mp4`));
    broadcast('processing-progress', 0);
    const common = ['-hide_banner', '-y', '-fflags', '+genpts', '-i', tmpFile, '-map', '0:v:0', '-map', '0:a:0?'];
    const audio = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];
    const isH264 = /h264|avc1/i.test(info.mime || '');
    let r = { ok: false };
    if (isH264) {
      r = await runFfmpeg([...common, '-c:v', 'copy', ...audio, '-movflags', '+faststart', out], info.durationMs);
      if (!r.ok) log('copy remux failed, transcoding', r.err && r.err.slice(-500));
    }
    if (!r.ok) {
      r = await runFfmpeg([...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', ...audio,
        '-movflags', '+faststart', out], info.durationMs);
    }
    broadcast('processing-progress', 1);
    if (r.ok && fs.existsSync(out) && fs.statSync(out).size > 1024) {
      try { fs.unlinkSync(tmpFile); } catch {}
      try { fs.unlinkSync(tmpFile + '.json'); } catch {}
      const thumb = await makeThumb(out);
      return { ok: true, file: out, size: fs.statSync(out).size, durationMs: info.durationMs, thumb };
    }
    // conversion failed: never lose the recording — keep the raw file next to where the mp4 would be
    log('ffmpeg failed', r.err && r.err.slice(-800));
    try { fs.unlinkSync(out); } catch {}
    const raw = uniquePath(out.replace(/\.mp4$/, '.webm'));
    try {
      fs.copyFileSync(tmpFile, raw);
      fs.unlinkSync(tmpFile);
      try { fs.unlinkSync(tmpFile + '.json'); } catch {}
      return { ok: true, file: raw, size: fs.statSync(raw).size, durationMs: info.durationMs, thumb: null, raw: true };
    } catch (e) {
      return { ok: false, error: t('cantSave') + e.message };
    }
  }

  async function makeThumb(file) {
    const t = path.join(tmpDir(), `thumb-${Date.now()}.jpg`);
    const r = await runFfmpeg(['-hide_banner', '-y', '-ss', '0.6', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', t], 0);
    if (!r.ok || !fs.existsSync(t)) return null;
    const data = 'data:image/jpeg;base64,' + fs.readFileSync(t).toString('base64');
    try { fs.unlinkSync(t); } catch {}
    return data;
  }

  // Recordings left behind by a crash / power loss get saved on the next launch.
  async function recoverOrphans() {
    let files = [];
    try { files = fs.readdirSync(tmpDir()).filter((f) => /^rec-\d+\.(webm|mkv|mp4)$/.test(f)); } catch {}
    for (const f of files) {
      const full = path.join(tmpDir(), f);
      if (rec.file === full) continue;
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(full + '.json', 'utf8')); } catch {}
      const r = await finalize(full, { mime: meta.mime || '', durationMs: 0, startedAt: meta.startedAt });
      if (r.ok) {
        const named = r.file.replace(/(\.\w+)$/, `${t('recoveredSuffix')}$1`);
        try { fs.renameSync(r.file, named); r.file = named; } catch {}
        broadcast('recovered', r.file);
      }
    }
  }

  // ---------------------------------------------------------------- IPC: misc
  ipcMain.handle('settings-get', () => settings);
  ipcMain.handle('settings-set', (_e, patch) => {
    const prevShape = settings.bubble.shape;
    const prevSize = settings.bubble.size;
    settings = { ...settings, ...patch, bubble: { ...settings.bubble, ...(patch.bubble || {}) } };
    saveSettings();
    if ('cameraOn' in patch) ensureBubble();
    if (patch.bubble && (patch.bubble.shape !== undefined && patch.bubble.shape !== prevShape)) reshapeBubble();
    if (patch.bubble && patch.bubble.size !== undefined && patch.bubble.size !== prevSize) resizeBubble(patch.bubble.size);
    broadcast('settings', settings);
    return settings;
  });
  ipcMain.handle('get-displays', () => screen.getAllDisplays().map((d) => ({
    id: d.id, bounds: d.bounds, size: d.size, scaleFactor: d.scaleFactor,
    primary: d.id === screen.getPrimaryDisplay().id,
  })));
  ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'], thumbnailSize: { width: 480, height: 270 }, fetchWindowIcons: false,
    });
    const own = new Set(BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => w.getMediaSourceId()));
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    let screenIdx = 0;
    return sources
      .filter((s) => !own.has(s.id) && !/^Zri( |$)/.test(s.name))
      .map((s) => {
        const isScreen = s.id.startsWith('screen');
        let disp = null;
        if (isScreen) {
          disp = displays.find((d) => String(d.id) === String(s.display_id)) || displays[screenIdx] || primary;
          screenIdx++;
        }
        return {
          id: s.id,
          type: isScreen ? 'screen' : 'window',
          name: isScreen
            ? `${t('screenN', screenIdx)}${disp ? ` · ${Math.round(disp.size.width * disp.scaleFactor)}×${Math.round(disp.size.height * disp.scaleFactor)}` : ''}`
            : s.name,
          displayId: disp ? disp.id : null,
          primary: disp ? disp.id === primary.id : false,
          thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
        };
      });
  });
  ipcMain.handle('permissions', () => {
    const out = { platform: process.platform, hook: hookState };
    if (IS_MAC) {
      out.screen = systemPreferences.getMediaAccessStatus('screen');
      out.camera = systemPreferences.getMediaAccessStatus('camera');
      out.microphone = systemPreferences.getMediaAccessStatus('microphone');
    }
    return out;
  });
  ipcMain.handle('open-privacy', (_e, kind) => {
    if (!IS_MAC) return;
    const map = {
      screen: 'Privacy_ScreenCapture', audio: 'Privacy_AudioCapture',
      camera: 'Privacy_Camera', microphone: 'Privacy_Microphone',
    };
    shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${map[kind] || ''}`);
  });
  ipcMain.handle('shortcuts', () => shortcutLabels());
  ipcMain.handle('relaunch', () => { app.relaunch(); app.exit(0); });
  ipcMain.handle('open-file', (_e, f) => shell.openPath(f));
  ipcMain.handle('show-in-folder', (_e, f) => shell.showItemInFolder(f));
  ipcMain.handle('open-save-dir', () => shell.openPath(saveDir()));
  ipcMain.handle('save-dir', () => saveDir());
  ipcMain.handle('choose-save-dir', async () => {
    const r = await dialog.showOpenDialog(panelWin, { properties: ['openDirectory', 'createDirectory'], defaultPath: saveDir() });
    if (r.canceled || !r.filePaths[0]) return saveDir();
    settings.saveDir = r.filePaths[0];
    saveSettings();
    const d = await resolveSaveDir();
    broadcast('settings', settings);
    return d;
  });
  ipcMain.on('win-minimize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
  ipcMain.on('win-close', () => { if (rec.active) stopFromAnywhere(); else app.quit(); });

  // controls / bubble -> recorder
  ipcMain.on('command', (_e, cmd) => {
    if (cmd === 'camera-toggle') {
      settings.cameraOn = !settings.cameraOn; saveSettings(); ensureBubble(); broadcast('settings', settings);
      return;
    }
    sendCommand(cmd);
  });

  // bubble window
  ipcMain.on('bubble-move', (_e, p) => {
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    const b = bubbleWin.getBounds();
    const c = clampToScreens(p.x, p.y, b.width, b.height);
    bubbleWin.setBounds({ x: c.x, y: c.y, width: b.width, height: b.height });
  });
  ipcMain.on('bubble-move-end', () => {
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    const b = bubbleWin.getBounds();
    settings.bubble.x = b.x; settings.bubble.y = b.y; saveSettings();
  });
  ipcMain.on('bubble-resize', (_e, delta) => resizeBubble(settings.bubble.size + delta));
  ipcMain.on('bubble-shape', () => {
    const order = ['circle', 'square', 'wide'];
    settings.bubble.shape = order[(order.indexOf(settings.bubble.shape) + 1) % order.length];
    reshapeBubble();
  });
  ipcMain.on('bubble-mirror', () => {
    settings.bubble.mirror = !settings.bubble.mirror; saveSettings(); broadcast('settings', settings);
  });
  ipcMain.on('bubble-hide', () => {
    settings.cameraOn = false; saveSettings(); ensureBubble(); broadcast('settings', settings);
  });

  // ---------------------------------------------------------------- app lifecycle
  app.on('activate', () => {
    // Dock icon click on macOS
    if (panelWin && !rec.active && !panelWin.isVisible()) { panelWin.show(); panelWin.focus(); }
  });
  app.on('second-instance', () => {
    if (panelWin) { if (panelWin.isMinimized()) panelWin.restore(); panelWin.show(); panelWin.focus(); }
  });

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'display-capture', 'mediaKeySystem', 'notifications', 'fullscreen'].includes(perm)));
    session.defaultSession.setPermissionCheckHandler(() => true);
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        const src = sources.find((s) => s.id === captureTarget.sourceId) || sources.find((s) => s.id.startsWith('screen')) || sources[0];
        const wantAudio = captureTarget.systemAudio && (IS_WIN || IS_MAC);
        callback(wantAudio ? { video: src, audio: 'loopback' } : { video: src });
      } catch (e) {
        log('display media handler failed', e.message);
        callback({});
      }
    }, { useSystemPicker: false });

    if (IS_MAC) {
      try { await systemPreferences.askForMediaAccess('camera'); } catch {}
      try { await systemPreferences.askForMediaAccess('microphone'); } catch {}
    }

    lang = pickLang(settings.lang, systemLocales()); // locale APIs are reliable only after ready
    t = makeT(lang);
    log('language', lang);

    createPanel();
    ensureBubble();
    setTimeout(() => resolveSaveDir().then((d) => { log('save dir', d); broadcast('settings', settings); }), 2500);

    // Global hotkeys. macOS 15 may refuse ⌥⇧-only combos, so fall back to ⌃⇧.
    const actions = {
      toggle: ['R', () => (rec.active ? sendCommand('stop') : (!rec.finishing && sendCommand('start')))],
      pause: ['P', () => rec.active && sendCommand('toggle-pause')],
      camera: ['C', () => { settings.cameraOn = !settings.cameraOn; saveSettings(); ensureBubble(); broadcast('settings', settings); }],
      mute: ['M', () => rec.active && sendCommand('toggle-mute')],
    };
    const prefixes = IS_MAC ? ['Alt+Shift+', 'Control+Shift+'] : ['Alt+Shift+', 'Control+Alt+'];
    for (const [name, [key, fn]] of Object.entries(actions)) {
      for (const pre of prefixes) {
        let ok = false;
        try { ok = globalShortcut.register(pre + key, fn); } catch (e) { log('shortcut failed', pre + key, e.message); }
        if (ok) { activeKeys[name] = pre + key; break; }
      }
      if (!activeKeys[name]) log('shortcut unavailable', name);
    }
    broadcast('shortcuts', shortcutLabels());

    screen.on('display-removed', () => { if (bubbleWin && !bubbleWin.isDestroyed()) resizeBubble(settings.bubble.size); });

    setTimeout(() => recoverOrphans().catch((e) => log('recover failed', e.message)), 1500);
  });

  app.on('before-quit', (e) => {
    if ((rec.active || rec.finishing) && !quitting) {
      e.preventDefault();
      quitting = true;
      if (rec.active) stopFromAnywhere(); // rec-finish quits once the video is saved
      setTimeout(() => app.exit(0), 15 * 60000); // last-resort limit
      return;
    }
    if (rec.finishing) { e.preventDefault(); return; } // still saving — rec-finish will quit
    quitting = true;
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopHook();
  });
  app.on('window-all-closed', () => app.quit());
}
