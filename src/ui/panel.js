'use strict';
/* global zri */
const $ = (id) => document.getElementById(id);
const IS_MAC = zri.platform === 'darwin';
const IS_WIN = zri.platform === 'win32';
const t = zri.t;
document.documentElement.lang = zri.lang;
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);

let S = null;               // settings (mirror of main)
let sources = [];
let displays = [];
let R = null;               // active recording
let busy = false;
let preview = null;         // mic preview { stream, ctx, analyser, raf }
let srcTab = 'screen';

// ------------------------------------------------------------------ helpers
function set(patch) {
  S = { ...S, ...patch, bubble: { ...S.bubble, ...(patch.bubble || {}) } };
  return zri.setSettings(patch);
}
function show(view) {
  for (const v of ['viewIdle', 'viewProcessing', 'viewDone']) $(v).hidden = v !== view;
}
function toast(msg, ms = 4200) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
function showError(title, text) {
  $('errTitle').textContent = title; $('errText').textContent = text || '';
  $('errorCard').hidden = false; show('viewIdle');
}
$('errClose').onclick = () => { $('errorCard').hidden = true; };
function fmtDur(ms) {
  const s = Math.round(ms / 1000), m = Math.floor(s / 60), r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}
function fmtSize(b) { return b > 1073741824 ? (b / 1073741824).toFixed(2) + ' ' + t('gb') : (b / 1048576).toFixed(1) + ' ' + t('mb'); }
function levelFrom(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  const db = 20 * Math.log10(rms + 1e-8);
  return Math.max(0, Math.min(1, (db + 58) / 52));
}

// ------------------------------------------------------------------ devices
async function unlockDeviceLabels() {
  const tries = [{ audio: true, video: true }, { audio: true }, { video: true }];
  for (const c of tries) {
    try { const s = await navigator.mediaDevices.getUserMedia(c); s.getTracks().forEach((t) => t.stop()); return; } catch {}
  }
}
async function refreshDevices() {
  let list = [];
  try { list = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const cams = list.filter((d) => d.kind === 'videoinput');
  const mics = list.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  fillSelect($('camSelect'), cams, S.cameraId, t('camera'));
  fillSelect($('micSelect'), mics, S.micId, t('microphone'));
  if (!cams.length) { $('camSelect').innerHTML = `<option>${t('noCamera')}</option>`; $('camSelect').disabled = true; }
  if (!mics.length) { $('micSelect').innerHTML = `<option>${t('noMic')}</option>`; $('micSelect').disabled = true; }
}
function fillSelect(sel, devs, current, fallback) {
  sel.disabled = false;
  sel.innerHTML = '';
  devs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId === 'default' ? '' : d.deviceId;
    o.textContent = (d.label || `${fallback} ${i + 1}`).replace(/^Default - /, t('defaultDevice')).replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '');
    sel.appendChild(o);
  });
  const want = current || '';
  if ([...sel.options].some((o) => o.value === want)) sel.value = want;
  else if (sel.options.length) sel.selectedIndex = 0;
}

// ------------------------------------------------------------------ mic preview meter
async function startMicPreview() {
  stopMicPreview();
  if (!S.micOn || R) { $('micLevel').style.width = '0%'; return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
    if (R || !S.micOn) { stream.getTracks().forEach((t) => t.stop()); return; }
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const p = { stream, ctx, analyser, raf: 0 };
    const loop = () => { $('micLevel').style.width = Math.round(levelFrom(analyser, buf) * 100) + '%'; p.raf = requestAnimationFrame(loop); };
    loop();
    preview = p;
  } catch { $('micLevel').style.width = '0%'; }
}
function stopMicPreview() {
  if (!preview) return;
  cancelAnimationFrame(preview.raf);
  preview.stream.getTracks().forEach((t) => t.stop());
  preview.ctx.close().catch(() => {});
  preview = null;
}
function micConstraints(withId = true) {
  return {
    deviceId: withId && S.micId ? { exact: S.micId } : undefined,
    echoCancellation: !!S.noiseSuppression,
    noiseSuppression: !!S.noiseSuppression,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: 48000,
  };
}

