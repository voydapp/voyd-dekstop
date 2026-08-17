const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlayAPI', {
  onVoiceState: (callback) => {
    ipcRenderer.on('voice-state', (_event, state) => callback(state))
  },
})
