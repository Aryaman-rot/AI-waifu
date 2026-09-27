import base64
import json
import os
import time

from websockets.sync.client import connect

DEFAULT_URL = "ws://127.0.0.1:8765"
CONNECT_TIMEOUT = 0.35
SEND_TIMEOUT = 0.35
# Audio is a multi-megabyte base64 payload; a short send timeout would abandon
# a perfectly good transmission halfway and force a needless local fallback.
AUDIO_SEND_TIMEOUT = 8.0
RETRY_COOLDOWN = 20.0


class Bridge:
    """
    Best-effort link to the face app.

    Every send is a short-lived connection: the face may be closed, restarted, or
    not running at all, and a fresh handshake sidesteps stale-socket state
    entirely. A localhost round trip is cheap enough that holding a socket open
    would buy nothing.

    When the face is absent this machine drops packets to unused ports instead of
    refusing them, so a failed connect costs the full timeout rather than
    returning instantly. Retrying that on every turn would tax the REPL for a
    feature that is merely off, so a failure opens a cooldown: sends are skipped
    without touching the network until it expires, and the warning is printed
    once per outage rather than once per turn.
    """

    def __init__(self, url=None):
        self.url = url or os.environ.get("FACE_BRIDGE_URL", DEFAULT_URL)
        self.retry_at = 0.0
        self.warned = False
        self.notice = None
        self.sent = 0
        self.failed = 0

    def speech(self, text):
        return self._try({"type": "speech", "text": text})

    def clear(self):
        return self._try({"type": "clear"})

    def audio_stop(self):
        """Stop audio the face is playing, e.g. when a turn is interrupted."""
        return self._try({"type": "audio_stop"})

    def audio(self, wav_bytes, audio_format="wav"):
        """
        Hand raw audio to the face so it owns playback and can drive lip-sync.

        Returns True only if the face took the audio. On False the caller must
        play locally instead - the face has to be able to decline the audio
        without the voice going silent.
        """
        return self._try(
            {
                "type": "audio",
                "audio_b64": base64.b64encode(wav_bytes).decode("ascii"),
                "format": audio_format,
            },
            timeout=AUDIO_SEND_TIMEOUT,
        )

    def _try(self, payload, timeout=SEND_TIMEOUT):
        now = time.monotonic()
        if now < self.retry_at:
            return False

        try:
            with connect(
                self.url,
                open_timeout=CONNECT_TIMEOUT,
                close_timeout=timeout,
                proxy=None,
            ) as socket:
                socket.send(json.dumps(payload))
        except Exception as error:
            self.failed += 1
            self.retry_at = now + RETRY_COOLDOWN
            if not self.warned:
                self.warned = True
                self.notice = (
                    f"face bridge unavailable ({type(error).__name__}), subtitles off; "
                    f"is the face app running? [{self.url}] retrying in "
                    f"{int(RETRY_COOLDOWN)}s"
                )
            return False

        self.warned = False
        self.notice = None
        self.retry_at = 0.0
        self.sent += 1
        return True
