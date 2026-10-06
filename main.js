const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, screen } = require('electron');
const ANIMATIONS = require('./renderer/animations.js');
const EMOTES = require('./renderer/emotes.js');
const hooks = require('./hook-installer.js');
const mcp = require('./mcp-installer.js');
const windowState = require('./window-state.js');
const visibility = require('./visibility.js');
const claude = require('./claude-app.js'); // used as claude.isRunning() so tests can fake it
const { HOST, startListener, removePortFile } = require('./listener.js');
const { matchReaction } = require('./reactions.js');

const { MARGIN, SCALES, geometry } = windowState;

// Back to idle when the pet has sat in one of these for this long with no hook event.
const STUCK_STATES = new Set(['work', 'sitDown', 'wait', 'think', 'ask']);
const STUCK_AFTER = 10 * 60 * 1000;
const STUCK_CHECK_EVERY = 15 * 1000;
// How long a looping reaction (talk, sad, ask) asked for by Claude desktop plays.
const LOOP_REACTION_MS = 4000;

let win = null;
let tray = null; // kept at module level so it isn't garbage-collected
let scale = windowState.DEFAULT_SCALE; // 1x to 4x (SCALES): one sprite pixel is `scale` points
let scaleChosen = false; // picked from the Size menu (then it is saved and wins at startup)
let patrolEnabled = true;
let listener = null;      // { server, port } once listening
let listenerError = null;
let hooksStatus = 'not installed';
let mcpStatus = 'not installed';
let loopReactionTimer = null;
let pet = { state: null, next: null, since: Date.now() }; // as last reported by the renderer
let lastEventAt = Date.now();
let mouseOnPet = false;
let saveTimer = null;
let prefs = { showWhen: visibility.DEFAULT_MODE, loginItemDefaultDone: false };
let claudeRunning = null; // Claude desktop, as of the last check (null: not known yet)
let lastCodeEventAt = 0;  // last Claude Code hook event
let petShown = false;
let hidePending = false;  // waiting for the current animation to finish before hiding
let hideTimer = null;
let polling = false;

// The packaged app has no npm scripts, so it takes these instead:
//   Terra --install-hooks | --uninstall-hooks [--settings <path>]
//   Terra --install-mcp | --uninstall-mcp [--config <path>]
// It prints what it changed and quits without showing the pet.
const CLI = {
  '--install-hooks': () => hooks.install(hooks.settingsPathFromArgs(process.argv)),
  '--uninstall-hooks': () => hooks.uninstall(hooks.settingsPathFromArgs(process.argv)),
  '--install-mcp': () => mcp.install(mcp.configPathFromArgs(process.argv)),
  '--uninstall-mcp': () => mcp.uninstall(mcp.configPathFromArgs(process.argv)),
};
const cliFlag = Object.keys(CLI).find((flag) => process.argv.includes(flag));
if (cliFlag) runCli(cliFlag);
else startApp();

function runCli(flag) {
  const { code, text } = CLI[flag]();
  fs.writeSync(code ? 2 : 1, `${text}\n`);
  app.exit(code);
}

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

const busy = (s) => s === 'work' || s === 'sitDown';
const working = () => busy(pet.state) || busy(pet.next);

