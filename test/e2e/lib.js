// Shared setup for the Electron end-to-end tests. Runs the real main.js and records:
// the tray menu, setIgnoreMouseEvents calls, the states the renderer reports, and every
// sprite cell and emote frame the canvas draws (via a hook installed before the page loads).
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, check, section, summary, wait, isolateHome } = require('../lib.js');

isolateHome('e2e'); // before main.js requires listener.js
const { app, BrowserWindow, Menu, ipcMain, powerSaveBlocker, screen } = require('electron');
// A fresh user data folder, so a position or size you saved doesn't leak into the tests.
const userData = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'terra-e2e-userdata-'));
app.setPath('userData', userData);
// These tests were written around a 4x window, so they start with 4x chosen (the default,
// Match small 2.25x, is covered by startup.test.js and size.e2e.js).
fs.writeFileSync(path.join(userData, 'window-state.json'), JSON.stringify({ version: 2, scale: 4 }));
const ANIMATIONS = require(path.join(ROOT, 'renderer', 'animations.js'));
const EMOTES = require(path.join(ROOT, 'renderer', 'emotes.js'));

const t = { trayMenu: null, ignoreCalls: [], states: [], win: null, wc: null, consoleLog: [], realMouse: 0, userData };

const realBuild = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = (template) => (t.trayMenu = realBuild(template));
const realIgnore = BrowserWindow.prototype.setIgnoreMouseEvents;
BrowserWindow.prototype.setIgnoreMouseEvents = function (ignore, options) {
  t.ignoreCalls.push({ ignore, forward: !!(options && options.forward) });
  return realIgnore.call(this, ignore, options);
};
ipcMain.on('pet:state', (_e, state, next) => t.states.push({ t: Date.now(), state, next }));

const DRAW_HOOK = `
  window.__draws = [];
  const orig = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (img, ...a) {
    const m = (img && img.src || '').match(/emotes-only\\/(\\w+)-(\\d+)\\.png$/);
    window.__draws.push(m ? [performance.now(), 'e', m[1], +m[2]] : [performance.now(), 'p', a[1] / 52, a[0] / 48, a[4], a[5], a[6]]);
    return orig.call(this, img, ...a);
  };
  // Times the page drew nothing for over 150 ms (the OS sometimes freezes it briefly).
  window.__stalls = [];
  window.__longStalls = []; // over 3 s: display off or screen locked
  window.__visibility = [];
  document.addEventListener('visibilitychange', () => window.__visibility.push([Math.round(performance.now()), document.visibilityState]));
  window.__lastFrame = performance.now();
  const watch = (now) => {
    const gap = now - window.__lastFrame;
    if (gap > 150) window.__stalls.push(gap);
    if (gap > 3000) window.__longStalls.push(gap);
    window.__lastFrame = now;
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);`;

const js = (code) => t.wc.executeJavaScript(code);
const current = () => (t.states.length ? t.states[t.states.length - 1].state : null);
const menuItem = (label) => t.trayMenu.items.find((i) => i.label === label);
const subItem = (menu, label) => menuItem(menu).submenu.items.find((i) => i.label === label);
const clipMs = (def) => (Array.isArray(def.ms) ? def.ms : Array(def.frames).fill(def.ms));

// Each canvas redraw is one pet cell, optionally followed by one emote frame:
// [{ t, row, frame, dest: [x, y, width], emote: 'hi-3' | null }]
async function takeFrames() {
  const draws = await js('window.__draws.splice(0)');
  const frames = [];
  for (const d of draws) {
    if (d[1] === 'p') frames.push({ t: d[0], row: d[2], frame: d[3], dest: [d[4], d[5], d[6]], emote: null });
    else if (frames.length) frames[frames.length - 1].emote = `${d[2]}-${d[3]}`;
  }
  return frames;
}

// Consecutive frames grouped by pet row.
function segments(frames) {
  const segs = [];
  for (const f of frames) {
    const last = segs[segs.length - 1];
    if (last && last.row === f.row) last.items.push(f);
    else segs.push({ row: f.row, items: [f] });
  }
  return segs;
}

// Runs of the same emote frame: [{ name, n, t }]
function emoteRuns(frames) {
  const runs = [];
  for (const f of frames) {
    const last = runs[runs.length - 1];
    const key = f.emote || null;
    if (!last || last.key !== key) runs.push({ key, t: f.t });
  }
  return runs;
}

// Waits until the pet is in `state`, reported after the first `since` states.
async function waitFor(state, timeout = 6000, since = 0) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (t.states.length > since && current() === state) return true;
    await wait(25);
  }
  return false;
}

// Runs a timing-sensitive scenario and checks its result. If it fails while the page
// froze, or while the real mouse was over the test pet (someone clicking or dragging
// it), the result says nothing about Terra, so the scenario runs again (twice at most).
// scenario(attemptNumber) returns { ok, line }.
async function attempt(label, scenario) {
  const notes = [];
  let r;
  for (let n = 1; n <= 3; n++) {
    await js('window.__stalls.length = 0');
    t.realMouse = 0;
    r = await scenario(n);
    if (r.ok || n === 3) break;
    const stalls = await js('window.__stalls.splice(0)');
    const why = [];
    if (stalls.length) why.push(`the page froze for ${Math.round(Math.max(...stalls))} ms`);
    if (t.realMouse) why.push('the real mouse was over the test pet');
    if (!why.length) break;
    notes.push(`try ${n}: ${why.join(' and ')}, gave: ${r.line}`);
  }
  return check(label, r.ok, r.line + (notes.length ? ` (retried; ${notes.join('; ')})` : ''));
}