// ------------------------------------------------------------------ sources
async function refreshSources() {
  try { sources = await zri.getSources(); } catch { sources = []; }
  displays = await zri.getDisplays();
  if (!sources.find((s) => s.id === S.sourceId)) {
    const scr = sources.find((s) => s.type === 'screen' && s.primary) || sources.find((s) => s.type === 'screen');
    if (scr) await set({ sourceId: scr.id });
  }
  renderSource();
}
function renderSource() {
  const s = sources.find((x) => x.id === S.sourceId);
  $('sourceName').textContent = s ? s.name : t('screenNotFound');
  if (s && s.thumb) { $('sourceThumb').src = s.thumb; $('sourceThumb').style.display = ''; $('sourceEmpty').style.display = 'none'; }
  else { $('sourceThumb').style.display = 'none'; $('sourceEmpty').style.display = 'grid'; }
}
function renderGrid() {
  const g = $('srcGrid');
  g.innerHTML = '';
  for (const b of $('srcTabs').children) b.classList.toggle('on', b.dataset.v === srcTab);
  $('winNote').hidden = srcTab !== 'window';
  const list = sources.filter((s) => s.type === srcTab);
  if (!list.length) { g.innerHTML = `<p class="muted tiny">${srcTab === 'window' ? t('noWindows') : t('noScreens')}</p>`; return; }
  for (const s of list) {
    const el = document.createElement('button');
    el.className = 'src' + (s.id === S.sourceId ? ' on' : '');
    el.innerHTML = `<div class="t">${s.thumb ? `<img src="${s.thumb}">` : ''}</div><div class="n"></div>`;
    el.querySelector('.n').textContent = s.name;
    el.onclick = async () => { await set({ sourceId: s.id }); renderSource(); $('sheet').hidden = true; };
    g.appendChild(el);
  }
}
$('sourceCard').onclick = async () => {
  srcTab = (sources.find((s) => s.id === S.sourceId) || {}).type || 'screen';
  $('sheet').hidden = false; renderGrid();
  await refreshSources(); renderGrid();
};
$('sheetClose').onclick = () => { $('sheet').hidden = true; };
$('sheet').onclick = (e) => { if (e.target === $('sheet')) $('sheet').hidden = true; };
for (const b of $('srcTabs').children) b.onclick = () => { srcTab = b.dataset.v; renderGrid(); };

// ------------------------------------------------------------------ settings UI
function renderSettings() {
  $('camOn').checked = !!S.cameraOn;
  $('micOn').checked = !!S.micOn;
  $('sysOn').checked = !!S.systemAudio;
  $('clicksOn').checked = !!S.highlightClicks;
  $('cursorOn').checked = !!S.highlightCursor;
  $('nsOn').checked = !!S.noiseSuppression;
  $('cdOn').checked = !!S.countdown;
  $('camSub').hidden = !S.cameraOn;
  $('micSub').hidden = !S.micOn;
  $('camSelect').style.opacity = S.cameraOn ? 1 : 0.5;
  $('micSelect').style.opacity = S.micOn ? 1 : 0.5;
  $('sizeRange').value = S.bubble.size;
  $('mirrorBtn').classList.toggle('on', !!S.bubble.mirror);
  for (const b of $('shapeSeg').children) b.classList.toggle('on', b.dataset.v === S.bubble.shape);
  for (const b of $('qualitySeg').children) b.classList.toggle('on', b.dataset.v === String(S.quality));
  for (const b of $('fpsSeg').children) b.classList.toggle('on', b.dataset.v === String(S.fps));
  for (const b of $('colors').children) b.classList.toggle('on', b.dataset.c === S.clickColor);
  $('qualitySummary').textContent = `${S.quality === 'native' ? t('native') : S.quality + 'p'} · ${S.fps} fps · MP4`;
}

$('camOn').onchange = (e) => { set({ cameraOn: e.target.checked }); renderSettings(); };
$('camSelect').onchange = (e) => { set({ cameraId: e.target.value || null, cameraOn: true }); renderSettings(); };
$('micOn').onchange = (e) => { set({ micOn: e.target.checked }); renderSettings(); startMicPreview(); };
$('micSelect').onchange = (e) => { set({ micId: e.target.value || null, micOn: true }); renderSettings(); startMicPreview(); };
$('sysOn').onchange = (e) => set({ systemAudio: e.target.checked });
$('clicksOn').onchange = (e) => set({ highlightClicks: e.target.checked });
$('cursorOn').onchange = (e) => set({ highlightCursor: e.target.checked });
$('nsOn').onchange = (e) => { set({ noiseSuppression: e.target.checked }); startMicPreview(); };
$('cdOn').onchange = (e) => set({ countdown: e.target.checked });
$('sizeRange').oninput = (e) => set({ bubble: { size: +e.target.value } });
$('mirrorBtn').onclick = () => { set({ bubble: { mirror: !S.bubble.mirror } }); renderSettings(); };
for (const b of $('shapeSeg').children) b.onclick = () => { set({ bubble: { shape: b.dataset.v } }); renderSettings(); };
for (const b of $('qualitySeg').children) b.onclick = () => { set({ quality: b.dataset.v }); renderSettings(); };
for (const b of $('fpsSeg').children) b.onclick = () => { set({ fps: +b.dataset.v }); renderSettings(); };
for (const b of $('colors').children) b.onclick = () => { set({ clickColor: b.dataset.c, highlightClicks: true }); renderSettings(); };
$('saveDirBtn').onclick = async () => { const d = await zri.chooseSaveDir(); renderSaveDir(d); };
async function renderSaveDir(d) {
  d = d || await zri.saveDir();
  const parts = d.split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] || d;
  $('saveDir').textContent = /^desktop$/i.test(last) ? t('desktop') : last;
  $('saveDir').title = d;
}

