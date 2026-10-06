const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('terra', {
  moveWindow: (x, y) => ipcRenderer.send('pet:move', x, y),
});
