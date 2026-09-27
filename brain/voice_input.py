import os
import sys
import threading
import time
import wave
from collections import deque
from io import BytesIO
from queue import Empty, Queue

import numpy as np
import sounddevice as sd

WHISPER_RATE = 16000
DEFAULT_MODEL = "base"

FRAME_SAMPLES = 320  # 20ms at 16kHz - the VAD loop's unit
END_SILENCE_MS = 700  # trailing quiet that ends an utterance
MIN_SPEECH_MS = 300  # shorter than this and it was a cough, not speech
MAX_UTTERANCE_MS = 30000  # force a cut so one long ramble cannot stall the loop
PRE_ROLL_FRAMES = 15  # 300ms kept before the trigger, so phrases are not clipped
SILERO_WINDOW = 1536  # 96ms, a multiple of Silero's 512-sample chunk
SPEECH_PROBABILITY_THRESHOLD = 0.5

SPEAKING_TAIL_SECONDS = 0.4  # grace after she stops, for speaker bleed


def list_input_devices(probe_seconds=0.4):
    """
    List input devices with a short level probe, loudest first.

    The host API is included because the same physical headset is normally
    enumerated several times over MME, DirectSound, WASAPI and WDM-KS under one
    name, and those duplicates are exactly what a name-based BRAIN_MIC trips over.
    """
    rows = []
    for index, device in enumerate(sd.query_devices()):
        if device["max_input_channels"] < 1:
            continue
        rate = int(device["default_samplerate"])
        level = None
        try:
            with sd.InputStream(
                device=index, samplerate=rate, channels=1, dtype="int16"
            ) as stream:
                time.sleep(0.05)
                data, _ = stream.read(int(rate * probe_seconds))
            level = float(np.sqrt(((data.astype(np.float32) / 32768.0) ** 2).mean()))
        except Exception:
            pass
        rows.append((index, device["name"], rate, level, device["hostapi"]))
    rows.sort(key=lambda row: (row[3] is None, -(row[3] or 0.0)))
    return rows


def resolve_input_device(raw):
    """
    Turns BRAIN_MIC into a sounddevice device identifier.

    Two deliberately separate branches:

    * A value that parses as an integer is a *device index* and is passed
      straight through. `!mic` prints indices from `sd.query_devices()`, and
      those are exactly what `device=` expects, so there is nothing to look up.
    * Anything else is a name and goes to sounddevice's own substring matching.

    These cannot be one code path. sounddevice treats any non-integer as a
    substring of device names, so the string "2" matched three unrelated
    headsets and raised "Multiple input devices found for '2'". The numeric
    branch must therefore be resolved before sounddevice ever sees it.
    """
    if raw is None:
        return None
    text = raw.strip()
    if not text:
        return None
    if text.lstrip("+-").isdigit():
        return int(text)
    return text


class LinearResampler:
    """Streaming linear resampler from the device rate down to 16kHz.

    Batch resampling cannot drive an always-on detector: each new chunk needs
    resampling before it can be classified, and the two have to overlap or words
    get clipped at chunk edges. Linear is crude for speech but VAD only needs
    rough loudness and zero-crossing information, so the artefacts do not matter.
    """

    def __init__(self, src_rate, dst_rate=WHISPER_RATE):
        self.step = src_rate / float(dst_rate)
        self.tail = np.zeros(0, dtype=np.float32)

    def process(self, samples):
        buffer = np.concatenate([self.tail, samples.astype(np.float32) / 32768.0])
        if buffer.shape[0] < 2:
            self.tail = buffer
            return np.zeros(0, dtype=np.float32)
        count = int((buffer.shape[0] - 1) / self.step)
        if count < 1:
            self.tail = buffer
            return np.zeros(0, dtype=np.float32)
        positions = np.arange(count) * self.step
        lower = np.floor(positions).astype(int)
        frac = (positions - lower).astype(np.float32)
        upper = np.minimum(lower + 1, buffer.shape[0] - 1)
        out = buffer[lower] * (1.0 - frac) + buffer[upper] * frac
        self.tail = buffer[int(count * self.step) :]
        return out


