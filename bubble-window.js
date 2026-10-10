// The speech bubble's window: small, transparent, beside the pet and just above it, never
// focused. A window of its own, so the pet's window and its click-through stay as they are.
// Only the bubble's own pixels catch the mouse (everything else passes through, as with
// the pet), and a click on it dismisses it. renderer/bubble.js draws it.
//
// The text lives here in memory only while the bubble shows: never logged, never saved.
const path = require('node:path');
const { BrowserWindow, ipcMain, screen } = require('electron');
const { TIMING, TAIL_HEIGHT, parts, placeBubble } = require('./bubble-layout.js');

// petWindow: the pet's BrowserWindow. getScale(): the pet's size. onEnded(id, why): the
// bubble with that id has gone (why: 'timeout', 'click' or 'hidden'). onPhase(phase, chars):
// it popped in, its text shows (full), it fades, or it has gone (hidden); chars is how many
// characters it shows (for the talk blips).
function createBubbleWindow({ petWindow, getScale, onEnded, onPhase = () => {} }) {
  const win = new BrowserWindow({
    width: 16,
    height: 20,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    focusable: false, // never takes focus from the app you are using
    acceptFirstMouse: true, // so a click dismisses it without activating Terra first
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    skipTaskbar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'bubble-preload.js') },
  });
  win.setAlwaysOnTop(true, 'floating', 1); // one level above the pet, so the tail's tip shows
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'bubble.html'));

  let current = null; // { id, layout, tail, phase, timers }
  let mouseOn = false;

  const send = (state) => {
    if (!win.isDestroyed()) win.webContents.send('bubble:draw', state);
  };

  function draw() {
    if (!current) {
      send({ phase: 'hidden' });
      return;
    }
    const { layout, tail, phase } = current;
    const at = parts(layout, tail);
    send({
      phase, tail, scale: getScale(), width: layout.width, height: layout.height, imageHeight: layout.height + TAIL_HEIGHT,
      glyphs: layout.glyphs, tailAt: at.tail, popAt: at.pop,
    });
  }

  // Puts the window beside the pet; true when the bubble changed sides.
  function place() {
    const pet = petWindow.getBounds();
    const { workArea } = screen.getDisplayMatching(pet);
    const { tail, bounds } = placeBubble(current.layout, pet, getScale(), workArea);
    const flipped = tail !== current.tail;
    current.tail = tail;
    win.setBounds(bounds);
    return flipped;
  }

  function setMouseOn(on) {
    if (on === mouseOn) return;
    mouseOn = on;
    win.setIgnoreMouseEvents(!on, { forward: true });
  }

  function later(ms, fn) {
    current.timers.push(setTimeout(fn, ms));
  }

  const charsOf = (layout) => layout.lines.reduce((n, line) => n + line.length, 0);

  function setPhase(phase) {
    if (!current) return;
    current.phase = phase;
    draw();
    onPhase(phase, charsOf(current.layout));
  }

  function finish(why) {
    if (!current) return;
    const { id, timers } = current;
    timers.forEach(clearTimeout);
    current = null;
    setMouseOn(false);
    win.hide();
    draw();
    onPhase('hidden', 0);
    onEnded(id, why);
  }

  function fadeOut() {
    setPhase('fade');
    later(TIMING.fadeMs, () => finish('timeout'));
  }

  // Shows `layout` (bubble-layout.js) as bubble `id`; one already showing is replaced.
  // The pop-in frame, then the bubble held for layout.holdMs, then a fade. `until`: a
  // promise (Terra's voice reading it); the bubble also stays until it settles.
  function show(id, layout, { until = null } = {}) {
    if (current) current.timers.forEach(clearTimeout);
    const mine = { id, layout, tail: null, phase: 'pop', timers: [], heard: !until, held: false };
    current = mine;
    if (until) {
      const heard = () => {
        mine.heard = true;
        if (current === mine && mine.held) fadeOut();
      };
      until.then(heard, heard);
    }
    setMouseOn(false);
    place();
    draw();
    onPhase('pop', charsOf(layout));
    if (!win.isVisible()) win.showInactive();
    later(TIMING.popMs, () => setPhase('full'));
    later(TIMING.popMs + layout.holdMs, () => {
      if (mine.heard) fadeOut();
      else mine.held = true; // held long enough; fades when the voice has finished
    });
  }

  // A click: fade out now.
  function dismiss() {
    if (!current || current.phase === 'fade') return;
    current.timers.forEach(clearTimeout);
    current.timers = [];
    setMouseOn(false);
    setPhase('fade');
    later(TIMING.fadeMs, () => finish('click'));
  }

  // The pet moved or changed size: follow it (and flip if it has to).
  function follow({ resized = false } = {}) {
    if (!current) return;
    if (place() || resized) draw();
  }

  win.webContents.on('did-finish-load', () => draw()); // anything sent before the page was ready

  ipcMain.on('bubble:mouse-over', (event, on) => {
    if (event.sender === win.webContents) setMouseOn(on === true);
  });
  ipcMain.on('bubble:dismiss', (event) => {
    if (event.sender === win.webContents) dismiss();
  });

  return {
    win,
    show,
    dismiss,
    follow,
    hide: () => finish('hidden'),
    showing: () => (current ? { id: current.id, tail: current.tail, phase: current.phase } : null),
  };
}

module.exports = { createBubbleWindow };
