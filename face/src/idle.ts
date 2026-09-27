import * as THREE from "three"
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js"
import type { VRM } from "@pixiv/three-vrm"

/**
 * Mixamo rig name -> VRM humanoid bone name.
 *
 * Verbatim from three-vrm's own `humanoidAnimation` example
 * (packages/three-vrm/examples/humanoidAnimation/mixamoVRMRigMap.js).
 */
const MIXAMO_VRM_RIG_MAP: Record<string, string> = {
  mixamorigHips: "hips",
  mixamorigSpine: "spine",
  mixamorigSpine1: "chest",
  mixamorigSpine2: "upperChest",
  mixamorigNeck: "neck",
  mixamorigHead: "head",
  mixamorigLeftShoulder: "leftShoulder",
  mixamorigLeftArm: "leftUpperArm",
  mixamorigLeftForeArm: "leftLowerArm",
  mixamorigLeftHand: "leftHand",
  mixamorigLeftHandThumb1: "leftThumbMetacarpal",
  mixamorigLeftHandThumb2: "leftThumbProximal",
  mixamorigLeftHandThumb3: "leftThumbDistal",
  mixamorigLeftHandIndex1: "leftIndexProximal",
  mixamorigLeftHandIndex2: "leftIndexIntermediate",
  mixamorigLeftHandIndex3: "leftIndexDistal",
  mixamorigLeftHandMiddle1: "leftMiddleProximal",
  mixamorigLeftHandMiddle2: "leftMiddleIntermediate",
  mixamorigLeftHandMiddle3: "leftMiddleDistal",
  mixamorigLeftHandRing1: "leftRingProximal",
  mixamorigLeftHandRing2: "leftRingIntermediate",
  mixamorigLeftHandRing3: "leftRingDistal",
  mixamorigLeftHandPinky1: "leftLittleProximal",
  mixamorigLeftHandPinky2: "leftLittleIntermediate",
  mixamorigLeftHandPinky3: "leftLittleDistal",
  mixamorigRightShoulder: "rightShoulder",
  mixamorigRightArm: "rightUpperArm",
  mixamorigRightForeArm: "rightLowerArm",
  mixamorigRightHand: "rightHand",
  mixamorigRightHandPinky1: "rightLittleProximal",
  mixamorigRightHandPinky2: "rightLittleIntermediate",
  mixamorigRightHandPinky3: "rightLittleDistal",
  mixamorigRightHandRing1: "rightRingProximal",
  mixamorigRightHandRing2: "rightRingIntermediate",
  mixamorigRightHandRing3: "rightRingDistal",
  mixamorigRightHandMiddle1: "rightMiddleProximal",
  mixamorigRightHandMiddle2: "rightMiddleIntermediate",
  mixamorigRightHandMiddle3: "rightMiddleDistal",
  mixamorigRightHandIndex1: "rightIndexProximal",
  mixamorigRightHandIndex2: "rightIndexIntermediate",
  mixamorigRightHandIndex3: "rightIndexDistal",
  mixamorigRightHandThumb1: "rightThumbMetacarpal",
  mixamorigRightHandThumb2: "rightThumbProximal",
  mixamorigRightHandThumb3: "rightThumbDistal",
  mixamorigLeftUpLeg: "leftUpperLeg",
  mixamorigLeftLeg: "leftLowerLeg",
  mixamorigLeftFoot: "leftFoot",
  mixamorigLeftToeBase: "leftToes",
  mixamorigRightUpLeg: "rightUpperLeg",
  mixamorigRightLeg: "rightLowerLeg",
  mixamorigRightFoot: "rightFoot",
  mixamorigRightToeBase: "rightToes",
}

/**
 * Loads a Mixamo FBX and retargets it onto this VRM's humanoid skeleton.
 *
 * The conversion is the one from three-vrm's own `humanoidAnimation` example,
 * kept faithful because every step of it is load-bearing:
 *
 *  1. Tracks are addressed by Mixamo bone name and rewritten to the *normalized*
 *     VRM bone node's object name, which is what the mixer will drive.
 *  2. Each rotation becomes `parentRestWorldRotation * trackRotation *
 *     restRotationInverse`, converting a world-relative motion into a local one.
 *  3. Translations are scaled by the ratio of this model's rest hips height to
 *     Mixamo's, or the animation drifts off the ground.
 *  4. VRM 0.0 models are left-handed relative to 1.0, so components are negated:
 *     every other quaternion component, and the x/z of every vector. This model is
 *     VRM 0.0, so step 4 is not optional - without it the animation plays inside
 *     out.
 *
 * Driving the normalized rig rather than the raw bones is also what keeps this
 * compatible with the rest of the app: `humanoid.autoUpdateHumanBones` copies
 * normalized over raw every frame, so anything written to raw would be reverted
 * immediately. That is the same trap as the Phase 8 rest-pose bug.
 */