// Claude Code hook events -> pet states.
function onHookEvent({ event, prompt }) {
  lastEventAt = Date.now();
  lastCodeEventAt = lastEventAt;
  applyVisibility(); // a Claude Code session may be what shows Terra
  clearTimeout(loopReactionTimer);
  switch (event) {
    case 'prompt': {
      const reaction = matchReaction(prompt);
      if (reaction) playPetReaction(reaction, { then: 'sitDown' });
      else setPetState('sitDown');
      break;
    }
    case 'tool':
      // Also skip when a prompt reaction is about to sit down.
      if (!working()) setPetState('sitDown');
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

// Claude desktop app (mcp/terra-mcp.js) -> pet. The listener has checked the names
// against pet-commands.js. A reaction while working goes back to work afterwards.
function onPetCommand({ reaction, state }) {
  lastEventAt = Date.now();
  clearTimeout(loopReactionTimer);
  if (reaction) {
    const back = working() ? 'sitDown' : 'idle';
    const { anim, loop } = EMOTES[reaction];
    if (!loop) return playPetReaction(reaction, { then: back });
    // Looping emotes would go on forever, so end them after a moment.
    playPetReaction(reaction);
    loopReactionTimer = setTimeout(() => {
      if (pet.state === anim) setPetState(back);
    }, LOOP_REACTION_MS);
    return;
  }
  switch (state) {
    case 'working':
      if (!working()) setPetState('sitDown');
      break;
    case 'waiting':
      playPetReaction('ask');
      break;
    case 'done':
      playPetReaction('stars', { then: 'idle' });
      break;
    case 'idle':
      backToIdle();
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
  const { pet: box } = geometry(scale);
  const cursor = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  const cx = cursor.x - x;
  const cy = cursor.y - y;
  return cx >= box.x && cx < box.x + box.width && cy >= box.y && cy < box.y + box.height;
}

// ---- Showing and hiding the pet ("Show Terra" in the menu) ----
// The window hides, but Terra keeps running: the listener still takes hook events and
// MCP calls, the renderer still follows them, and the tray icon stays in the menu bar.

const prefsFile = () => path.join(app.getPath('userData'), 'preferences.json');

function savePrefs() {
  try {
    visibility.savePrefs(prefsFile(), prefs);
  } catch (err) {
    console.error('Terra could not save its preferences:', err.message);
  }
}

const wantShown = () => visibility.shouldShow({ mode: prefs.showWhen, claudeRunning: claudeRunning === true, lastCodeEventAt, now: Date.now() });

// greet: Claude desktop has just opened, so say hi if that is what brings Terra out.
function applyVisibility({ greet = false } = {}) {
  if (!win || win.isDestroyed()) return;
  if (wantShown()) {
    if (hidePending) { // it never got as far as hiding
      clearTimeout(hideTimer);
      hidePending = false;
      sendToPet('pet:visibility', { visible: true });
    } else if (!petShown) {
      petShown = true;
      win.showInactive();
      sendToPet('pet:visibility', { visible: true, greet });
      console.log(`Terra: shown${greet ? ' (Claude desktop opened)' : ''}`);
    }
  } else if (petShown && !hidePending) {
    // Let the current animation finish; the renderer says when. Hide anyway after a while.
    hidePending = true;
    sendToPet('pet:visibility', { visible: false });
    hideTimer = setTimeout(hideNow, 6000);
  }
}

function hideNow() {
  clearTimeout(hideTimer);
  if (!hidePending) return;
  hidePending = false;
  petShown = false;
  setMouseOnPet(false);
  win.hide();
  console.log('Terra: hidden');
}

async function checkClaude() {
  if (polling) return;
  polling = true;
  try {
    const running = await claude.isRunning();
    if (running === null) return applyVisibility(); // couldn't tell; keep what we had
    const opened = running && claudeRunning === false;
    claudeRunning = running;
    applyVisibility({ greet: opened });
  } finally {
    polling = false;
  }
}

function setShowWhen(mode) {
  prefs.showWhen = mode;
  savePrefs();
  applyVisibility();
  updateTrayMenu();
}

// The packaged app starts at login by default, so it is there (hidden) when Claude opens.
// Only once: after you turn it off in the menu it stays off.
function applyLoginItemDefault() {
  if (!app.isPackaged || prefs.loginItemDefaultDone) return;
  app.setLoginItemSettings({ openAtLogin: true });
  prefs.loginItemDefaultDone = true;
  savePrefs();
}

// ---- Remembering position and size (in the app's user data folder) ----

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!win || win.isDestroyed()) return;
  try {
    windowState.save(stateFile(), { bounds: win.getBounds(), scale, scaleChosen });
  } catch (err) {
    console.error('Terra could not save its position:', err.message);
  }
}

// Moves come in bursts (dragging, walking), so save a moment after the last one.
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 1000);
}