class SpeechDetector:
    """
    Speech/music classifier, webrtcvad if it is importable and Silero otherwise.

    webrtcvad is the preferred detector, but it is a C extension with no wheel
    for Python 3.14 and this machine has no C toolchain to build one, so it
    could not be installed. Silero ships inside faster-whisper with onnxruntime
    already present, so the feature works today with no extra install and no
    code change when webrtcvad becomes available.
    """

    def __init__(self):
        self.name = "energy"
        self._vad = None
        self._silero = None
        self._silero_window = np.zeros(0, dtype=np.float32)

        try:
            from webrtcvad import Vad

            self._vad = Vad(2)
            self.name = "webrtcvad"
            return
        except Exception:
            pass

        try:
            from faster_whisper.vad import get_vad_model

            self._silero = get_vad_model()
            self.name = "silero"
        except Exception:
            self._silero = None

    def is_speech(self, frame):
        """frame: float32 array of FRAME_SAMPLES at 16kHz."""
        if self._vad is not None:
            pcm = np.clip(frame * 32767, -32768, 32767).astype(np.int16).tobytes()
            return self._vad.is_speech(pcm, WHISPER_RATE)

        if self._silero is not None:
            self._silero_window = np.concatenate([self._silero_window, frame])
            if self._silero_window.shape[0] >= SILERO_WINDOW:
                self._silero_window = self._silero_window[-SILERO_WINDOW:]
            if self._silero_window.shape[0] < SILERO_WINDOW:
                return False
            probabilities = self._silero(self._silero_window)
            return bool(float(probabilities[-1]) >= SPEECH_PROBABILITY_THRESHOLD)

        rms = float(np.sqrt(np.mean(frame * frame)))
        return rms >= 0.012


