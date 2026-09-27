const { WebSocketServer } = require("ws")

const DEFAULT_PORT = 8765
const DEFAULT_HOST = "127.0.0.1"

function startBridge({ onSpeech, onAudio, onAudioStop, onClear, onStatus } = {}) {
  const port = Number(process.env.FACE_BRIDGE_PORT || DEFAULT_PORT)
  const host = process.env.FACE_BRIDGE_HOST || DEFAULT_HOST

  const server = new WebSocketServer({ host, port })
  const sockets = new Set()

  server.on("listening", () => onStatus?.(`bridge listening on ws://${host}:${port}`))
  server.on("error", (error) => onStatus?.(`bridge error: ${error.message}`))

  server.on("connection", (socket) => {
    sockets.add(socket)
    onStatus?.("brain connected")

    socket.on("message", (raw) => {
      let message
      try {
        message = JSON.parse(raw.toString())
      } catch {
        onStatus?.("bridge ignored a non-JSON message")
        return
      }

      // Dispatch is guarded deliberately. An exception thrown out of a ws event
      // handler is uncaught in Electron's main process and takes the whole app
      // down - which is exactly what happened when `onAudio` was referenced but
      // never destructured, killing the face on the first audio message instead
      // of degrading. A malformed or unsupported message must never be able to
      // do that.
      try {
        if (message?.type === "speech" && typeof message.text === "string") {
          onSpeech?.(message.text)
        } else if (message?.type === "audio" && typeof message.audio_b64 === "string") {
          onAudio?.(message.audio_b64, message.format)
        } else if (message?.type === "audio_stop") {
          onAudioStop?.()
        } else if (message?.type === "clear") {
          onClear?.()
        } else {
          onStatus?.(`bridge ignored unknown type "${message?.type}"`)
        }
      } catch (error) {
        onStatus?.(`bridge handler failed for "${message?.type}": ${error.message}`)
      }
    })

    socket.on("close", () => {
      sockets.delete(socket)
      if (sockets.size === 0) onStatus?.("brain disconnected")
    })
    socket.on("error", () => sockets.delete(socket))
  })

  return server
}

module.exports = { startBridge, DEFAULT_PORT, DEFAULT_HOST }
