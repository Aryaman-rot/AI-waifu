import * as THREE from "three"
import type { VRM } from "@pixiv/three-vrm"

const BLINK_MIN_SECONDS = 3
const BLINK_MAX_SECONDS = 6
const BLINK_CLOSE_SECONDS = 0.07
const BLINK_HOLD_SECONDS = 0.04
const BLINK_OPEN_SECONDS = 0.11

const SWAY_FORWARD_DEGREES = 1.6
const SWAY_SIDEWAYS_DEGREES = 2.2
const SWAY_PERIOD_A_SECONDS = 7.3
const SWAY_PERIOD_B_SECONDS = 11.9

const AXIS_X = new THREE.Vector3(1, 0, 0)
const AXIS_Z = new THREE.Vector3(0, 0, 1)

type BlinkPhase = "waiting" | "closing" | "holding" | "opening"

function blinkInterval() {
  return BLINK_MIN_SECONDS + Math.random() * (BLINK_MAX_SECONDS - BLINK_MIN_SECONDS)
}

/**
 * Ambient life layered on top of whatever is driving the body.
 *
 * three-vrm does neither of these on its own, which is why a correctly posed VRM
 * looks like a statue: there is no blinking, and the spring bones integrate a
 * constant gravity to a fixed rest pose within a second or two and then stop.
 * Both behaviours are correct - they are simply not alive.
 *
 * Full-body idle motion is *not* handled here. That is a retargeted animation
 * clip (see `idle.ts`); layering sine waves onto individual bones cannot produce
 * authored weight shifts and gestures. These two layers are deliberately chosen
 * because they are orthogonal to it: blinking writes expression weights and sway
 * writes spring-bone gravity, so neither touches a bone transform the animation
 * clip is driving, and all three coexist.
 *
 * Blinking is a four-stage envelope (close, hold, open) driven by the frame
 * delta rather than by timers, so it stays correct if the frame rate stutters or
 * the tab is briefly throttled. The interval between blinks is randomised,
 * because a fixed rhythm is the single thing that most reliably makes a face
 * read as synthetic.
 */
export function createAlive(vrm: VRM) {
  const manager = vrm.springBoneManager
  const joints = manager ? [...manager.joints] : []
  const baseGravity = new Map<object, THREE.Vector3>()
  for (const joint of joints) {
    baseGravity.set(joint, joint.settings.gravityDir.clone())
  }

  let elapsed = 0
  let phase: BlinkPhase = "waiting"
  let phaseTime = 0
  let waitFor = blinkInterval()
  let blinks = 0

  const forward = new THREE.Quaternion()
  const sideways = new THREE.Quaternion()

  function setBlink(weight: number) {
    vrm.expressionManager?.setValue("blink", weight)
  }

  function applySway() {
    const a = (elapsed / SWAY_PERIOD_A_SECONDS) * Math.PI * 2
    const b = (elapsed / SWAY_PERIOD_B_SECONDS) * Math.PI * 2
    const forwardDegrees =
      Math.sin(a) * SWAY_FORWARD_DEGREES + Math.sin(b) * SWAY_SIDEWAYS_DEGREES * 0.5
    const sidewaysDegrees =
      Math.sin(b) * SWAY_SIDEWAYS_DEGREES + Math.sin(a) * SWAY_SIDEWAYS_DEGREES * 0.3

    forward.setFromAxisAngle(AXIS_X, THREE.MathUtils.degToRad(forwardDegrees))
    sideways.setFromAxisAngle(AXIS_Z, THREE.MathUtils.degToRad(sidewaysDegrees))

    for (const joint of joints) {
      const base = baseGravity.get(joint)
      if (!base) continue
      joint.settings.gravityDir.copy(base).applyQuaternion(forward).applyQuaternion(sideways)
    }
  }

  function update(delta: number) {
    elapsed += delta
    applySway()

    phaseTime += delta

    switch (phase) {
      case "waiting":
        waitFor -= delta
        if (waitFor <= 0) {
          phase = "closing"
          phaseTime = 0
        }
        break

      case "closing": {
        const weight = Math.min(1, phaseTime / BLINK_CLOSE_SECONDS)
        setBlink(weight)
        if (weight >= 1) {
          phase = "holding"
          phaseTime = 0
        }
        break
      }

      case "holding":
        setBlink(1)
        if (phaseTime >= BLINK_HOLD_SECONDS) {
          phase = "opening"
          phaseTime = 0
        }
        break

      case "opening": {
        const weight = 1 - Math.min(1, phaseTime / BLINK_OPEN_SECONDS)
        setBlink(weight)
        if (weight <= 0) {
          setBlink(0)
          phase = "waiting"
          phaseTime = 0
          waitFor = blinkInterval()
          blinks += 1
        }
        break
      }
    }
  }

  return {
    update,
    /** Diagnostics for the console; not used by the render path. */
    stats: () => ({
      blinks,
      joints: joints.length,
      swayJoints: baseGravity.size,
      seconds: elapsed,
    }),
  }
}
