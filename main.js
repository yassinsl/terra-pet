const path = require('node:path');
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen } = require('electron');
const ANIMATIONS = require('./renderer/animations.js');
const EMOTES = require('./renderer/emotes.js');
const { HOST, startListener, removePortFile } = require('./listener.js');
const { matchReaction } = require('./reactions.js');

// The window is the 64x80 emote canvas at 4x. The pet's 48x52 cell sits at (8,28)
// on it, so the pet is the bottom 192x208 of the window, 32 px in from each side.
const SCALE = 4;
const WIDTH = 64 * SCALE;
const HEIGHT = 80 * SCALE;
const PET = { x: 8 * SCALE, y: 28 * SCALE, width: 48 * SCALE, height: 52 * SCALE };
const MARGIN = 24;   // gap between the pet and the edges of the work area
const MIN_WALK = 96; // shortest patrol walk, in px

// Back to idle when the pet has sat in one of these for this long with no hook event.
const STUCK_STATES = new Set(['work', 'sitDown', 'wait', 'think', 'ask']);
const STUCK_AFTER = 10 * 60 * 1000;
const STUCK_CHECK_EVERY = 15 * 1000;

let win = null;
let tray = null; // kept at module level so it isn't garbage-collected
let patrolEnabled = true;
let listener = null;      // { server, port } once listening
let listenerError = null;
let pet = { state: null, next: null, since: Date.now() }; // as last reported by the renderer
let lastEventAt = Date.now();
let mouseOnPet = false;