const sizeLabel = (s) => (s === 2.25 ? 'Match small (2.25x)' : `${s}x`);

// A size picked from the menu. Resizes around the pet's feet, so it stays standing on
// the same spot, and remembers the choice (even when it is already the current size).
function setScale(next) {
  if (!win || !SCALES.includes(next)) return;
  scaleChosen = true;
  if (next !== scale) {
    const target = windowState.boundsAt(windowState.feetOf(win.getBounds()), next);
    scale = next;
    win.setBounds(target);
    sendToPet('pet:set-scale', scale);
    const now = win.getBounds();
    if (now.width !== target.width || now.height !== target.height) {
      console.error(`Terra: asked for ${target.width}x${target.height} at ${next}x but the window is ${now.width}x${now.height}`);
    }
  }
  saveState();
  updateTrayMenu();
  const b = win.getBounds();
  console.log(`Terra: size ${sizeLabel(scale)}, window ${b.width}x${b.height} at ${b.x},${b.y}`);
}

function createWindow() {
  const start = windowState.startBounds(
    windowState.load(stateFile()),
    screen.getAllDisplays().map((d) => d.workArea),
    screen.getPrimaryDisplay().workArea,
  );
  scale = start.scale;
  scaleChosen = start.scaleChosen;
  console.log(`Terra: starting at ${sizeLabel(scale)} (${scaleChosen ? 'the size you picked' : 'default size'})`);

  win = new BrowserWindow({
    ...start.bounds,
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

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { scale: String(scale) } });
  win.once('ready-to-show', () => {
    if (!wantShown()) return; // stays hidden until Claude opens (or whatever Show Terra says)
    petShown = true;
    win.showInactive();
  });
  win.webContents.on('did-finish-load', () => {
    sendToPet('pet:set-patrol', patrolEnabled);
    if (!wantShown()) sendToPet('pet:visibility', { visible: false, now: true });
  });
  win.on('move', saveSoon);
}

// ---- Tray ----

function createTray() {
  // A template image (black + alpha) that macOS tints for light and dark menu bars;
  // trayTemplate@2x.png next to it is picked up for Retina screens.
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Terra');
  updateTrayMenu();
}

const HOOKS_LABEL = {
  installed: 'Hooks: installed',
  'not installed': 'Hooks: not installed',
  'needs update': 'Hooks: installed, needs update (install again)',
  unreadable: "Hooks: can't read ~/.claude/settings.json",
};

// Reads ~/.claude/settings.json (never changes it) and updates the tray when the answer changes.
function refreshHooksStatus() {
  const next = hooks.status();
  if (next === hooksStatus) return;
  hooksStatus = next;
  if (tray) updateTrayMenu();
}

const MCP_LABEL = {
  installed: 'Claude desktop: installed',
  'not installed': 'Claude desktop: not installed',
  'needs update': 'Claude desktop: installed for another copy of Terra (install again)',
  unreadable: "Claude desktop: can't read its config file",
};

// Same for the Claude desktop app's config.
function refreshMcpStatus() {
  const next = mcp.status();
  if (next === mcpStatus) return;
  mcpStatus = next;
  if (tray) updateTrayMenu();
}

const MCP_DONE = { install: 'Terra was added to Claude desktop', uninstall: 'Terra was removed from Claude desktop' };

// Runs the MCP installer from the tray and shows what it printed.
function changeMcp(action) {
  const { code, text } = mcp[action]();
  refreshMcpStatus();
  const changed = /^(Added|Removed):$/m.test(text);
  const message = code ? "Terra couldn't change the Claude desktop config" : changed ? MCP_DONE[action] : 'Nothing to change';
  app.focus({ steal: true }); // Terra is never the active app; bring the dialog to the front
  dialog.showMessageBox({ type: code ? 'warning' : 'info', message, detail: text, buttons: ['OK'] });
}

