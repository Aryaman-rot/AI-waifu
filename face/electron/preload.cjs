const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("miku", {
  onSpeech: (handler) => ipcRenderer.on("miku:speech", (_event, text) => handler(text)),
  onClear: (handler) => ipcRenderer.on("miku:clear", () => handler()),
  onBridgeStatus: (handler) =>
    ipcRenderer.on("miku:bridge", (_event, status) => handler(status)),
  listIdleClips: () => ipcRenderer.invoke("idle-clips"),
  onAudio: (handler) => ipcRenderer.on("miku:audio", (_event, b64, format) => handler(b64, format)),
  onAudioStop: (handler) => ipcRenderer.on("miku:audioStop", () => handler()),
})
