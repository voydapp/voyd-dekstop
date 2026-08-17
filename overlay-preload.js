const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlayAPI', {
  onVoiceState: (callback) => {
    ipcRenderer.on('voice-state', (_event, state) => callback(state))
  },
  onCameraFrames: (callback) => {
    ipcRenderer.on('camera-frames', (_event, frames) => callback(frames))
  },
})
