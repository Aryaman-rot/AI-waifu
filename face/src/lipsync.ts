import type { VRM } from "@pixiv/three-vrm"

/**
 * Amplitude-driven mouth movement.
 *
 * The face owns playback rather than receiving "she is speaking now" because the
 * only honest mouth shape is the one the audio actually implies. Measuring the
 * signal is cheap and, unlike a phoneme timeline derived from text, it cannot
 * drift out of sync with the voice.
 *
 * Deliberately crude in the way that matters: one `aa` blend shape driven by
 * smoothed loudness. Real per-phoneme viseme mapping would need phoneme timing
 * that nothing upstream produces yet.
 */

const ATTACK_RATE = 0.55
const RELEASE_RATE = 0.11
const AMPLITUDE_GAIN = 7
const AMPLITUDE_CURVE = 0.65

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export function createLipsync(vrm: VRM) {
  let context: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let source: AudioBufferSourceNode | null = null
  let samples: Uint8Array<ArrayBuffer> | null = null
  let playing = false
  let mouth = 0

  function graph() {
    if (context) return context
    context = new AudioContext()
    analyser = context.createAnalyser()
    // Time-domain data, not frequency: a mouth wants loudness, not which
    // frequencies are present.
    analyser.fftSize = 1024
    samples = new Uint8Array(analyser.fftSize)
    analyser.connect(context.destination)
    // Electron's window is created with autoplayPolicy no-user-gesture-required,
    // so the context starts running. Resuming defensively costs nothing if it
    // already is.
    if (context.state === "suspended") void context.resume()
    return context
  }

  function readAmplitude(): number {
    if (!playing || !analyser || !samples) return 0
    analyser.getByteTimeDomainData(samples)
    let sum = 0
    for (let i = 0; i < samples.length; i++) {
      const centred = (samples[i] - 128) / 128
      sum += centred * centred
    }
    const rms = Math.sqrt(sum / samples.length)
    return Math.min(1, Math.pow(rms * AMPLITUDE_GAIN, AMPLITUDE_CURVE))
  }

  function stop() {
    if (source) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // Already stopped; nothing to do.
      }
      source.disconnect()
      source = null
    }
    playing = false
  }

  async function play(base64: string) {
    const ctx = graph()
    const buffer = await ctx.decodeAudioData(base64ToArrayBuffer(base64))
    stop()
    const node = ctx.createBufferSource()
    node.buffer = buffer
    node.connect(analyser!)
    node.onended = () => {
      playing = false
      source = null
    }
    source = node
    playing = true
    node.start()
  }

  function update(delta: number) {
    const target = readAmplitude()
    // Fast attack so a syllable opens promptly, slow release so the mouth eases
    // shut between words instead of flickering. Rates are per-60fps-frame and
    // rescaled by the real delta, so behaviour does not change with frame rate.
    const frame = Math.min(3, delta * 60)
    const rate = target > mouth ? ATTACK_RATE : RELEASE_RATE
    const blend = 1 - Math.pow(1 - rate, frame)
    mouth += (target - mouth) * blend
    if (mouth < 0.0005) mouth = 0
    vrm.expressionManager?.setValue("aa", mouth)
  }

  return {
    play,
    stop,
    update,
    get isPlaying() {
      return playing
    },
  }
}
