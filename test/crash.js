// Crash test: start recording, hard-kill the app, relaunch → the partial recording must be saved.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const OUT = process.env.OUT || require('path').join(require('os').tmpdir(), 'zri-crash');
const HOME = path.join(OUT, 'home');
const DESK = path.join(HOME, 'Desktop');
fs.mkdirSync(DESK, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', path.join(__dirname, '..')],
    env: { ...process.env, HOME, ZRI_TEST: '1', XDG_CONFIG_HOME: path.join(HOME, '.config') },
  });
  app.process().stdout.on('data', (d) => process.stdout.write('[app] ' + d));
  let panel = null;
  for (let i = 0; i < 100 && !panel; i++) { panel = app.windows().find((w) => w.url().includes('panel.html')); if (!panel) await sleep(200); }
  await panel.waitForSelector('body[data-ready="1"]', { timeout: 30000, state: 'attached' });
  return { app, panel };
}

(async () => {
  let { app, panel } = await launch();
  await panel.evaluate(() => zri.setSettings({ countdown: false }));
  await sleep(500);
  await panel.click('#startBtn');
  await sleep(6000);
  const tmp = path.join(HOME, '.config', 'Zri', 'recording-temp');
  console.log('temp while recording', fs.readdirSync(tmp).map((f) => f + ' ' + fs.statSync(path.join(tmp, f)).size));
  process.kill(app.process().pid, 'SIGKILL');
  await sleep(1500);
  console.log('desktop after crash', fs.readdirSync(DESK));
  ({ app, panel } = await launch());
  for (let i = 0; i < 40 && !fs.readdirSync(DESK).length; i++) await sleep(500);
  await sleep(1000);
  console.log('desktop after relaunch', fs.readdirSync(DESK));
  await panel.screenshot({ path: path.join(OUT, 'recovered.png') });
  await app.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