function sendToPet(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// Switches the pet's animation. `then` replaces the animation's usual "next" state.
// The renderer ignores names it doesn't know.
function setPetState(name, { then } = {}) {
  sendToPet('pet:set-state', name, then ? { then } : {});
}

// Plays an emote (renderer/emotes.js) with its pet animation.
function playPetReaction(name, { then } = {}) {
  sendToPet('pet:play-reaction', name, then ? { then } : {});
}

// Leaving work stands up first; the renderer takes care of that.
function backToIdle() {
  setPetState('idle');
}

// Claude Code hook events -> pet states.
function onHookEvent({ event, prompt }) {
  lastEventAt = Date.now();
  const busy = (s) => s === 'work' || s === 'sitDown';
  switch (event) {
    case 'prompt': {
      const reaction = matchReaction(prompt);
      if (reaction) playPetReaction(reaction, { then: 'sitDown' });
      else setPetState('sitDown');
      break;
    }
    case 'tool':
      // Also skip when a prompt reaction is about to sit down.
      if (!busy(pet.state) && !busy(pet.next)) setPetState('sitDown');
      break;
    case 'notify':
      playPetReaction('ask');
      break;
    case 'stop':
      playPetReaction('stars', { then: 'idle' });
      break;
    case 'error':
      setPetState('dizzy', { then: 'idle' });
      break;
    case 'session-start':
      setPetState('wave');
      break;
  }
}

// Stop and StopFailure don't fire when you interrupt Claude, so don't trust
// "work" (or waiting) forever.
function checkStuck() {
  if (!STUCK_STATES.has(pet.state)) return;
  if (Date.now() - Math.max(lastEventAt, pet.since) >= STUCK_AFTER) backToIdle();
}

// Only the pet's own cell catches the mouse; everywhere else in the window,
// clicks go through to whatever is behind. Moves are still forwarded to the
// page, which reports when the pointer enters or leaves the pet.
function setMouseOnPet(on) {
  if (!win || on === mouseOnPet) return;
  mouseOnPet = on;
  win.setIgnoreMouseEvents(!on, { forward: true });
}

function cursorOnPet() {
  const cursor = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  const cx = cursor.x - x;
  const cy = cursor.y - y;
  return cx >= PET.x && cx < PET.x + PET.width && cy >= PET.y && cy < PET.y + PET.height;
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: workArea.x + workArea.width - MARGIN - PET.width - PET.x,
    y: workArea.y + workArea.height - MARGIN - HEIGHT,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    acceptFirstMouse: true, // Terra is never the active app, so its first click must count
    // The transparent margin may hang past the screen edge so the pet itself can sit
    // 24 px from it; without this macOS pushes the whole window back on screen.
    enableLargerThanScreen: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // visibleOnFullScreen also keeps the Dock icon hidden: without it,
  // Electron calls DockShow() here on macOS.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.webContents.on('did-finish-load', () => sendToPet('pet:set-patrol', patrolEnabled));
}

function createTray() {
  const src = nativeImage.createFromPath(path.join(__dirname, 'Bot', 'terra-bot-48x52.png'));
  const icon = nativeImage.createEmpty();
  icon.addRepresentation({ scaleFactor: 1, buffer: src.resize({ height: 18 }).toPNG() });
  icon.addRepresentation({ scaleFactor: 2, buffer: src.resize({ height: 36 }).toPNG() });

  tray = new Tray(icon);
  tray.setToolTip('Terra');
  updateTrayMenu();
}

function updateTrayMenu() {
  let status = 'Starting listener…';
  if (listener) status = `Listening on ${HOST}:${listener.port}`;
  else if (listenerError) status = `Listener off: ${listenerError}`;

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: 'separator' },
    {
      label: 'Play animation',
      submenu: Object.keys(ANIMATIONS).map((name) => ({ label: name, click: () => setPetState(name) })),
    },
    {
      label: 'Play reaction',
      submenu: Object.keys(EMOTES).map((name) => ({ label: name, click: () => playPetReaction(name) })),
    },
    { label: 'Back to idle', click: backToIdle },
    {
      label: 'Patrol',
      type: 'checkbox',
      checked: patrolEnabled,
      click: (item) => {
        patrolEnabled = item.checked;
        sendToPet('pet:set-patrol', patrolEnabled);
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

ipcMain.on('pet:state', (event, state, next) => {
  if (!win || event.sender !== win.webContents) return;
  pet = { state, next, since: state === pet.state ? pet.since : Date.now() };
});

ipcMain.on('pet:mouse-over-pet', (event, on) => {
  if (!win || event.sender !== win.webContents) return;
  setMouseOnPet(on === true);
});

// The renderer sends the new top-left corner while the pet is dragged or walking.
ipcMain.on('pet:move', (event, x, y) => {
  if (!win || event.sender !== win.webContents) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  win.setPosition(Math.round(x), Math.round(y));
  // The pet may have walked out from under (or in under) a still cursor.
  setMouseOnPet(cursorOnPet());
});

// Picks where the next patrol walk goes: a random x along the bottom of the
// work area of the display the pet is on. Positions are the window's top-left;
// the pet (not the transparent margin around it) stays inside the work area.
ipcMain.handle('pet:patrol-route', (event) => {
  if (!win || event.sender !== win.webContents) return null;
  const [x, y] = win.getPosition();
  const { workArea } = screen.getDisplayMatching(win.getBounds());
  const minX = workArea.x + MARGIN - PET.x;
  const maxX = workArea.x + workArea.width - MARGIN - PET.width - PET.x;
  let toX = x;
  for (let tries = 0; tries < 10 && Math.abs(toX - x) < MIN_WALK; tries++) {
    toX = Math.round(minX + Math.random() * (maxX - minX));
  }
  const toY = workArea.y + workArea.height - MARGIN - HEIGHT;
  return { from: { x, y }, to: { x: toX, y: toY } };
});

app.whenReady().then(async () => {
  // Hides the app from the Dock and the Cmd+Tab switcher.
  if (app.dock) app.dock.hide();
  createWindow();
  createTray();
  setInterval(checkStuck, STUCK_CHECK_EVERY);
  try {
    listener = await startListener(onHookEvent);
  } catch (err) {
    listenerError = err.message;
    console.error('Terra listener not started:', err.message);
  }
  updateTrayMenu();
});

// Ctrl+C in the terminal running `npm start`, or a kill, should quit the normal way
// too, so the port file is removed and hooks don't keep aiming at a closed port.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => app.quit());

app.on('will-quit', () => {
  if (!listener) return;
  listener.server.close();
  removePortFile(listener.port);
});

// Keep running with no windows; Quit lives in the tray menu.
app.on('window-all-closed', () => {});
