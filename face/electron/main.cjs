const { app, BrowserWindow, protocol, net, screen, ipcMain } = require("electron")
const fs = require("node:fs")
const path = require("node:path")
const { pathToFileURL } = require("node:url")

const { startBridge } = require("./bridge.cjs")

const ROOT = path.join(__dirname, "..")
const ASSETS = path.join(ROOT, "assets")
const IDLE_DIR = path.join(ASSETS, "idle")
const INDEX_HTML = path.join(ROOT, "dist", "index.html")

const WINDOW_WIDTH = 420
const WINDOW_HEIGHT = 620

function flagValue(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1 || index + 1 >= process.argv.length) return fallback
  return process.argv[index + 1]
}

const capturePath = flagValue("--capture", null)
const captureDelay = Number(flagValue("--capture-delay", "12000"))

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

function serveAsset(request) {
  const url = new URL(request.url)
  const relative = decodeURIComponent(url.pathname).replace(/^[/\\]+/, "")
  const target = path.resolve(ASSETS, relative)
  if (target !== ASSETS && !target.startsWith(ASSETS + path.sep)) {
    return new Response("forbidden", { status: 403 })
  }
  if (!fs.existsSync(target)) {
    return new Response("not found", { status: 404 })
  }
  return net.fetch(pathToFileURL(target).toString())
}

function listIdleClips() {
  if (!fs.existsSync(IDLE_DIR)) return []
  return fs
    .readdirSync(IDLE_DIR)
    .filter((name) => name.toLowerCase().endsWith(".fbx"))
    .sort()
    .map((name) => `app://assets/idle/${encodeURIComponent(name)}`)
}

/**
 * The renderer cannot enumerate a directory: `app://` resolves single files and
 * nothing exposes a listing. So the main process reads the folder once and hands
 * the renderer a plain list of URLs. Every .fbx in the folder is included -
 * filenames are irrelevant, and there is no naming convention to keep to.
 */
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: workArea.x + workArea.width - WINDOW_WIDTH - 48,
    y: workArea.y + workArea.height - WINDOW_HEIGHT - 48,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  })

  win.setAlwaysOnTop(true, "floating")
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })

  win.webContents.on("console-message", (...args) => {
    const first = args[0]
    const message =
      first && typeof first === "object" && "message" in first
        ? first.message
        : args.slice(1).join(" ")
    console.log("[renderer]", message)
  })

  win.webContents.on("did-fail-load", (_e, code, description) => {
    console.error("[main] renderer failed to load:", code, description)
  })

  win.loadFile(INDEX_HTML)

  if (capturePath) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const image = await win.capturePage()
        fs.writeFileSync(capturePath, image.toPNG())
        console.log("[main] captured", capturePath)
        app.quit()
      }, captureDelay)
    })
  }

  return win
}

app.whenReady().then(() => {
  protocol.handle("app", serveAsset)
  ipcMain.handle("idle-clips", () => listIdleClips())
  const win = createWindow()

  startBridge({
    onSpeech: (text) => {
      console.log(`[bridge] speech received (${text.length} chars): ${text}`)
      win.webContents.send("miku:speech", text)
    },
    onAudio: (audioB64, format) => {
      console.log(`[bridge] audio received (${format}, ${audioB64.length} b64 chars)`)
      win.webContents.send("miku:audio", audioB64, format ?? "wav")
    },
    onAudioStop: () => {
      console.log("[bridge] audio_stop received")
      win.webContents.send("miku:audioStop")
    },
    onClear: () => {
      console.log("[bridge] clear received")
      win.webContents.send("miku:clear")
    },
    onStatus: (status) => {
      console.log("[bridge]", status)
      win.webContents.send("miku:bridge", status)
    },
  })
})

app.on("window-all-closed", () => app.quit())
