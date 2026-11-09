'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dbHost', {
  getConfig: () => ipcRenderer.invoke('db:config'),
  open: () => ipcRenderer.invoke('db:open'),
  save: (payload) => ipcRenderer.invoke('db:save', payload),
  log: (entry) => ipcRenderer.invoke('db:log', entry),
})
