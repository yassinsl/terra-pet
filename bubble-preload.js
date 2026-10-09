// The speech bubble window's bridge (bubble-window.js, renderer/bubble.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubble', {
  onDraw: (callback) => ipcRenderer.on('bubble:draw', (_event, state) => callback(state)),
  setMouseOver: (on) => ipcRenderer.send('bubble:mouse-over', on),
  dismiss: () => ipcRenderer.send('bubble:dismiss'),
});
