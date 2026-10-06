const path = require('node:path');
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen } = require('electron');

// One sprite cell is 48x52, drawn at 4x.
const WIDTH = 48 * 4;
const HEIGHT = 52 * 4;
const MARGIN = 24;

let win = null;
let tray = null; // kept at module level so it isn't garbage-collected

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: workArea.x + workArea.width - WIDTH - MARGIN,
    y: workArea.y + workArea.height - HEIGHT - MARGIN,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // visibleOnFullScreen also keeps the Dock icon hidden: without it,
  // Electron calls DockShow() here on macOS.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
}

function createTray() {
  const src = nativeImage.createFromPath(path.join(__dirname, 'Bot', 'terra-bot-48x52.png'));
  const icon = nativeImage.createEmpty();
  icon.addRepresentation({ scaleFactor: 1, buffer: src.resize({ height: 18 }).toPNG() });
  icon.addRepresentation({ scaleFactor: 2, buffer: src.resize({ height: 36 }).toPNG() });

  tray = new Tray(icon);
  tray.setToolTip('Terra');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Quit', click: () => app.quit() }]));
}

// The renderer sends the new top-left corner while the pet is dragged.
ipcMain.on('pet:move', (event, x, y) => {
  if (!win || event.sender !== win.webContents) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  win.setPosition(Math.round(x), Math.round(y));
});

app.whenReady().then(() => {
  // Hides the app from the Dock and the Cmd+Tab switcher.
  if (app.dock) app.dock.hide();
  createWindow();
  createTray();
});

// Keep running with no windows; Quit lives in the tray menu.
app.on('window-all-closed', () => {});