zri.onSettings((s) => { S = s; renderSettings(); renderSaveDir(); });

$('minBtn').onclick = () => zri.minimize();
$('closeBtn').onclick = () => zri.close();

// ------------------------------------------------------------------ permissions (macOS)
async function checkPermissions() {
  if (!IS_MAC) return;
  const p = await zri.permissions();
  const noScreen = p.screen && p.screen !== 'granted';
  $('permCard').hidden = !noScreen;
}
$('permBtn').onclick = () => zri.openPrivacy('screen');
$('relaunchBtn').onclick = () => zri.relaunch();
window.addEventListener('focus', () => { checkPermissions(); if (!R) refreshSources(); });

// ------------------------------------------------------------------ recording
function pickMime() {
  const prefs = [
    'video/webm;codecs=h264,opus',
    'video/x-matroska;codecs=avc1,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return prefs.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

async function acquireScreen(src) {
  const d = displays.find((x) => x.id === src.displayId) || displays.find((x) => x.primary) || displays[0];
  let maxW = 3840, maxH = 2160;
  if (src.type === 'screen' && d) { maxW = Math.round(d.size.width * d.scaleFactor); maxH = Math.round(d.size.height * d.scaleFactor); }
  if (S.quality === '1080' || S.quality === '720') {
    const tw = S.quality === '1080' ? 1920 : 1280, th = S.quality === '1080' ? 1080 : 720;
    const k = Math.min(1, tw / maxW, th / maxH);
    maxW = Math.round(maxW * k); maxH = Math.round(maxH * k);
  }
  maxW -= maxW % 2; maxH -= maxH % 2;
  const fps = +S.fps || 30;
  const wantSys = !!S.systemAudio && (IS_WIN || IS_MAC);
  const video = { width: { max: maxW }, height: { max: maxH }, frameRate: { ideal: fps, max: fps } };
  let stream = null, warning = null;

  await zri.setCaptureTarget({ sourceId: src.id, systemAudio: wantSys });
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: wantSys });
  } catch (e1) {
    console.warn('getDisplayMedia failed', e1);
    if (wantSys) {
      try {
        await zri.setCaptureTarget({ sourceId: src.id, systemAudio: false });
        stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
        warning = t('sysAudioFailed');
      } catch (e2) { console.warn('retry failed', e2); }
    }
    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, maxWidth: maxW, maxHeight: maxH, maxFrameRate: fps } },
      });
    }
  }
  const v = stream.getVideoTracks()[0];
  try { v.contentHint = 'detail'; } catch {}
  try { await v.applyConstraints({ width: { max: maxW }, height: { max: maxH }, frameRate: { max: fps } }); } catch {}
  const sys = stream.getAudioTracks()[0] || null;
  if (wantSys && !sys && !warning) warning = t('sysAudioMissing');
  return { stream, sys, warning, fps };
}

async function getMic() {
  try { return await navigator.mediaDevices.getUserMedia({ audio: micConstraints(true) }); }
  catch (e) {
    if (S.micId) { try { return await navigator.mediaDevices.getUserMedia({ audio: micConstraints(false) }); } catch {} }
    throw e;
  }
}

function pushState() {
  if (!R) return;
  zri.state({ status: R.state, elapsedMs: R.elapsed, at: R.at, muted: R.muted, noMic: !R.micGain });
}
function elapsedNow() { return R ? R.elapsed + (R.state === 'recording' ? Date.now() - R.at : 0) : 0; }