export async function loadIdleClip(vrm: VRM, url: string) {
  const loader = new FBXLoader()
  const asset = await loader.loadAsync(url)

  const clip =
    THREE.AnimationClip.findByName(asset.animations, "mixamo.com") ??
    asset.animations[0]

  if (!clip) {
    throw new Error("FBX contained no animation clip")
  }

  const tracks: THREE.KeyframeTrack[] = []
  const restRotationInverse = new THREE.Quaternion()
  const parentRestWorldRotation = new THREE.Quaternion()
  const quat = new THREE.Quaternion()

  const mixamoHips = asset.getObjectByName("mixamorigHips")
  const hipsPosition = vrm.humanoid.normalizedRestPose.hips?.position
  const vrmHipsHeight = hipsPosition?.[1]
  const hipsScale =
    mixamoHips && vrmHipsHeight ? vrmHipsHeight / mixamoHips.position.y : 1

  const isVrm0 = vrm.meta?.metaVersion === "0"

  for (const track of clip.tracks) {
    const [mixamoRigName, propertyName] = track.name.split(".")
    const vrmBoneName = MIXAMO_VRM_RIG_MAP[mixamoRigName]
    const vrmNodeName = vrm.humanoid?.getNormalizedBoneNode(vrmBoneName as never)?.name
    const mixamoRigNode = asset.getObjectByName(mixamoRigName)
    if (vrmNodeName == null || !mixamoRigNode || !mixamoRigNode.parent) continue

    mixamoRigNode.getWorldQuaternion(restRotationInverse).invert()
    mixamoRigNode.parent.getWorldQuaternion(parentRestWorldRotation)

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const values = track.values as unknown as number[]
      for (let i = 0; i < values.length; i += 4) {
        quat.fromArray(values, i)
        quat.premultiply(parentRestWorldRotation).multiply(restRotationInverse)
        quat.toArray(values, i)
      }
      tracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${vrmNodeName}.${propertyName}`,
          track.times,
          values.map((v, i) => (isVrm0 && i % 2 === 0 ? -v : v)),
        ),
      )
    } else if (track instanceof THREE.VectorKeyframeTrack) {
      const values = (track.values as unknown as number[]).map(
        (v, i) => (isVrm0 && i % 3 !== 1 ? -v : v) * hipsScale,
      )
      tracks.push(
        new THREE.VectorKeyframeTrack(`${vrmNodeName}.${propertyName}`, track.times, values),
      )
    }
  }

  return new THREE.AnimationClip("idle", clip.duration, tracks)
}

/**
 * Loads and retargets every .fbx in the idle folder.
 *
 * One clip failing does not sink the others - a malformed or unrepresentable
 * download should cost one animation, not all of them - so failures are collected
 * and reported rather than thrown.
 */
export async function loadIdleClips(vrm: VRM, urls: string[]) {
  const clips: THREE.AnimationClip[] = []
  const failures: string[] = []

  for (const url of urls) {
    try {
      clips.push(await loadIdleClip(vrm, url))
    } catch (error) {
      failures.push(`${url.split("/").pop()}: ${(error as Error).message}`)
    }
  }

  return { clips, failures }
}

const CROSSFADE_SECONDS = 1.2
const DWELL_MIN_SECONDS = 7
const DWELL_MAX_SECONDS = 16

/**
 * Plays a set of idle clips, crossfading between them at random intervals.
 *
 * Looping one clip forever is the thing that most visibly reads as a loop no
 * matter how good the clip is, so a random pick from the set is the point rather
 * than a refinement. Dwell is randomised for the same reason blink interval is:
 * a metronome reads as synthetic.
 *
 * `crossFadeFrom` works here because every clip is retargeted onto the *same*
 * normalized bone node names, so the two actions bind identical properties and the
 * mixer can blend their contributions. Retargeting per-clip rather than blending
 * the source animations is what makes the crossfade well defined.
 */
export function createIdleDirector(vrm: VRM, clips: THREE.AnimationClip[]) {
  const mixer = new THREE.AnimationMixer(vrm.scene)
  const actions = clips.map((clip) => {
    const action = mixer.clipAction(clip)
    action.setLoop(THREE.LoopRepeat, Infinity)
    action.enabled = false
    action.setEffectiveWeight(0)
    return action
  })

  let current: THREE.AnimationAction | null = null
  let currentIndex = -1
  let dwell = 0
  let dwellTarget = 0

  function pickNext() {
    if (actions.length === 0) return
    let index = currentIndex
    if (actions.length > 1) {
      while (index === currentIndex) {
        index = Math.floor(Math.random() * actions.length)
      }
    }

    const next = actions[index]
    next.reset()
    next.enabled = true
    next.setEffectiveWeight(1)
    next.play()

    if (current && current !== next) {
      next.crossFadeFrom(current, CROSSFADE_SECONDS, false)
    }

    current = next
    currentIndex = index
    dwell = 0
    dwellTarget = DWELL_MIN_SECONDS + Math.random() * (DWELL_MAX_SECONDS - DWELL_MIN_SECONDS)
  }

  function update(delta: number) {
    if (actions.length === 0) return
    if (!current) {
      dwellTarget = DWELL_MIN_SECONDS
      pickNext()
      return
    }
    mixer.update(delta)
    dwell += delta
    if (dwell >= dwellTarget) pickNext()
  }

  return {
    update,
    clipCount: actions.length,
    currentIndex: () => currentIndex,
  }
}
