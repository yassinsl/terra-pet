// Started by startup.test.js: runs the real main.js with a given user data folder,
// prints where the window opened and at what size, then quits.
const path = require('node:path');
const { app } = require('electron');

app.setPath('userData', process.env.TERRA_TEST_USERDATA);
require(path.join(__dirname, '..', '..', 'main.js'));

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const page = await win.webContents.executeJavaScript('({ scale, canvas: [canvas.width, canvas.height] })');
    process.stdout.write(`RESULT ${JSON.stringify({ bounds: win.getBounds(), ...page })}\n`);
    app.exit(0);
  });
});
setTimeout(() => app.exit(1), 20000);