async function startRecording() {
  if (R || busy) return;
  busy = true;
  $('startBtn').disabled = true;
  $('errorCard').hidden = true;
  show('viewIdle');
  stopMicPreview();
  const warnings = [];
  let screenStream = null, mic = null, ctx = null, prepared = false;
  const cleanupStreams = () => {
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
    if (mic) mic.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close().catch(() => {});
  };
  try {
    if (!sources.length) await refreshSources();
    const src = sources.find((s) => s.id === S.sourceId) || sources.find((s) => s.type === 'screen');
    if (!src) throw Object.assign(new Error('no-source'), { user: t('noScreenToRecord') + (IS_MAC ? t('checkScreenPermission') : '') });

    await zri.showControls({ displayId: src.displayId });
    let acq;
    try { acq = await acquireScreen(src); }
    catch (e) {
      throw Object.assign(e, { user: IS_MAC
        ? t('macScreenDenied')
        : t('captureFailed') + (e.message || e.name) });
    }
    screenStream = acq.stream;
    if (acq.warning) warnings.push(acq.warning);

    if (S.micOn) {
      try { mic = await getMic(); } catch (e) { warnings.push(t('micUnavailable')); }
    }

    // audio mix: mic + system sound
    ctx = new AudioContext({ sampleRate: 48000 });
    try { await ctx.resume(); } catch {}
    const dest = ctx.createMediaStreamDestination();
    // gentle safety limiter so voice + computer sound never clip
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2; limiter.knee.value = 2; limiter.ratio.value = 20;
    limiter.attack.value = 0.002; limiter.release.value = 0.15;
    limiter.connect(dest);
    let micGain = null, analyser = null;
    if (mic) {
      const s = ctx.createMediaStreamSource(mic);
      micGain = ctx.createGain(); micGain.gain.value = 1;
      s.connect(micGain); micGain.connect(limiter);
      analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
      micGain.connect(analyser);
    }
    if (acq.sys) {
      const s = ctx.createMediaStreamSource(new MediaStream([acq.sys]));
      const g = ctx.createGain(); g.gain.value = mic ? 0.8 : 1;
      s.connect(g); g.connect(limiter);
    }
    const vTrack = screenStream.getVideoTracks()[0];
    const tracks = [vTrack];
    if (mic || acq.sys) tracks.push(dest.stream.getAudioTracks()[0]);
    const out = new MediaStream(tracks);

    const vs = vTrack.getSettings();
    const w = vs.width || 1920, h = vs.height || 1080;
    // ~13 Mbps for a 30 fps Retina screen: crisp text, ~100 MB per minute
    const vbps = Math.round(Math.min(16e6, Math.max(6e6, w * h * acq.fps * 0.08)));
    const mimeType = pickMime();

    const prep = await zri.prepare({ displayId: src.displayId });
    prepared = true;
    if (S.highlightClicks && prep && prep.hook === 'failed') warnings.push(t('clicksUnavailable'));
    if (S.countdown) await zri.countdown();

    const mr = new MediaRecorder(out, {
      mimeType, videoBitsPerSecond: vbps, audioBitsPerSecond: 192000, videoKeyFrameIntervalDuration: 2000,
    });
    await zri.begin({ mime: mimeType, ext: /matroska/.test(mimeType) ? 'mkv' : 'webm' });

    R = {
      mr, ctx, mic, screenStream, micGain, analyser, chain: Promise.resolve(), bytes: 0,
      state: 'recording', elapsed: 0, at: Date.now(), muted: false, stopping: false, cancelled: false,
      levelTimer: null, info: { w, h, fps: acq.fps, mimeType, vbps },
    };
    window.__zriRec = R.info;
    mr.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const rr = R;
      rr.chain = rr.chain.then(async () => {
        const buf = new Uint8Array(await e.data.arrayBuffer());
        rr.bytes += buf.byteLength;
        zri.chunk(buf);
      });
    };
    mr.onstop = () => onRecorderStopped();
    mr.onerror = (e) => { console.error('recorder error', e); stopRecording(); };
    vTrack.addEventListener('ended', () => stopRecording());
    mr.start(1000);
    pushState();

    if (analyser) {
      const buf = new Float32Array(analyser.fftSize);
      R.levelTimer = setInterval(() => { if (R && !R.muted) zri.level(levelFrom(analyser, buf)); else zri.level(0); }, 90);
    }
    if (warnings.length) setTimeout(() => toast(warnings.join(' ')), 300);
    window.__zriWarnings = warnings;
  } catch (e) {
    console.error(e);
    cleanupStreams();
    R = null;
    await zri.fail();
    showError(t('recordingNotStarted'), e.user || e.message || String(e));
    startMicPreview();
  } finally {
    busy = false;
    $('startBtn').disabled = false;
  }
}

