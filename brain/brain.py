import base64
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from queue import Queue

import mss
import mss.tools

from bridge import Bridge
from persona import COMPANION_NAME, SYSTEM_PROMPT
from voice import Player, VoiceError, prepare, wav_duration
from voice_input import VoiceListener, list_input_devices

SPINNER_INTERVAL = 0.3
input_lock = threading.Lock()

GO_BASE_URL = "https://opencode.ai/zen/go/v1"
USER_AGENT = "ai-waifu-brain/1.0"
DEFAULT_SESSION_ID = "ai-waifu-brain"

SCREEN_PROMPT = (
    "Describe what is currently on this screen in one or two sentences. "
    "Mention the main app or window and any visible text, code, or dialog."
)

CANDIDATES = [
    {"provider": "opencode-go", "model": "minimax-m3", "style": "anthropic"},
    {"provider": "opencode-go", "model": "longcat-2.5-preview-free", "style": "openai"},
    {"provider": "opencode-go", "model": "space-bunny-free", "style": "openai"},
]


def data_dirs():
    dirs = []
    if os.environ.get("OPENCODE_DATA_DIR"):
        dirs.append(Path(os.environ["OPENCODE_DATA_DIR"]))
    if os.environ.get("XDG_DATA_HOME"):
        dirs.append(Path(os.environ["XDG_DATA_HOME"]) / "opencode")
    dirs.append(Path.home() / ".local" / "share" / "opencode")
    if os.name == "nt":
        if os.environ.get("LOCALAPPDATA"):
            dirs.append(Path(os.environ["LOCALAPPDATA"]) / "opencode")
        if os.environ.get("APPDATA"):
            dirs.append(Path(os.environ["APPDATA"]) / "opencode")
    return dirs


def read_provider_key(provider):
    env_name = provider.upper().replace("-", "_") + "_API_KEY"
    for name in (env_name, "OPENCODE_API_KEY"):
        if os.environ.get(name):
            return os.environ[name]
    for directory in data_dirs():
        auth_path = directory / "auth.json"
        if not auth_path.is_file():
            continue
        try:
            auth = json.loads(auth_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        entry = auth.get(provider)
        if isinstance(entry, dict) and entry.get("type") == "api" and entry.get("key"):
            return entry["key"]
    return None


def capture_screen():
    with mss.MSS() as sct:
        monitor = sct.monitors[1]
        shot = sct.grab(monitor)
        return mss.tools.to_png(shot.rgb, shot.size), (monitor["width"], monitor["height"])


def image_block(style, png):
    encoded = base64.b64encode(png).decode("ascii")
    if style == "anthropic":
        return {
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": encoded},
        }
    return {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{encoded}"}}


def attach_image(messages, style, png):
    if png is None:
        return messages
    prepared = [dict(message) for message in messages]
    last = prepared[-1]
    last["content"] = [
        image_block(style, png),
        {"type": "text", "text": last["content"]},
    ]
    return prepared


def build_payload(candidate, messages, png=None):
    if candidate["style"] == "anthropic":
        return {
            "model": candidate["model"],
            "max_tokens": 1024,
            "system": SYSTEM_PROMPT,
            "messages": attach_image(messages, "anthropic", png),
        }
    return {
        "model": candidate["model"],
        "max_tokens": 1024,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            *attach_image(messages, "openai", png),
        ],
    }


def extract_text(data, style):
    if style == "anthropic":
        return "\n".join(
            block.get("text", "")
            for block in data.get("content", [])
            if isinstance(block, dict) and block.get("text")
        ).strip()
    choices = data.get("choices") or []
    if not choices:
        return ""
    content = (choices[0].get("message") or {}).get("content")
    if isinstance(content, list):
        return "\n".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("text")
        ).strip()
    return str(content or "").strip()


