// Started by startup.test.js: runs the real main.js with a given user data folder,
// prints where the window opened and at what size, then quits.
// With TERRA_TEST_PICK set to a Size menu label, it also picks that size through the
// tray menu (the way a real click arrives), prints the result, and quits through the
// tray's Quit, the normal way, so the choice is saved as it would be for you.
// TERRA_TEST_CLAUDE=running fakes the Claude desktop app being open (it is never asked
// about for real). Without a preferences file, Show Terra is set to Always first.
// TERRA_TEST_PACKAGED=1 behaves as the packaged app, with login item calls recorded
// instead of made.
const fs = require('node:fs');
const path = require('node:path');
const { app, Menu } = require('electron');

app.setPath('userData', process.env.TERRA_TEST_USERDATA);
const prefsFile = path.join(process.env.TERRA_TEST_USERDATA, 'preferences.json');
if (!fs.existsSync(prefsFile)) fs.writeFileSync(prefsFile, JSON.stringify({ showWhen: 'always' }));
require(path.join(__dirname, '..', '..', 'claude-app.js')).isRunning = async () => process.env.TERRA_TEST_CLAUDE === 'running';
const loginCalls = [];
if (process.env.TERRA_TEST_PACKAGED === '1') {
  Object.defineProperty(app, 'isPackaged', { get: () => true });
  let openAtLogin = false;
  app.setLoginItemSettings = (settings) => { loginCalls.push(settings); openAtLogin = !!settings.openAtLogin; };
  app.getLoginItemSettings = () => ({ openAtLogin });
}
let trayMenu = null;
const realBuild = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = (template) => (trayMenu = realBuild(template));
require(path.join(__dirname, '..', '..', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// What Electron runs when the native menu reports a click on an item.
const nativeClick = (menu, label) => menu._executeCommand({}, menu.items.find((i) => i.label === label).commandId);

let petWindow = null; // the first window; the speech bubble's comes after it
// The Voice menu once say has listed the voices: Speak bubbles, the chosen voice, the speed.
async function voiceMenu() {
  const items = () => trayMenu.items.find((i) => i.label === 'Voice').submenu.items;
  const sub = (label) => items().find((i) => i.label === label).submenu.items;
  for (let n = 0; n < 50 && sub('Choose voice').length < 2; n++) await wait(100);
  const checked = (list) => list.filter((i) => i.checked).map((i) => i.label).join();
  return `Speak bubbles${items()[0].checked ? '*' : ''}, voice ${checked(sub('Choose voice'))}, speed ${checked(sub('Speed'))}`;
}

app.on('browser-window-created', (_e, win) => {
  if (petWindow) return;
  petWindow = win;
  win.webContents.once('did-finish-load', async () => {
    // canvas: its size on screen (CSS pixels, the window's points); backing: its own pixels.
    await wait(300); // past ready-to-show, which decides whether the window is shown
    const look = async () => ({
      bounds: win.getBounds(),
      visible: win.isVisible(),
      loginCalls,
      ...(await win.webContents.executeJavaScript('({ scale, dpr: devicePixelRatio, canvas: [canvas.clientWidth, canvas.clientHeight], backing: [canvas.width, canvas.height] })')),
      checked: trayMenu.items.find((i) => i.label === 'Size').submenu.items.filter((i) => i.checked).map((i) => i.label),
      // The Sound menu as the tray shows it (main.js plays by the same choices).
      soundMenu: trayMenu.items.find((i) => i.label === 'Sound').submenu.items.filter((i) => i.type !== 'separator')
        .map((i) => `${i.label}${i.checked ? '*' : ''}${i.enabled ? '' : ' (off)'}`).join(', '),
      voiceMenu: await voiceMenu(),
    });
    process.stdout.write(`RESULT ${JSON.stringify(await look())}\n`);
    const pick = process.env.TERRA_TEST_PICK;
    if (!pick) return app.exit(0);
    await wait(300);
    nativeClick(trayMenu.items.find((i) => i.label === 'Size').submenu, pick);
    await wait(500);
    process.stdout.write(`PICKED ${JSON.stringify(await look())}\n`);
    nativeClick(trayMenu, 'Quit');
  });
});
setTimeout(() => app.exit(1), 20000);
