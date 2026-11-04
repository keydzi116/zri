// Window-mode test: record a single window instead of the whole screen.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const OUT = process.env.OUT || require('path').join(require('os').tmpdir(), 'zri-win');
const HOME = path.join(OUT, 'home');
fs.mkdirSync(path.join(HOME, 'Desktop'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', path.join(__dirname, '..')], env: { ...process.env, HOME, ZRI_TEST: '1', XDG_CONFIG_HOME: path.join(HOME, '.config') } });
  require('child_process').spawn('xclock', ['-geometry', '700x500+300+200', '-update', '1', '-title', 'Notes window', '-bg', '#fff3c4'], { stdio: 'ignore', detached: true });
  await sleep(1000);
  let panel = null;
  for (let i = 0; i < 100 && !panel; i++) { panel = app.windows().find((w) => w.url().includes('panel.html')); if (!panel) await sleep(200); }
  await panel.waitForSelector('body[data-ready="1"]', { timeout: 30000, state: 'attached' });
  await panel.evaluate(() => zri.setSettings({ countdown: false }));
  await sleep(800);
  await panel.click('#sourceCard'); await sleep(1500);
  await panel.click('#srcTabs button[data-v="window"]'); await sleep(300);
  const names = await panel.evaluate(() => [...document.querySelectorAll('#srcGrid .src .n')].map((n) => n.textContent));
  console.log('windows offered', JSON.stringify(names));
  await panel.screenshot({ path: path.join(OUT, 'picker-windows.png') });
  const idx = names.findIndex((n) => /Notes/.test(n));
  await panel.click(`#srcGrid .src >> nth=${idx}`); await sleep(300);
  console.log('selected', await panel.evaluate(() => document.getElementById('sourceName').textContent));
  await panel.click('#startBtn');
  await sleep(3500);
  await panel.evaluate(() => window.__zriStop());
  const res = await panel.waitForFunction(() => window.__zriLast, null, { timeout: 60000 }).then((h) => h.jsonValue());
  console.log('RESULT', JSON.stringify({ ...res, thumb: !!res.thumb }), JSON.stringify(await panel.evaluate(() => window.__zriRec)));
  await app.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
