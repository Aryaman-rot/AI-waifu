# AI Waifu

A personal AI desktop companion. She talks, she has a personality, she has a
voice, she can see your screen, and she has a face.

Two independent processes:

- **`brain/`** — Python. Conversation, personality, screen capture, local speech
  recognition, and voice synthesis.
- **`face/`** — Electron + Three.js + `@pixiv/three-vrm`. A transparent,
  always-on-top, draggable VRM avatar with subtitles and lip-sync.

They talk to each other over a local WebSocket on `127.0.0.1:8765`. Neither
needs the other to run: if the face is closed, the brain still talks, and still
speaks, using its own audio output.

---

## Features

| | |
|---|---|
| **Conversation** | Text REPL with full multi-turn memory for the session. |
| **Personality** | A written character — dry, insecure underneath, loyal, and never a generic assistant. |
| **Grounding** | She only claims capabilities she actually has, and admits when she does not know something. |
| **Voice out** | Speech synthesis through Fish Audio, played by the face so the mouth can move with it. |
| **Lip-sync** | Amplitude-driven mouth movement from the live audio signal. |
| **Voice in** | Always-on voice activity detection. Speak, and she answers. No key to hold. |
| **Screen awareness** | An on-demand `!screen` capture of your primary monitor, described by a vision model and fed to her as context. Captures are held in memory and never written to disk. |
| **Avatar** | A transparent, frameless, always-on-top VRM window you can drag anywhere. |

---

## Architecture

```
  microphone
      |  (always-on, VAD-segmented)
      v
  brain/  ──── speech + base64 WAV ────┐  ws://127.0.0.1:8765
      |                                v
      |  OpenCode Go (text)         face/  ── plays audio, drives 'aa'
      |  Fish Audio   (voice)             ── shows the subtitle
      |  mss          (screen)            ── idles, blinks, sways
      v
  terminal text
```

The **face** owns audio playback whenever it is running. That is not a
preference — lip-sync needs to measure the signal, which means owning it. The
brain sends raw base64 WAV over the bridge and only falls back to its own
`sounddevice` output if the face did not take the audio. Exactly one of the two
plays it, never both.

---

## Setup

### Prerequisites

- Python 3.11+ (developed on 3.14)
- Node.js 18+ and npm
- A microphone and speakers/headphones

### 1. Brain

```bash
cd brain
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 2. Face

```bash
cd face
npm install
```

### 3. Assets — you supply these

**No model or animation files are in this repository.** Both are excluded by
`.gitignore` because their licences do not permit redistribution, and both must
be placed by hand:

| File | Where it goes | Where to get one |
| --- | --- | --- |
| `model.vrm` | `face/assets/model.vrm` | [VRoid Hub](https://vroidhub.com) or [Booth](https://booth.pm) |
| `*.fbx` (one or more) | `face/assets/idle/*.fbx` | [Mixamo](https://www.mixamo.com) |

For the model, pick a VRM **1.0** file if you can — the retargeting path in
`face/src/idle.ts` carries a compatibility branch for VRM 0.0, but a 1.0 model
avoids the axis-negation step entirely.

For idle animations, download from Mixamo with **"Without Skin"** selected at
**30 fps**. Drop several in: the app loads every `.fbx` in the folder and
crossfades between them, and a single clip on a loop reads as a loop no matter
how good it is. Filenames are irrelevant.

> This project was built and tested against **止丸式初音ミクNT** by **止丸**
> ([twitter:@tomaru_o](https://twitter.com/tomaru_o)), obtained from Booth. It is
> used here for personal, non-commercial purposes. The model's embedded metadata
> declares `Redistribution_Prohibited` under the
> [PIA-PRO license](https://piapro.jp/license/pcl), with commercial, sexual and
> violent use all disallowed. The file is therefore **not** distributed here.
> Credit to the original creator; obtain your own model under its own terms.
>
> Mixamo animations are covered by Adobe's terms, which permit use of the
> animations in your own work but not redistribution of the source files. Same
> reasoning, same exclusion.

### 4. Environment variables

| Variable | Required? | Purpose |
| --- | --- | --- |
| `FISH_AUDIO_API_KEY` | **yes, for voice** | Her speech synthesis. Without it she is text-only. |
| `BRAIN_MIC` | recommended | Input device index, e.g. `2`. Omit to use the system default. |
| `BRAIN_MUTE` | no | Set to anything to start with her voice off. |
| `WHISPER_MODEL` | no | `tiny` / `base` / `small`. Default `base`. |
| `WHISPER_DEVICE` | no | `cpu` or `cuda`. Defaults to probing `cpu` first. |
| `WHISPER_LANGUAGE` | no | Force a language, e.g. `en`. Unset means auto-detect. |
| `FACE_BRIDGE_URL` | no | Brain side. Default `ws://127.0.0.1:8765`. |
| `FACE_BRIDGE_PORT` / `FACE_BRIDGE_HOST` | no | Face side. Defaults `8765` and `127.0.0.1`. |

The model API key is **not** required — it is read from OpenCode's own
`auth.json`, so if OpenCode is already signed in there is nothing to configure.

---

## Quick start

Once setup is done, one click is enough. There is a **Miku** shortcut on your
Desktop.

It starts the face in the background, waits for its WebSocket bridge to actually
accept connections, picks your microphone by name, and then opens a window with
her in it. The window stays open on purpose — that is where her replies appear
and where you type to her.

```
Ctrl+Alt+M          (or double-click the Desktop shortcut)
```

To shut everything down:

```powershell
.\stop-miku.bat
```

From a terminal, the launcher is just:

```powershell
.\start-miku.ps1
```

It finds the microphone by name (`Rockerz 425` by default, override with
`.\start-miku.ps1 -MicNeedle 'My Headset'`) rather than by index, because
Bluetooth device indices move around between connections. If the headset is
disconnected it says so instead of silently falling back to a microphone you did
not intend to use.

The two-terminal method below still works and is what you want when something is
misbehaving and you want to read the output.

---

## Running

Start the face first, then the brain, in two terminals:

```bash
cd face && npm start          # build + launch the avatar window
cd brain && .\.venv\Scripts\python.exe brain.py
```

Order does not strictly matter. The brain is the WebSocket *client* and reports
the bridge as unavailable until the face appears.

If you want the microphone pre-selected when launching by hand, set
`BRAIN_MIC` to a device index or to part of a device name:

```bash
$env:BRAIN_MIC = 2              # index, from !mic
$env:BRAIN_MIC = 'Rockerz 425'  # or a name, which survives reconnection
```

### Brain commands

| Command | Effect |
| --- | --- |
| *(just talk)* | The microphone is always listening. Speak and she answers. |
| *(typed text)* | Works identically to speaking. |
| `!screen` | Captures your primary monitor, in memory, and has her react to it. |
| `!screen <question>` | As above, with a question attached. |
| `!mute` | Toggle her voice. Text still shows. |
| `!mic` | List input devices with live levels, so you can find your microphone. |
| `exit` | Quit. |

### Notes

- The avatar window has no title bar and no taskbar button. Click it and press
  **Alt+F4**, or `Stop-Process -Name electron -Force`.
- Drag her anywhere by clicking and holding.
- `npm run capture` in `face/` writes a diagnostic screenshot and quits.

---

## License and personal use

This is a personal, non-commercial project. It is not affiliated with, endorsed
by, or connected to any of the models, voices, or services it uses. You are
responsible for complying with the terms of the assets and services you supply
to it — in particular the VRM model's licence and Mixamo's terms, both of which
restrict redistribution and are the reason neither appears in this repository.
