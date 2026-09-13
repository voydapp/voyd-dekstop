const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sourcePickerAPI', {
  onSources: (callback) => {
    ipcRenderer.on('source-picker-sources', (_event, sources) => callback(sources))
  },
  select: (sourceId) => ipcRenderer.send('source-picker-select', sourceId),
  cancel: () => ipcRenderer.send('source-picker-cancel'),
})
