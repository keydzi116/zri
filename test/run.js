// End-to-end test: launches the real app on a virtual display (real X11 screen capture,
// a PulseAudio virtual microphone with speech), clicks through it like a user, records,
// and saves the output plus screenshots for inspection.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const OUT = process.env.OUT || require('path').join(require('os').tmpdir(), 'zri-test');
const HOME = path.join(OUT, 'home');
const DESK = path.join(HOME, 'Desktop');
fs.mkdirSync(DESK, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const xdo = (cmd) => execSync(`xdotool ${cmd}`, { env: process.env });
const shot = (name) => execSync(`import -window root ${path.join(OUT, name)}`, { env: process.env });
const log = (...a) => console.log(...a);
const byTitle = (app, title) => app.evaluate(({ BrowserWindow }, t) => {
  const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === t);
  return w ? w.getBounds() : null;
}, title);

async function fakeCamera(win) {
  // test-only: feed the bubble an animated picture instead of a webcam
  await win.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 480;
    const g = c.getContext('2d');
    const t0 = performance.now();
    setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      const gr = g.createLinearGradient(0, 0, 640, 480);
      gr.addColorStop(0, '#5b7cfa'); gr.addColorStop(1, '#9b5de5');
      g.fillStyle = gr; g.fillRect(0, 0, 640, 480);
      g.fillStyle = '#f2c9a0'; g.beginPath(); g.arc(320 + Math.sin(t * 2) * 20, 250, 140, 0, 7); g.fill();
      g.fillStyle = '#222'; g.beginPath(); g.arc(270 + Math.sin(t * 2) * 20, 220, 16, 0, 7); g.arc(370 + Math.sin(t * 2) * 20, 220, 16, 0, 7); g.fill();
      g.strokeStyle = '#222'; g.lineWidth = 10; g.beginPath(); g.arc(320 + Math.sin(t * 2) * 20, 270, 60, 0.2, Math.PI - 0.2); g.stroke();
      g.fillStyle = '#fff'; g.font = 'bold 34px sans-serif'; g.fillText('CAM ' + t.toFixed(1), 220, 450);
    }, 33);
    const v = document.getElementById('v');
    v.srcObject = c.captureStream(30);
    document.getElementById('empty').classList.remove('show');
  });
}

