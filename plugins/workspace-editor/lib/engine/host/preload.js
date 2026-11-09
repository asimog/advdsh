'use strict'

// Page half of the engine sidecar IPC. The visible page is hidden from the user;
// it only exposes the calls the builder host needs.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dbEngine', {
  getConfig: () => ipcRenderer.invoke('dbx:config'),
  open: () => ipcRenderer.invoke('dbx:open'),
  save: (payload) => ipcRenderer.invoke('dbx:save', payload),
  log: (entry) => ipcRenderer.invoke('dbx:log', entry),
})
