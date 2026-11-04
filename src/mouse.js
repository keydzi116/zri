'use strict';
// Global mouse-button watcher without hooks or special permissions.
// macOS: CoreGraphics event counters + button state.
// Windows: GetAsyncKeyState.
// Linux/X11: XQueryPointer (used for testing).
// Emits onEvent({ type: 'down'|'up', button: 'left'|'right' }).

function createMouseWatcher(onEvent, log = () => {}) {
  let koffi;
  try { koffi = require('koffi'); } catch (e) { log('koffi unavailable', e.message); return null; }

  let read; // () => { left:{down:bool, clicks:number}, right:{...} }
  try {
    if (process.platform === 'darwin') {
      const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
      const counter = cg.func('uint32_t CGEventSourceCounterForEventType(int32_t stateID, uint32_t eventType)');
      const state = cg.func('bool CGEventSourceButtonState(int32_t stateID, uint32_t button)');
      const COMBINED = 0;
      read = () => ({
        left: { down: !!state(COMBINED, 0), clicks: counter(COMBINED, 1) },
        right: { down: !!state(COMBINED, 1), clicks: counter(COMBINED, 3) },
      });
    } else if (process.platform === 'win32') {
      const user32 = koffi.load('user32.dll');
      const GetAsyncKeyState = user32.func('__stdcall', 'GetAsyncKeyState', 'int16_t', ['int32_t']);
      let lc = 0, rc = 0;
      read = () => {
        const l = GetAsyncKeyState(0x01), r = GetAsyncKeyState(0x02);
        if (l & 1) lc++;
        if (r & 1) rc++;
        return { left: { down: (l & 0x8000) !== 0, clicks: lc }, right: { down: (r & 0x8000) !== 0, clicks: rc } };
      };
    } else {
      const x11 = koffi.load('libX11.so.6');
      const XOpenDisplay = x11.func('void *XOpenDisplay(const char *name)');
      const XDefaultRootWindow = x11.func('unsigned long XDefaultRootWindow(void *d)');
      const XQueryPointer = x11.func('int XQueryPointer(void *d, unsigned long w, _Out_ unsigned long *r, _Out_ unsigned long *c, _Out_ int *rx, _Out_ int *ry, _Out_ int *wx, _Out_ int *wy, _Out_ unsigned int *mask)');
      const dpy = XOpenDisplay(null);
      if (!dpy) throw new Error('no X display');
      const root = XDefaultRootWindow(dpy);
      read = () => {
        const a = [0], b = [0], c = [0], d = [0], e = [0], f = [0], m = [0];
        XQueryPointer(dpy, root, a, b, c, d, e, f, m);
        return { left: { down: (m[0] & 256) !== 0, clicks: 0 }, right: { down: (m[0] & 1024) !== 0, clicks: 0 } };
      };
    }
    read();
  } catch (e) {
    log('mouse watcher init failed', e.message);
    return null;
  }

  let timer = null;
  let prev = null;
  function tick() {
    let cur;
    try { cur = read(); } catch { return; }
    if (!prev) { prev = cur; return; }
    for (const btn of ['left', 'right']) {
      const p = prev[btn], c = cur[btn];
      const newClicks = c.clicks > p.clicks;
      if ((c.down && !p.down) || (newClicks && !p.down)) {
        onEvent({ type: 'down', button: btn });
        if (!c.down) onEvent({ type: 'up', button: btn }); // quick tap between polls
      } else if (!c.down && p.down) {
        if (newClicks) onEvent({ type: 'down', button: btn }); // released and pressed again between polls
        onEvent({ type: 'up', button: btn });
      } else if (c.down && p.down && newClicks) {
        onEvent({ type: 'up', button: btn });
        onEvent({ type: 'down', button: btn });
      }
    }
    prev = cur;
  }
  return {
    start() { if (timer) return; prev = null; tick(); timer = setInterval(tick, 8); },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { createMouseWatcher };
