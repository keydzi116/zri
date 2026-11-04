// Records the README demo on the virtual display: an English demo page, the camera bubble,
// smooth mouse moves and clicks. Output: $OUT/home/Desktop/*.mp4 (+ panel screenshot).
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const OUT = process.env.OUT || require('path').join(require('os').tmpdir(), 'zri-demo');
const HOME = path.join(OUT, 'home');
fs.mkdirSync(path.join(HOME, 'Desktop'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const xdo = (cmd) => execSync(`xdotool ${cmd}`, { env: process.env });
let cur = [960, 900];
async function glide(x, y, ms = 600) {
  const steps = Math.max(8, Math.round(ms / 16));
  const [x0, y0] = cur;
  for (let i = 1; i <= steps; i++) {
    const k = i / steps, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    xdo(`mousemove ${Math.round(x0 + (x - x0) * e)} ${Math.round(y0 + (y - y0) * e)}`);
    await sleep(ms / steps);
  }
  cur = [x, y];
}
async function click() { xdo('mousedown 1'); await sleep(90); xdo('mouseup 1'); }

const PAGE = `
<body style="margin:0;font:16px -apple-system,Inter,system-ui,sans-serif;background:#f6f7fb;color:#1d2433">
<div style="height:64px;background:#fff;display:flex;align-items:center;gap:36px;padding:0 56px;box-shadow:0 1px 0 #e6e8ef">
  <b style="font-size:20px">◆ Northwind</b><span style="color:#6b7385">Dashboard</span><span style="color:#6b7385">Customers</span><span style="color:#6b7385">Reports</span>
  <span id="inv" onclick="this.textContent='Invited ✓'" style="margin-left:auto;background:#1d2433;color:#fff;padding:9px 16px;border-radius:9px">Invite team</span></div>
<div style="padding:48px 56px;display:grid;grid-template-columns:2fr 1fr;gap:28px">
  <div style="background:#fff;border-radius:16px;padding:28px;box-shadow:0 2px 12px rgba(20,30,60,.06)">
    <div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:20px">Revenue</b>
    <div onclick="for(const e of this.children)e.style.background=e===event.target?'#fff':'transparent'" style="display:flex;gap:6px;background:#f0f2f7;padding:4px;border-radius:9px"><span id="w" style="padding:6px 12px;border-radius:7px">Week</span><span id="m" style="padding:6px 12px;border-radius:7px;background:#fff">Month</span><span id="y" style="padding:6px 12px;border-radius:7px">Year</span></div></div>
    <div style="font-size:38px;font-weight:700;margin:22px 0 4px">$48,290</div><div style="color:#1a9d5c">▲ 12.4% vs last month</div>
    <svg viewBox="0 0 600 180" style="width:100%;margin-top:22px"><path d="M0 150 C 60 140 90 90 150 100 S 240 60 300 80 S 390 30 450 50 S 540 20 600 10" fill="none" stroke="#5b6cff" stroke-width="4"/><path d="M0 150 C 60 140 90 90 150 100 S 240 60 300 80 S 390 30 450 50 S 540 20 600 10 V180 H0Z" fill="rgba(91,108,255,.10)"/></svg>
  </div>
  <div style="display:grid;gap:28px">
    <div style="background:#fff;border-radius:16px;padding:24px;box-shadow:0 2px 12px rgba(20,30,60,.06)"><div style="color:#6b7385">Active users</div><div style="font-size:30px;font-weight:700;margin-top:6px">3,412</div></div>
    <div style="background:#fff;border-radius:16px;padding:24px;box-shadow:0 2px 12px rgba(20,30,60,.06)"><div style="color:#6b7385">New signups</div><div style="font-size:30px;font-weight:700;margin-top:6px">287</div>
      <button id="exp" onclick="this.textContent='Exported ✓'" style="margin-top:16px;width:100%;padding:12px;border:0;border-radius:10px;background:#5b6cff;color:#fff;font-size:15px">Export CSV</button></div>
  </div>
</div></body>`;

(async () => {
  const app = await electron.launch({
    executablePath: process.env.ZRI_EXE || require('electron'),
    args: process.env.ZRI_EXE ? ['--no-sandbox'] : ['--no-sandbox', path.join(__dirname, '..')],
    env: { ...process.env, HOME, ZRI_TEST: '1', ZRI_LANG: process.env.ZRI_LANG || 'en', XDG_CONFIG_HOME: path.join(HOME, '.config') },
  });
  await app.evaluate(({ BrowserWindow }, html) => {
    const w = new BrowserWindow({ x: 0, y: 0, width: 1920, height: 1080, frame: false, title: 'Demo site' });
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    w.showInactive();
  }, PAGE);
  let panel = null, bubble = null;
  for (let i = 0; i < 100 && !(panel && bubble); i++) {
    panel = app.windows().find((w) => w.url().includes('panel.html'));
    bubble = app.windows().find((w) => w.url().includes('bubble.html'));
    if (!(panel && bubble)) await sleep(200);
  }
  await panel.waitForSelector('body[data-ready="1"]', { timeout: 30000, state: 'attached' });
  await sleep(800);
  // test-only stand-in for a webcam: a friendly animated face
  await bubble.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 640;
    const g = c.getContext('2d'); const t0 = performance.now();
    setInterval(() => {
      const t = (performance.now() - t0) / 1000, sway = Math.sin(t * 1.6) * 10, blink = (t % 3.2) < 0.12;
      const gr = g.createLinearGradient(0, 0, 640, 640); gr.addColorStop(0, '#ffb86b'); gr.addColorStop(1, '#ff6b9a');
      g.fillStyle = gr; g.fillRect(0, 0, 640, 640);
      g.fillStyle = '#2b2f3a'; g.beginPath(); g.ellipse(320 + sway, 610, 230, 170, 0, 0, 7); g.fill();
      g.fillStyle = '#f3c8a2'; g.beginPath(); g.ellipse(320 + sway, 300, 140, 165, 0, 0, 7); g.fill();
      g.fillStyle = '#3a2a22'; g.beginPath(); g.ellipse(320 + sway, 175, 150, 75, 0, Math.PI, 0); g.fill();
      g.fillStyle = '#222';
      if (blink) { g.fillRect(262 + sway, 288, 34, 5); g.fillRect(344 + sway, 288, 34, 5); }
      else { g.beginPath(); g.arc(279 + sway, 290, 12, 0, 7); g.arc(361 + sway, 290, 12, 0, 7); g.fill(); }
      g.strokeStyle = '#8a3b3b'; g.lineWidth = 9; g.lineCap = 'round';
      g.beginPath(); g.arc(320 + sway, 345, 46 + Math.abs(Math.sin(t * 5)) * 6, 0.25, Math.PI - 0.25); g.stroke();
    }, 33);
    const v = document.getElementById('v'); v.srcObject = c.captureStream(30);
    document.getElementById('empty').classList.remove('show');
  });
  await panel.evaluate(() => zri.setSettings({ countdown: false, highlightCursor: true, clickColor: '#ffd23f', bubble: { size: 250, shape: 'circle', mirror: false } }));
  await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Zri');
    p.setPosition(1460, 150); p.show(); p.moveTop();
  });
  await sleep(1200);
  await panel.screenshot({ path: path.join(OUT, 'panel.png') });
  xdo(`mousemove ${cur[0]} ${cur[1]}`);
  await panel.click('#startBtn');
  for (let i = 0; i < 40; i++) { if (await panel.evaluate(() => !!window.__zriRec)) break; await sleep(100); }
  await sleep(700);
  const site = app.windows().find((w) => w.url().startsWith('data:'));
  const at = async (sel) => site.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; }, sel);
  const [yx, yy] = await at('#y'); const [mx, my] = await at('#m'); const [ex, ey] = await at('#exp'); const [ix, iy] = await at('#inv');
  await glide(yx, yy, 800); await sleep(250); await click(); await sleep(800);      // Year tab
  await glide(mx, my, 450); await sleep(200); await click(); await sleep(700);      // Month tab
  await glide(ex, ey, 850); await sleep(250); await click(); await sleep(900);      // Export CSV
  await glide(ix, iy, 750); await sleep(250); await click(); await sleep(900);      // Invite team
  await glide(700, 430, 900); await sleep(1000);
  await panel.evaluate(() => window.__zriStop());
  const res = await panel.waitForFunction(() => window.__zriLast, null, { timeout: 120000 }).then((h) => h.jsonValue());
  console.log('RESULT', JSON.stringify({ ...res, thumb: !!res.thumb }));
  await app.close();
})().catch((e) => { console.error('DEMO FAILED', e); process.exit(1); });
