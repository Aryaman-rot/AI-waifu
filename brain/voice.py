import os
import re
import sys
import threading
import time
import wave
from io import BytesIO

import numpy as np
import sounddevice as sd
from fish_audio_sdk import Session, TTSRequest

FISH_REFERENCE_ID = "5da7f24e9e274f91b2b677669c818ce9"
FISH_MODEL = "s2.1-pro-free"
FISH_BASE_URL = "https://api.fish.audio"
AUDIO_FORMAT = "wav"

STAGE_DIRECTION = re.compile(r"\*.*?\*", re.DOTALL)
LIST_BULLET = re.compile(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", re.MULTILINE)
MARKDOWN_NOISE = re.compile(r"(\*\*|__|`+|^#{1,6}\s+)")
EXCESS_BLANK_LINES = re.compile(r"\n{3,}")


class VoiceError(RuntimeError):
    pass


def clean_for_speech(text):
    cleaned = STAGE_DIRECTION.sub(" ", text)
    cleaned = MARKDOWN_NOISE.sub("", cleaned)
    cleaned = LIST_BULLET.sub("", cleaned)
    cleaned = EXCESS_BLANK_LINES.sub("\n\n", cleaned)
    return " ".join(cleaned.split())


def _default_output_name():
    try:
        return sd.query_devices(kind="output")["name"]
    except Exception:
        return "unknown"


def wav_duration(audio):
    """
    Duration in seconds of a WAV blob.

    Deliberately measured from the bytes actually present, not from
    `getnframes()`. Fish Audio streams its response, so the RIFF header is
    written before the real length is known and its frame count reads as the
    0x7FFFFFFF placeholder. Trusting the header gives a duration of hours.
    """
    try:
        with wave.open(BytesIO(audio), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())
    except Exception:
        return 0.0
    divisor = max(1, rate * channels * width)
    return len(frames) / divisor


def synthesize(text, api_key):
    request = TTSRequest(
        text=text,
        format=AUDIO_FORMAT,
        reference_id=FISH_REFERENCE_ID,
        normalize=True,
    )
    try:
        with Session(apikey=api_key, base_url=FISH_BASE_URL) as session:
            audio = b"".join(session.tts(request, backend=FISH_MODEL))
    except Exception as error:
        raise VoiceError(f"{FISH_MODEL} synthesis failed: {error}") from error

    if not audio:
        raise VoiceError(f"{FISH_MODEL} returned no audio")
    return audio


class Player:
    def __init__(self):
        self.lock = threading.Lock()
        self.stream = None
        self.generation = 0

    def play(self, audio):
        with wave.open(BytesIO(audio), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())

        if width != 2:
            raise VoiceError(f"expected 16-bit PCM wav, got {width * 8}-bit")

        samples = np.frombuffer(frames, dtype=np.int16)
        duration = len(samples) / (rate * channels)

        with self.lock:
            self.generation += 1
            generation = self.generation
            previous = self.stream
            self.stream = None
        _abort(previous)

        thread = threading.Thread(
            target=self._run,
            args=(rate, channels, samples, generation),
            daemon=True,
        )
        thread.start()
        return duration, rate, channels

    def _run(self, rate, channels, samples, generation):
        try:
            stream = sd.OutputStream(samplerate=rate, channels=channels, dtype="int16")
        except Exception as error:
            print(f"playback failed: {error}", file=sys.stderr)
            return

        with self.lock:
            if generation != self.generation:
                stale = True
            else:
                stale = False
                self.stream = stream

        if stale:
            _close(stream)
            return

        try:
            stream.start()
            stream.write(samples)
            while stream.active:
                time.sleep(0.02)
        except Exception:
            pass
        finally:
            with self.lock:
                if self.stream is stream:
                    self.stream = None
            _close(stream)

    def stop(self):
        with self.lock:
            self.generation += 1
            stream = self.stream
            self.stream = None
        _abort(stream)


def _abort(stream):
    if stream is None:
        return
    try:
        stream.abort()
    except Exception:
        pass


def _close(stream):
    for method in (stream.stop, stream.close):
        try:
            method()
        except Exception:
            pass


def prepare(text):
    spoken = clean_for_speech(text)
    if not spoken:
        return None, None

    api_key = os.environ.get("FISH_AUDIO_API_KEY")
    if not api_key:
        raise VoiceError("FISH_AUDIO_API_KEY is not set, staying text-only")

    started = time.perf_counter()
    audio = synthesize(spoken, api_key)
    return audio, {
        "model": FISH_MODEL,
        "reference_id": FISH_REFERENCE_ID,
        "characters": len(spoken),
        "audio_bytes": len(audio),
        "synth_seconds": time.perf_counter() - started,
    }