def request_reply(candidate, messages, png=None):
    key = read_provider_key(candidate["provider"])
    if not key:
        raise RuntimeError(f'no stored API key for provider "{candidate["provider"]}"')

    endpoint = "messages" if candidate["style"] == "anthropic" else "chat/completions"
    body = json.dumps(build_payload(candidate, messages, png)).encode("utf-8")
    request = urllib.request.Request(
        f"{GO_BASE_URL}/{endpoint}",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "x-opencode-session": os.environ.get("OPENCODE_SESSION_ID", DEFAULT_SESSION_ID),
            "user-agent": USER_AGENT,
            "content-type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"HTTP {error.code} {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"network error: {error.reason}") from error

    text = extract_text(data, candidate["style"])
    if not text:
        raise RuntimeError("model returned no text")
    return text


def complete(messages, png=None):
    failures = []
    for candidate in CANDIDATES:
        try:
            return candidate["model"], request_reply(candidate, messages, png)
        except RuntimeError as error:
            failures.append(f'{candidate["provider"]}/{candidate["model"]}: {error}')
    raise RuntimeError("all routes failed:\n  " + "\n  ".join(failures))


def describe_screen():
    png, size = capture_screen()
    model, description = complete([{"role": "user", "content": SCREEN_PROMPT}], png)
    return model, description, (size[0], size[1], len(png))


class Spinner:
    def __init__(self, stream=None, interval=SPINNER_INTERVAL):
        self.stream = stream or sys.stderr
        self.interval = interval
        self.width = 0
        self.stop_event = None
        self.thread = None

    def _draw(self, label, dots):
        text = label + "." * dots
        self.width = max(self.width, len(text))
        self.stream.write("\r" + text.ljust(self.width))
        self.stream.flush()

    def _run(self, label):
        dots = 0
        while True:
            dots = dots % 3 + 1
            self._draw(label, dots)
            if self.stop_event.wait(self.interval):
                return

    def start(self, label):
        self.stop()
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, args=(label,), daemon=True)
        self.thread.start()

    def stop(self):
        if self.thread is None:
            return
        self.stop_event.set()
        self.thread.join()
        self.thread = None
        self.stop_event = None
        if self.width:
            self.stream.write("\r" + " " * self.width + "\r")
            self.stream.flush()
            self.width = 0


