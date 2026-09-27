import * as THREE from "three"
import type { VRM, VRMPose } from "@pixiv/three-vrm"

const DEG = Math.PI / 180

const FINGERS = ["Index", "Middle", "Ring", "Little"] as const
const SIDES = ["left", "right"] as const

export type RestPoseOptions = {
  /** Degrees the upper arm swings down from the T-pose. */
  upperArmDrop: number
  /** Degrees the elbow bends, bringing the forearm slightly forward. */
  elbowBend: number
  /** Degrees each finger joint curls toward the palm. */
  fingerCurl: number
  /** Extra curl applied to the middle and end finger joints. */
  fingerCurlMid: number
  fingerCurlTip: number
  /** Degrees the thumb tucks toward the palm. */
  thumbCurl: number
  /** Degrees the shoulder lifts, widening the silhouette away from the torso. */
  shoulderLift: number
}

export const DEFAULT_REST_POSE: RestPoseOptions = {
  upperArmDrop: 74,
  elbowBend: 12,
  fingerCurl: 26,
  fingerCurlMid: 34,
  fingerCurlTip: 18,
  thumbCurl: 22,
  shoulderLift: 4,
}

type Rotation = [number, number, number, number]

function about(axis: "x" | "y" | "z", degrees: number): Rotation {
  const vector =
    axis === "x"
      ? new THREE.Vector3(1, 0, 0)
      : axis === "y"
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1)
  const q = new THREE.Quaternion().setFromAxisAngle(vector, degrees * DEG)
  return [q.x, q.y, q.z, q.w]
}

function buildPose(options: RestPoseOptions): VRMPose {
  const pose: VRMPose = {}

  for (const side of SIDES) {
    const sign = side === "left" ? 1 : -1

    pose[`${side}Shoulder`] = {
      rotation: about("z", options.shoulderLift * sign),
    }
    pose[`${side}UpperArm`] = {
      rotation: about("z", options.upperArmDrop * sign),
    }
    pose[`${side}LowerArm`] = {
      rotation: about("y", -options.elbowBend * sign),
    }
    pose[`${side}Hand`] = {
      rotation: about("y", options.elbowBend * 0.4 * sign),
    }

    for (const finger of FINGERS) {
      pose[`${side}${finger}Proximal`] = {
        rotation: about("z", options.fingerCurl * sign),
      }
      pose[`${side}${finger}Intermediate`] = {
        rotation: about("z", options.fingerCurlMid * sign),
      }
      pose[`${side}${finger}Distal`] = {
        rotation: about("z", options.fingerCurlTip * sign),
      }
    }

    pose[`${side}ThumbMetacarpal`] = {
      rotation: about("z", options.thumbCurl * sign),
    }
    pose[`${side}ThumbProximal`] = {
      rotation: about("z", options.thumbCurl * 0.7 * sign),
    }
    pose[`${side}ThumbDistal`] = {
      rotation: about("z", options.thumbCurl * 0.5 * sign),
    }
  }

  return pose
}

/**
 * Applies a relaxed standing pose through the VRM humanoid.
 *
 * This model stores no rest pose of its own, so the loader falls back to the raw
 * bind pose and she stands in a T-pose with every finger locked straight out.
 * Rather than hard-coding bone quaternions, the pose is expressed as joint angles
 * and multiplied onto the rest transform the rig captured at load, which keeps
 * the rest pose recoverable for a later idle-animation phase to blend from.
 *
 * The pose goes to the **normalized** rig, not the raw one. `vrm.humanoid` has
 * `autoUpdateHumanBones` on by default, so every `vrm.update()` copies the
 * normalized bones over the raw bones that actually drive the skinned mesh.
 * Writing the raw bones directly looks correct when read back immediately but is
 * silently reverted on the very next animation frame, which is precisely how the
 * pose silently failed the first time. Driving the normalized rig instead means
 * the existing per-frame sync propagates it, and gives idle animation the correct
 * handle to animate.
 */
export function setRestPose(vrm: VRM, overrides: Partial<RestPoseOptions> = {}) {
  vrm.humanoid.setNormalizedPose(buildPose({ ...DEFAULT_REST_POSE, ...overrides }))
}
