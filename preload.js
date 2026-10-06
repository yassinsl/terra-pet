const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('terra', {
  moveWindow: (x, y) => ipcRenderer.send('pet:move', x, y),
  patrolRoute: () => ipcRenderer.invoke('pet:patrol-route'),
  reportState: (state, next) => ipcRenderer.send('pet:state', state, next),
  setMouseOverPet: (on) => ipcRenderer.send('pet:mouse-over-pet', on),
  onSetState: (callback) => ipcRenderer.on('pet:set-state', (_event, name, options) => callback(name, options)),
  onPlayReaction: (callback) => ipcRenderer.on('pet:play-reaction', (_event, name, options) => callback(name, options)),
  onSetPatrol: (callback) => ipcRenderer.on('pet:set-patrol', (_event, on) => callback(on)),
  onSetScale: (callback) => ipcRenderer.on('pet:set-scale', (_event, scale) => callback(scale)),
  onVisibility: (callback) => ipcRenderer.on('pet:visibility', (_event, change) => callback(change)),
  readyToHide: () => ipcRenderer.send('pet:ready-to-hide'),
});