class Inputs:
    """
    Merges typed lines and push-to-talk transcripts onto one queue.

    The REPL used to block on input(), which a background hotkey thread cannot
    interrupt. Both producers now push onto a single queue that the main loop
    drains, so a spoken turn and a typed turn arrive at identical code and are
    indistinguishable from there down.
    """

    def __init__(self):
        self.queue = Queue()

    def start_stdin(self):
        threading.Thread(target=self._stdin_loop, daemon=True).start()

    def _stdin_loop(self):
        while True:
            try:
                line = sys.stdin.readline()
            except Exception:
                break
            if line == "":
                self.queue.put(("exit", None))
                return
            text = line.strip()
            if text:
                self.queue.put(("typed", text))

    def submit_voice(self, text):
        self.queue.put(("voice", text))

    def get(self):
        return self.queue.get()


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    session_id = os.environ.get("OPENCODE_SESSION_ID", DEFAULT_SESSION_ID)
    audio_enabled = not os.environ.get("BRAIN_MUTE")
    voice_state = "on" if audio_enabled else "off"

    messages = []
    spinner = Spinner()
    player = Player()
    bridge = Bridge()
    inputs = Inputs()

    def wipe_line():
        with input_lock:
            sys.stdout.write("\r" + " " * 78 + "\r")
            sys.stdout.flush()

    def announce_speech():
        # No key is involved any more, so there is no console echo to suppress -
        # the line is simply cleared and marked while the mic is capturing.
        wipe_line()
        with input_lock:
            sys.stdout.write("[hearing you...] ")
            sys.stdout.flush()

    def deliver_voice(text):
        wipe_line()
        if text:
            with input_lock:
                print(f"you (voice) > {text}")
                sys.stdout.flush()
        else:
            with input_lock:
                print("[heard nothing - check BRAIN_MIC with !mic]")
                sys.stdout.flush()
            return
        inputs.submit_voice(text)

    mic = VoiceListener(on_speech_start=announce_speech, on_text=deliver_voice)
    mic_problem = mic.start()
    if mic_problem:
        print(f"voice input disabled: {mic_problem}", file=sys.stderr)
    inputs.start_stdin()

    mic_state = "off" if mic_problem else f"always on ({mic.detector.name} vad)"
    if not mic_problem and mic.device_label == "default":
        mic_state += " on the SYSTEM DEFAULT mic - run !mic if she can't hear you"
    print(
        f"brain ready | go session: {session_id} | voice: {voice_state} | "
        f"mic: {mic_state} | "
        "'!screen' to see, '!mute' to toggle audio, 'exit' to quit"
    )

    while True:
        with input_lock:
            sys.stdout.write("\nyou > ")
            sys.stdout.flush()

        kind, line = inputs.get()
        mic.set_busy(False)

        if kind == "exit":
            player.stop()
            print()
            break

        typed = kind == "typed"

        if typed and line.lower() in ("exit", "quit"):
            player.stop()
            break

        if not line:
            continue

        player.stop()
        if bridge.sent:
            bridge.clear()
            # Phase 7's interrupt used to be able to cut her off locally. Playback
            # now lives in the face, so the stop has to be requested over the
            # bridge or she would keep talking over him.
            bridge.audio_stop()

        if typed and line == "!mute":
            audio_enabled = not audio_enabled
            print(f"audio {'on' if audio_enabled else 'off'} (text always shown)")
            continue

        if typed and (line == "!mic" or line.startswith("!mic ")):
            print("input devices (loudest first, live levels - speak while this runs):")
            for index, name, rate, level, hostapi in list_input_devices():
                shown = "silent" if level is None else f"rms {level:.5f}"
                print(f"  {index:>3}  {name}  @{rate}  [{hostapi}]  {shown}")
            print("select with BRAIN_MIC=<index> before starting.")
            print("note: indices shift between runs if a Bluetooth device connects or drops;")
            print("      for those, BRAIN_MIC=<substring of the name> is steadier.")
            continue

        if typed and (line == "!screen" or line.startswith("!screen ")):
            question = line[len("!screen") :].strip()
            spinner.start("thinking")
            try:
                vision_model, description, capture = describe_screen()
            except RuntimeError as error:
                spinner.stop()
                print(f"error: {error}", file=sys.stderr)
                continue
            spinner.stop()
            width, height, png_bytes = capture
            print(
                f"captured {width}x{height} ({png_bytes} bytes png) in memory",
                file=sys.stderr,
            )
            print(f"eyes [{vision_model}] > {description}", file=sys.stderr)
            turn = f"[what Jason can see right now] {description}"
            if question:
                turn += f"\n\nJason asks: {question}"
        else:
            turn = line

        mic.set_busy(True)
        messages.append({"role": "user", "content": turn})

        spinner.start("thinking")
        try:
            model, reply = complete(messages)
        except RuntimeError as error:
            messages.pop()
            spinner.stop()
            mic.set_busy(False)
            print(f"error: {error}", file=sys.stderr)
            continue

        audio = None
        voice_meta = None
        voice_error = None
        if audio_enabled:
            spinner.start("")
            try:
                audio, voice_meta = prepare(reply)
            except VoiceError as error:
                voice_error = error

        spinner.stop()
        mic.set_busy(False)
        if voice_error:
            print(f"voice unavailable, text only: {voice_error}", file=sys.stderr)

        messages.append({"role": "assistant", "content": reply})
        print(f"\n{COMPANION_NAME.lower()} [{model}] > {reply}")

        # Subtitle first, then audio, so the face has the text on screen before
        # the voice that goes with it starts.
        if bridge.speech(reply):
            print(
                f"face: subtitle sent ({len(reply)} chars) -> {bridge.url}",
                file=sys.stderr,
            )
        elif bridge.notice:
            print(bridge.notice, file=sys.stderr)

        if audio is not None:
            # Hand the raw WAV to the face, which owns playback so it can analyse
            # amplitude for lip-sync. Only if the face actually took it - if it
            # declined or was absent, play locally exactly as before. Playing
            # here as well would produce two overlapping copies of her voice.
            handed_off = audio_enabled and bridge.audio(audio, "wav")
            played_for = None
            if handed_off:
                print(
                    f"face: audio sent ({voice_meta['audio_bytes']} bytes) "
                    f"| {voice_meta['synth_seconds']:.2f}s synth, "
                    f"{voice_meta['characters']} chars",
                    file=sys.stderr,
                )
                played_for = wav_duration(audio)
            else:
                try:
                    duration, rate, channels = player.play(audio)
                except VoiceError as error:
                    print(f"playback failed, text only: {error}", file=sys.stderr)
                else:
                    played_for = duration
                    print(
                        f"voice [local {voice_meta['model']}] "
                        f"{voice_meta['synth_seconds']:.2f}s synth, "
                        f"{duration:.2f}s audio, {voice_meta['characters']} chars, "
                        f"{voice_meta['audio_bytes']} bytes {rate}Hz {channels}ch",
                        file=sys.stderr,
                    )

            # Block the microphone for as long as she will be talking, plus a
            # moment for speaker bleed. Without this the mic hears her own voice
            # and she answers herself. When the face owns playback there is no
            # end-of-playback event to wait for, so the gate is time-based.
            mic.note_speaking(played_for)

    print("bye~")


if __name__ == "__main__":
    main()