// Counts moments the real cursor is over the test window.
function watchRealMouse() {
  setInterval(() => {
    if (!t.win || t.win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    const b = t.win.getBounds();
    if (c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height) t.realMouse++;
  }, 100).unref();
}

const compress = (list) => list.map((s) => s.state).filter((s, i, a) => i === 0 || s !== a[i - 1]);

// Sends something, waits for the pet to settle, and checks the states and emotes seen.
// send() resolves to undefined or '204' when it went through, else to what went wrong.
async function step(label, send, want, emotes, settle) {
  const from = t.states.length;
  await takeFrames();
  const startRow = await js('clip && clip.row');
  const status = await send();
  if (settle) await waitFor(settle, 8000, from);
  await wait(settle ? 250 : 600);
  const seen = compress(t.states.slice(from));
  // Emotes drawn after the pet changed state (the old one shows until the event lands).
  const frames = await takeFrames();
  const changed = frames.findIndex((f) => f.row !== startRow);
  const after = want.length && changed >= 0 ? frames.slice(changed) : frames;
  const shown = [...new Set(after.filter((f) => f.emote).map((f) => f.emote.replace(/-\d+$/, '')))];
  const sent = status === undefined || status === '204';
  const ok = sent && seen.join(' ') === want.join(' ') && shown.join(' ') === emotes.join(' ');
  if (!ok) {
    console.log('DEBUG renderer:', JSON.stringify(await js('({ state, row: clip && clip.row, step, stepTime, playsDone, plays: clip && clip.plays, hasEnd: !!onClipEnd, emote: emote && { name: emote.name, step: emote.step, stepTime: emote.stepTime }, afterEmote, sinceLastTick: performance.now() - lastTick, pending, visibility: document.visibilityState, visibilityChanges: window.__visibility, msSinceLastFrame: Math.round(performance.now() - window.__lastFrame), stalls: window.__stalls.slice(-8).map(Math.round) })')));
    console.log('DEBUG frames in 1 s:', await js('new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); })'),
      '| window visible:', t.win.isVisible(), 'occluded-ish? focused:', t.win.isFocused(), 'bounds:', JSON.stringify(t.win.getBounds()));
  }
  check(label, ok, `${status ? `${/^\d{3}$/.test(status) ? `HTTP ${status}` : status}, ` : ''}${seen.join(' -> ') || '(no change)'}${shown.length ? `, emote ${shown.join(', ')}` : ''}${ok ? '' : `   want: ${want.join(' -> ') || '(no change)'}${emotes.length ? `, emote ${emotes.join(', ')}` : ''}`}`);
}

// Starts the app and runs `body` once the page has loaded (with the draw hook in place).
function start(body, { timeout = 300000 } = {}) {
  require(path.join(ROOT, 'main.js'));
  // macOS stops drawing windows while the display sleeps, which would freeze the pet.
  app.whenReady().then(() => powerSaveBlocker.start('prevent-display-sleep'));
  app.on('browser-window-created', (_e, w) => {
    if (t.win) return;
    t.win = w;
    t.wc = w.webContents;
    watchRealMouse();
    t.wc.on('console-message', (e) => t.consoleLog.push({ level: e.level, message: e.message }));
    t.wc.debugger.attach('1.3');
    const hooked = t.wc.debugger.sendCommand('Page.enable')
      .then(() => t.wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: DRAW_HOOK }));
    let loads = 0;
    t.wc.on('did-finish-load', async () => {
      if (++loads === 1) {
        await hooked;
        t.wc.reload(); // so the draw hook is there from the first frame
        return;
      }
      await wait(600); // the listener starts right after the window
      try {
        await body();
      } catch (err) {
        check('test run', false, err.stack);
      }
      const errors = t.consoleLog.filter((m) => m.level === 'error');
      check('no renderer console errors', errors.length === 0, errors.map((m) => m.message).join(' | ') || 'none');
      const long = await js('window.__longStalls.concat(performance.now() - window.__lastFrame > 3000 ? [performance.now() - window.__lastFrame] : [])');
      check('page was drawn the whole time', long.length === 0, long.length
        ? `not drawn for ${long.map((g) => (g / 1000).toFixed(1)).join(', ')} s (display off or screen locked?): the results above don't count, run again`
        : 'yes');
      app.exit(summary() ? 1 : 0);
    });
  });
  setTimeout(() => {
    check('finished in time', false, `timed out after ${timeout / 1000} s`);
    app.exit(summary() ? 1 : 0);
  }, timeout);
}

module.exports = {
  ROOT, ANIMATIONS, EMOTES, t, check, section, wait, js, current, menuItem, subItem, clipMs,
  takeFrames, segments, emoteRuns, waitFor, compress, attempt, step, start, BrowserWindow, fs, path,
};