class WhisperEngine:
    """
    Loads faster-whisper once, preferring the GPU and falling back to CPU.

    Constructing a WhisperModel does not prove the backend works: on this machine
    a cuda/float16 model constructs happily and then fails on the first real
    inference with "Library cublas64_12.dll is not found". So each candidate is
    proved with an actual (tiny, silent) transcribe before being accepted, which
    turns a per-utterance failure into a one-time fallback at warm-up.
    """

    def __init__(self, model_size=None, device=None):
        self.model_size = model_size or os.environ.get("WHISPER_MODEL", DEFAULT_MODEL)
        self.preferred = device or os.environ.get("WHISPER_DEVICE")
        self.model = None
        self.device = None
        self.lock = threading.Lock()

    def _candidates(self):
        if self.preferred:
            compute = "float16" if self.preferred == "cuda" else "int8"
            return [(self.preferred, compute)]
        return [("cpu", "int8"), ("cuda", "float16")]

    def load(self):
        from faster_whisper import WhisperModel

        probe = np.zeros(WHISPER_RATE // 2, dtype=np.float32)
        errors = []
        for device, compute in self._candidates():
            try:
                model = WhisperModel(self.model_size, device=device, compute_type=compute)
                model.transcribe(probe, beam_size=1)
                self.model = model
                self.device = f"{device}/{compute}"
                return self.device
            except Exception as error:
                errors.append(f"{device}/{compute}: {str(error)[:120]}")
        raise RuntimeError(
            f"whisper '{self.model_size}' failed on every backend ({'; '.join(errors)})"
        )

    def ensure(self):
        with self.lock:
            if self.model is None:
                return self.load()
            return self.device

    def transcribe(self, audio):
        self.ensure()
        language = os.environ.get("WHISPER_LANGUAGE") or None
        segments, _info = self.model.transcribe(
            audio, language=language, vad_filter=False, beam_size=1
        )
        return "".join(segment.text for segment in segments).strip()


class VoiceListener:
    """
    Always-on voice activity detection. The microphone never stops listening;
    a turn is delimited purely by speech onset and sustained silence.

    Three threads, because each has a genuinely different job and blocking any of
    them loses something real:

    * PortAudio's callback does nothing but copy bytes into a queue. It must never
      block, or the audio device drops frames.
    * The detector thread drains that queue, resamples, classifies and delimits.
      It must never block either, or the next syllable goes unheard.
    * The transcription thread runs Whisper, which takes most of a second. Folding
      it into the detector would mean going deaf for that second - the user would
      keep talking and nothing would be captured.

    Self-listening is prevented by a time gate rather than by filtering. While she
    is speaking, or a turn is being processed, incoming audio is discarded before
    it is even classified, so her own voice can never become an input.
    """

    def __init__(self, model_size=None, on_speech_start=None, on_text=None):
        self.engine = WhisperEngine(model_size)
        self.detector = SpeechDetector()
        self.on_speech_start = on_speech_start or (lambda: None)
        self.on_text = on_text or (lambda text: None)

        self.busy = threading.Event()
        self.busy_until = 0.0
        self.stream = None
        self.rate = WHISPER_RATE
        self.device_label = "default"
        self.available = True
        self.reason = None

        self.raw_queue = Queue()
        self.segment_queue = Queue()
        self.stopping = threading.Event()
        self.threads = []

        self.speech_segments = 0
        self.discarded_short = 0
        self.ignored_self = 0

    def set_busy(self, busy):
        self.busy.set() if busy else self.busy.clear()

    def note_speaking(self, duration):
        """Block VAD while she talks, plus a tail for speaker bleed."""
        if duration > 0:
            self.busy_until = time.monotonic() + duration + SPEAKING_TAIL_SECONDS

    def _callback(self, indata, frames, time_info, status):
        self.raw_queue.put(bytes(indata))

    def start(self):
        try:
            device = resolve_input_device(os.environ.get("BRAIN_MIC"))
            settings = sd.query_devices(device, "input")
            if settings["max_input_channels"] < 1:
                self.available = False
                self.reason = (
                    f"BRAIN_MIC={os.environ.get('BRAIN_MIC')!r} is '{settings['name']}', "
                    "which has no input channels. Device indices shift between runs "
                    "(Bluetooth endpoints come and go) - run !mic again for current ones."
                )
                return self.reason
            self.rate = int(settings["default_samplerate"])
            self.stream = sd.RawInputStream(
                samplerate=self.rate,
                blocksize=0,
                device=device,
                channels=1,
                dtype="int16",
                callback=self._callback,
            )
            self.stream.start()
            self.device_label = (
                "default"
                if device is None
                else f"{device} ({settings['name']} @{self.rate} Hz)"
            )
        except Exception as error:
            self.available = False
            self.reason = f"microphone unavailable ({error})"
            return self.reason

        self.threads = [
            threading.Thread(target=self._detect_loop, daemon=True),
            threading.Thread(target=self._transcribe_loop, daemon=True),
        ]
        for thread in self.threads:
            thread.start()
        threading.Thread(target=self._warm, daemon=True).start()
        return None

    def _warm(self):
        try:
            device = self.engine.ensure()
            print(
                f"[mic] listening always (vad: {self.detector.name}) | "
                f"mic {self.device_label} | whisper {self.engine.model_size} on {device}"
            )
        except Exception as error:
            self.available = False
            self.reason = f"whisper unavailable ({error})"
            print(f"[mic] {self.reason}", file=sys.stderr)

    def _discard(self, resampler, pending, pre_roll, state):
        return (
            np.zeros(0, dtype=np.float32),
            pre_roll.clear() or pre_roll,
            state,
        )

    def _detect_loop(self):
        resampler = LinearResampler(self.rate)
        pending = np.zeros(0, dtype=np.float32)
        pre_roll = deque(maxlen=PRE_ROLL_FRAMES)
        segment = []
        speaking = False
        silent_ms = 0
        started_at = 0.0
        last_speech_at = 0.0

        while not self.stopping.is_set():
            try:
                chunk = self.raw_queue.get(timeout=0.1)
            except Empty:
                chunk = b""

            now = time.monotonic()

            if self.busy.is_set() or now < self.busy_until:
                if speaking or segment:
                    self.ignored_self += 1
                speaking = False
                segment = []
                pre_roll.clear()
                silent_ms = 0
                pending = np.zeros(0, dtype=np.float32)
                resampler.tail = np.zeros(0, dtype=np.float32)
                continue

            pending = np.concatenate(
                [pending, resampler.process(np.frombuffer(chunk, dtype=np.int16))]
            )

            while pending.shape[0] >= FRAME_SAMPLES:
                frame = pending[:FRAME_SAMPLES]
                pending = pending[FRAME_SAMPLES:]
                is_speech = self.detector.is_speech(frame)

                if not speaking:
                    pre_roll.append(frame)
                    if is_speech:
                        speaking = True
                        started_at = now
                        last_speech_at = now
                        silent_ms = 0
                        segment = list(pre_roll)
                        self.on_speech_start()
                    continue

                segment.append(frame)
                if is_speech:
                    silent_ms = 0
                    last_speech_at = now
                else:
                    silent_ms += int(FRAME_SAMPLES / WHISPER_RATE * 1000)
                    if silent_ms >= END_SILENCE_MS:
                        self._finish(segment, started_at, last_speech_at)
                        speaking = False
                        segment = []
                        pre_roll.clear()
                        silent_ms = 0
                        continue

                if len(segment) * (FRAME_SAMPLES / WHISPER_RATE * 1000) >= MAX_UTTERANCE_MS:
                    self._finish(segment, started_at, last_speech_at)
                    speaking = False
                    segment = []
                    pre_roll.clear()
                    silent_ms = 0

    def _finish(self, segment, started_at, last_speech_at):
        if not segment:
            return
        duration_ms = len(segment) * (FRAME_SAMPLES / WHISPER_RATE * 1000)
        if duration_ms < MIN_SPEECH_MS:
            self.discarded_short += 1
            return
        keep = len(segment) - int((END_SILENCE_MS * WHISPER_RATE) / 1000 / FRAME_SAMPLES)
        trimmed = segment[: max(1, keep)]
        self.segment_queue.put(np.concatenate(trimmed).astype(np.float32))

    def _transcribe_loop(self):
        while not self.stopping.is_set():
            try:
                audio = self.segment_queue.get(timeout=0.2)
            except Empty:
                continue
            try:
                text = self.engine.transcribe(audio)
            except Exception as error:
                print(f"[mic] transcription failed: {error}", file=sys.stderr)
                continue
            self.on_text(text)

    def close(self):
        self.stopping.set()
        if self.stream is not None:
            try:
                self.stream.close()
            except Exception:
                pass
            self.stream = None
