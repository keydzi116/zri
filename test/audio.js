// Audio + pause test: fake mic fed from a speech file; record 4s, pause 3s, record 4s.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const OUT = process.env.OUT || require('path').join(require('os').tmpdir(), 'zri-audio');
const HOME = path.join(OUT, 'home');
fs.mkdirSync(path.join(HOME, 'Desktop'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SPEECH = process.argv[2];

(async () => {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${SPEECH}`, path.join(__dirname, '..')],
    env: { ...process.env, HOME, ZRI_TEST: '1', XDG_CONFIG_HOME: path.join(HOME, '.config') },
  });
  let panel = null;
  for (let i = 0; i < 100 && !panel; i++) { panel = app.windows().find((w) => w.url().includes('panel.html')); if (!panel) await sleep(200); }
  await panel.waitForSelector('body[data-ready="1"]', { timeout: 30000, state: 'attached' });
  await sleep(1500);
  await panel.click('.switch:has(#cdOn)').catch(() => {});
  // make sure countdown is off for exact timing
  await panel.evaluate(() => zri.setSettings({ countdown: false }));
  const meter = await panel.evaluate(() => document.getElementById('micLevel').style.width);
  console.log('panel mic meter', meter, 'mic', await panel.evaluate(() => document.getElementById('micSelect').selectedOptions[0].textContent));
  const t0 = Date.now();
  await panel.click('#startBtn');
  let ctrl = null;
  for (let i = 0; i < 40 && !ctrl; i++) { await sleep(100); ctrl = app.windows().find((w) => w.url().includes('controls.html')); }
  await sleep(4000);
  const levelSeen = [];
  ctrl.on('console', () => {});
  await ctrl.click('#pause');
  await sleep(3000);
  await ctrl.click('#pause');
  await sleep(4000);
  await ctrl.click('#stop');
  const res = await panel.waitForFunction(() => window.__zriLast, null, { timeout: 60000 }).then((h) => h.jsonValue());
  console.log('wall', ((Date.now() - t0) / 1000).toFixed(1), 's', 'RESULT', JSON.stringify({ ...res, thumb: !!res.thumb }));
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ...res, thumb: undefined }));
  await app.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