(async () => {
  // virtual microphone: a null sink whose monitor is the default input, fed with speech
  execSync('pactl load-module module-null-sink sink_name=vmic sink_properties=device.description=Virtual_Mic >/dev/null; pactl set-default-source vmic.monitor; pactl set-default-sink vmic');
  const speech = path.join(OUT, 'speech.wav');
  execSync(`espeak-ng -v ru -s 150 -w ${speech} "Привет! Это тестовая запись экрана. Сейчас я нажимаю на кнопки, и клики подсвечиваются. Звук должен быть чистым и громким."`);
  let talker = null;

  const app = await electron.launch({
    executablePath: process.env.ZRI_EXE || require('electron'),
    args: process.env.ZRI_EXE ? ['--no-sandbox'] : ['--no-sandbox', path.join(__dirname, '..')],
    env: {
      ...process.env, HOME, ZRI_TEST: '1', XDG_CONFIG_HOME: path.join(HOME, '.config'),
      PULSE_SERVER: 'unix:' + execSync('pactl info').toString().match(/Server String: (.+)/)[1].trim(),
      PULSE_COOKIE: process.env.PULSE_COOKIE || require('path').join(require('os').homedir(), '.config/pulse/cookie'),
    },
  });
  app.process().stdout.on('data', (d) => process.stdout.write('[app] ' + d));
  app.process().stderr.on('data', (d) => { const s = String(d); if (/zri|rror/.test(s) && !/dbus|gles|GPU|viz|Fontconfig|ssl_client|ALSA|pulse/i.test(s)) process.stdout.write('[app!] ' + s); });

  await app.evaluate(({ BrowserWindow }) => {
    const w = new BrowserWindow({ x: 0, y: 0, width: 1920, height: 1080, frame: false, title: 'Demo site' });
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
      <body style="margin:0;font:22px system-ui;background:#f4f5f7;color:#222">
      <div style="height:70px;background:#2b2f3a;color:#fff;display:flex;align-items:center;padding:0 40px;font-weight:600">Мой сайт · Демо</div>
      <div style="padding:60px 80px;display:grid;grid-template-columns:repeat(3,1fr);gap:30px">
      ${[1, 2, 3, 4, 5, 6].map((i) => `<div style="background:#fff;border-radius:16px;height:240px;box-shadow:0 2px 10px rgba(0,0,0,.08);padding:24px">Карточка ${i}<br><button onclick="this.textContent='Нажато ✓'" style="margin-top:20px;font-size:18px;padding:10px 18px">Кнопка ${i}</button></div>`).join('')}
      </div></body>`));
    w.showInactive();
  });

  let panel = null, bubble = null;
  for (let i = 0; i < 100 && !(panel && bubble); i++) {
    panel = app.windows().find((w) => w.url().includes('panel.html'));
    bubble = app.windows().find((w) => w.url().includes('bubble.html'));
    if (!(panel && bubble)) await sleep(200);
  }
  await panel.waitForSelector('body[data-ready="1"]', { timeout: 30000, state: 'attached' });
  const logs = [];
  panel.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
  await sleep(1200);
  await fakeCamera(bubble);

  await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Zri');
    p.setPosition(1480, 160); p.show(); p.moveTop(); p.focus();
    const b = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Zri camera');
    b.moveTop();
  });
  await sleep(800);
  log('devices', JSON.stringify(await panel.evaluate(() => ({
    cams: [...document.querySelectorAll('#camSelect option')].map((o) => o.textContent),
    mics: [...document.querySelectorAll('#micSelect option')].map((o) => o.textContent),
    source: document.querySelector('#sourceName').textContent,
  }))));

  // play speech so the panel's mic meter moves, then grab the panel
  talker = spawn('bash', ['-c', `while true; do paplay --device=vmic ${speech}; sleep 0.3; done`], { stdio: 'ignore' });
  await sleep(1500);
  await panel.screenshot({ path: path.join(OUT, '01-panel.png') });
  log('mic meter width', await panel.evaluate(() => document.getElementById('micLevel').style.width));

  await panel.click('#sourceCard');
  await sleep(1200);
  await panel.screenshot({ path: path.join(OUT, '03-picker.png') });
  await panel.click('#srcGrid .src');
  await sleep(300);

  await panel.click('#colors button[data-c="#8b5cf6"]');
  await panel.click('.switch:has(#cursorOn)');
  await panel.click('#shapeSeg button[data-v="wide"]');
  await sleep(500);
  log('bubble wide', JSON.stringify(await byTitle(app, 'Zri camera')));
  await panel.click('#shapeSeg button[data-v="circle"]');
  await panel.evaluate(() => { const r = document.getElementById('sizeRange'); r.value = 240; r.dispatchEvent(new Event('input')); });
  await sleep(500);

  // drag the bubble with the real mouse, then scroll on it to resize
  const b0 = await byTitle(app, 'Zri camera');
  log('bubble before', JSON.stringify(b0));
  const cx = b0.x + Math.round(b0.width / 2), cy = b0.y + Math.round(b0.height / 3);
  xdo(`mousemove ${cx} ${cy}`); await sleep(200);
  xdo('mousedown 1'); await sleep(100);
  for (let i = 1; i <= 12; i++) { xdo(`mousemove ${cx + i * 10} ${cy - i * 22}`); await sleep(30); }
  xdo('mouseup 1'); await sleep(400);
  xdo('click 4'); await sleep(100); xdo('click 4'); await sleep(400);
  const b1 = await byTitle(app, 'Zri camera');
  log('bubble after drag+wheel', JSON.stringify(b1));
  xdo('mousemove 1000 900'); await sleep(300);

  // ---------- recording 1: start with the button, stop with the global hotkey
  await panel.click('#startBtn');
  await sleep(1500);
  shot('04-countdown.png');
  await sleep(2400);
  const info = await panel.evaluate(() => ({ rec: window.__zriRec, warn: window.__zriWarnings }));
  log('rec info', JSON.stringify(info));

  const clicks = [[220, 222], [756, 540], [1353, 222], [1100, 650]];
  for (const [x, y] of clicks) {
    xdo(`mousemove ${x} ${y}`); await sleep(450);
    xdo('mousedown 1'); await sleep(90); xdo('mouseup 1'); await sleep(40);
    shot(`05-click-${x}.png`);
    await sleep(700);
  }
  xdo('mousemove 1500 800'); await sleep(250); xdo('mousedown 3'); await sleep(90); xdo('mouseup 3'); await sleep(120); shot('06-rightclick.png');
  await sleep(600);

  // move the bubble during recording
  const b2 = await byTitle(app, 'Zri camera');
  const bx = b2.x + Math.round(b2.width / 2), by = b2.y + Math.round(b2.height / 3);
  xdo(`mousemove ${bx} ${by}`); await sleep(250); xdo('mousedown 1'); await sleep(80);
  for (let i = 1; i <= 15; i++) { xdo(`mousemove ${bx + i * 70} ${by + i * 8}`); await sleep(25); }
  xdo('mouseup 1'); await sleep(500);
  xdo('mousemove 900 900'); await sleep(300);

  // pause + resume via the floating controls
  const ctrl = app.windows().find((w) => w.url().includes('controls.html'));
  await ctrl.click('#pause');
  await sleep(1500);
  await ctrl.screenshot({ path: path.join(OUT, '07-controls-paused.png') });
  await ctrl.click('#pause');
  await sleep(2500);
  await ctrl.screenshot({ path: path.join(OUT, '08-controls.png') });

  xdo('key alt+shift+r'); // global hotkey → stop
  const res = await panel.waitForFunction(() => window.__zriLast, null, { timeout: 120000 }).then((h) => h.jsonValue());
  await sleep(800);
  await panel.screenshot({ path: path.join(OUT, '09-done.png') });
  log('RESULT', JSON.stringify({ ...res, thumb: res.thumb ? 'yes' : 'no' }));
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ...res, thumb: undefined }, null, 2));

  // ---------- recording 2: start by hotkey, cancel with the trash button → nothing saved
  await panel.evaluate(() => { window.__zriLast = null; });
  const before = fs.readdirSync(DESK).length;
  xdo('key alt+shift+r');
  let ctrl2 = null;
  for (let i = 0; i < 40 && !ctrl2; i++) { await sleep(250); ctrl2 = app.windows().find((w) => w.url().includes('controls.html')); }
  log('rec2 started', !!ctrl2);
  if (!ctrl2) {
    log('panel console:\n' + logs.join('\n'));
    shot('99-rec2-fail.png');
    throw new Error('hotkey start failed');
  }
  await sleep(4000);
  await ctrl2.click('#cancel'); await sleep(300); await ctrl2.click('#cancel');
  await sleep(2500);
  const after = fs.readdirSync(DESK).length;
  log('cancel left files unchanged', before === after, fs.readdirSync(DESK));
  log('temp dir after', fs.readdirSync(path.join(HOME, '.config', 'Zri', 'recording-temp')));

  log('panel console:\n' + logs.filter((l) => !/Autofill|DevTools|Electron Security/.test(l)).join('\n'));
  if (talker) talker.kill();
  try { execSync("pkill -x paplay"); } catch {}
  await app.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