function updateTrayMenu() {
  let status = 'Starting listener…';
  if (listener) status = `Listening on ${HOST}:${listener.port}`;
  else if (listenerError) status = `Listener off: ${listenerError}`;

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    { label: HOOKS_LABEL[hooksStatus], enabled: false },
    { label: MCP_LABEL[mcpStatus], enabled: false },
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
    { type: 'separator' },
    {
      label: 'Size',
      submenu: SCALES.map((s) => ({ label: sizeLabel(s), type: 'radio', checked: s === scale, click: () => setScale(s) })),
    },
    {
      label: 'Show Terra',
      submenu: visibility.MODES.map((m) => ({ label: m.label, type: 'radio', checked: prefs.showWhen === m.id, click: () => setShowWhen(m.id) })),
    },
    {
      label: 'Patrol',
      type: 'checkbox',
      checked: patrolEnabled,
      click: (item) => {
        patrolEnabled = item.checked;
        sendToPet('pet:set-patrol', patrolEnabled);
      },
    },
    // A login item has to be an app; with `npm start` it would be Electron itself.
    {
      label: app.isPackaged ? 'Start at login' : 'Start at login (packaged app only)',
      type: 'checkbox',
      enabled: app.isPackaged,
      checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Install in Claude desktop', enabled: mcpStatus !== 'installed', click: () => changeMcp('install') },
    { label: 'Uninstall from Claude desktop', enabled: mcpStatus === 'installed' || mcpStatus === 'needs update', click: () => changeMcp('uninstall') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

// ---- Start ----

function startApp() {
  ipcMain.on('pet:ready-to-hide', (event) => {
    if (win && event.sender === win.webContents) hideNow();
  });

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
    const g = geometry(scale);
    const [x, y] = win.getPosition();
    const { workArea } = screen.getDisplayMatching(win.getBounds());
    const minX = workArea.x + MARGIN - g.pet.x;
    const maxX = workArea.x + workArea.width - MARGIN - g.pet.width - g.pet.x;
    let toX = x;
    for (let tries = 0; tries < 10 && Math.abs(toX - x) < 24 * scale; tries++) {
      toX = Math.round(minX + Math.random() * (maxX - minX));
    }
    const toY = workArea.y + workArea.height - MARGIN - g.height;
    return { from: { x, y }, to: { x: toX, y: toY } };
  });

  app.whenReady().then(async () => {
    // Hides the app from the Dock and the Cmd+Tab switcher.
    if (app.dock) app.dock.hide();
    try {
      hooks.refreshHookScript(); // keep an installed hook script in step with this version
    } catch (err) {
      console.error('Terra could not update its hook script:', err.message);
    }
    hooksStatus = hooks.status();
    mcpStatus = mcp.status();
    prefs = visibility.loadPrefs(prefsFile());
    applyLoginItemDefault();
    claudeRunning = await claude.isRunning(); // before the window, so it starts shown or hidden
    createWindow();
    createTray();
    setInterval(checkStuck, STUCK_CHECK_EVERY);
    setInterval(checkClaude, claude.POLL_MS); // also notices a Claude Code session running out
    for (const file of [hooks.defaultSettingsPath(), hooks.hookCopyPath()]) fs.watchFile(file, { interval: 2000 }, refreshHooksStatus);
    fs.watchFile(mcp.defaultConfigPath(), { interval: 2000 }, refreshMcpStatus);
    try {
      listener = await startListener(onHookEvent, onPetCommand);
    } catch (err) {
      listenerError = err.message;
      console.error('Terra listener not started:', err.message);
    }
    updateTrayMenu();
  });

  // Ctrl+C in the terminal running `npm start`, or a kill, should quit the normal way
  // too, so the port file is removed and hooks don't keep aiming at a closed port.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => app.quit());

  app.on('before-quit', saveState); // windows are already gone by will-quit
  app.on('will-quit', () => {
    if (!listener) return;
    listener.server.close();
    removePortFile(listener.port);
  });

  // Keep running with no windows; Quit lives in the tray menu.
  app.on('window-all-closed', () => {});
}