function stopRecording() {
  if (!R || R.stopping) return;
  R.stopping = true;
  if (R.state === 'recording') R.elapsed += Date.now() - R.at;
  R.state = 'stopped';
  try { if (R.mr.state !== 'inactive') R.mr.stop(); else onRecorderStopped(); } catch { onRecorderStopped(); }
}

async function onRecorderStopped() {
  const rr = R;
  if (!rr || rr.done) return;
  rr.done = true;
  clearInterval(rr.levelTimer);
  try { await rr.chain; } catch {}
  rr.screenStream.getTracks().forEach((t) => t.stop());
  if (rr.mic) rr.mic.getTracks().forEach((t) => t.stop());
  rr.ctx.close().catch(() => {});
  const durationMs = rr.elapsed;
  R = null;
  if (rr.cancelled) {
    await zri.abort();
    show('viewIdle');
    toast(t('recordingDeleted'));
    startMicPreview();
    return;
  }
  show('viewProcessing');
  $('procBar').style.width = '0%';
  const res = await zri.finish({ durationMs });
  window.__zriLast = res;
  if (res.ok) showDone(res);
  else showError(t('saveFailed'), res.error);
  startMicPreview();
}

function togglePause() {
  if (!R || R.stopping) return;
  if (R.state === 'recording') { R.mr.pause(); R.elapsed += Date.now() - R.at; R.state = 'paused'; }
  else if (R.state === 'paused') { R.mr.resume(); R.at = Date.now(); R.state = 'recording'; }
  pushState();
}
function toggleMute() {
  if (!R || !R.micGain) return;
  R.muted = !R.muted;
  R.micGain.gain.setTargetAtTime(R.muted ? 0 : 1, R.ctx.currentTime, 0.02);
  pushState();
}

zri.onCommand((cmd) => {
  if (cmd === 'stop') stopRecording();
  else if (cmd === 'toggle-pause') togglePause();
  else if (cmd === 'toggle-mute') toggleMute();
  else if (cmd === 'cancel') { if (R) { R.cancelled = true; stopRecording(); } }
});
zri.onProgress((p) => { $('procBar').style.width = Math.round(p * 100) + '%'; });
zri.onRecovered((f) => toast(t('recovered') + f.split(/[\\/]/).pop(), 8000));

// called by the global hotkey (with a user gesture)
window.__zriStart = () => startRecording();
window.__zriStop = () => stopRecording();
$('startBtn').onclick = () => startRecording();

// ------------------------------------------------------------------ done view
let lastFile = null;
function showDone(res) {
  lastFile = res.file;
  $('doneThumb').src = res.thumb || '';
  $('doneThumb').style.display = res.thumb ? '' : 'none';
  const parts = res.file.split(/[\\/]/);
  const folder = parts[parts.length - 2] || '';
  $('doneName').textContent = parts[parts.length - 1];
  $('doneName').title = res.file;
  $('doneFolder').textContent = /^desktop$/i.test(folder) ? t('onDesktop') : t('inFolder', folder);
  $('doneMeta').textContent = [res.durationMs ? fmtDur(res.durationMs) : null, fmtSize(res.size), res.raw ? 'WebM' : 'MP4'].filter(Boolean).join(' · ');
  show('viewDone');
}
$('openBtn').onclick = () => lastFile && zri.openFile(lastFile);
$('doneOpen').onclick = () => lastFile && zri.openFile(lastFile);
$('revealBtn').onclick = () => lastFile && zri.showInFolder(lastFile);
$('againBtn').onclick = () => startRecording();
$('backBtn').onclick = () => show('viewIdle');

function renderKeys(k) {
  const parts = [];
  if (k && k.toggle) parts.push(`<kbd>${k.toggle}</kbd> ${t('keyStartStop')}`);
  if (k && k.pause) parts.push(`<kbd>${k.pause}</kbd> ${t('keyPause')}`);
  $('keys').innerHTML = parts.join(' · ');
}

// ------------------------------------------------------------------ init
(async function init() {
  S = await zri.getSettings();
  if (IS_MAC) {
    $('revealBtn').textContent = t('showInFinder');
    $('sysHint').textContent = t('sysHintMac');
  } else if (IS_WIN) {
    $('sysHint').textContent = t('sysHintWin');
  } else {
    $('sysRow').hidden = true;
  }
  renderSettings();
  renderSaveDir();
  renderKeys(await zri.shortcuts());
  zri.onShortcuts(renderKeys);
  await unlockDeviceLabels();
  await refreshDevices();
  navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  await refreshSources();
  checkPermissions();
  startMicPreview();
  document.body.dataset.ready = '1';
})();
