import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm"
import type { VRMHumanBoneName } from "@pixiv/three-vrm"

import { setRestPose } from "./pose"
import { createSubtitle } from "./subtitle"
import { createAlive } from "./alive"
import { loadIdleClips, createIdleDirector } from "./idle"
import { createLipsync } from "./lipsync"

let lipsync: ReturnType<typeof createLipsync> | null = null

window.miku?.onSpeech((text) => subtitle.show(text))
window.miku?.onClear(() => subtitle.clear())
window.miku?.onBridgeStatus((status) => console.log(status))
window.miku?.onAudioStop(() => lipsync?.stop())

const subtitle = createSubtitle(
  document.querySelector<HTMLElement>("#subtitle")!,
)

interface MikuBridge {
  onSpeech: (handler: (text: string) => void) => void
  onClear: (handler: () => void) => void
  onBridgeStatus: (handler: (status: string) => void) => void
  listIdleClips: () => Promise<string[]>
  onAudio: (handler: (base64: string, format: string) => void) => void
  onAudioStop: (handler: () => void) => void
}

declare global {
  interface Window {
    miku?: MikuBridge
  }
}

window.miku?.onSpeech((text) => subtitle.show(text))
window.miku?.onClear(() => subtitle.clear())
window.miku?.onBridgeStatus((status) => console.log(status))
window.miku?.onAudioStop(() => lipsync?.stop())

const MODEL_URL = "app://assets/model.vrm"
const MODEL_HEIGHT = 1
const FIT_MARGIN = 1.18
const FOV = 25

const canvas = document.querySelector<HTMLCanvasElement>("#stage")!

const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  powerPreference: "high-performance",
})
renderer.setClearColor(0x000000, 0)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

const scene = new THREE.Scene()

const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100)
scene.add(new THREE.AmbientLight(0xffffff, 0.85))
scene.add(new THREE.HemisphereLight(0xffffff, 0x666688, 0.9))
const key = new THREE.DirectionalLight(0xffffff, 2.4)
key.position.set(1, 1.4, 1.2).normalize()
scene.add(key)
const rim = new THREE.DirectionalLight(0x8899ff, 0.7)
rim.position.set(-1, 0.6, -0.8).normalize()
scene.add(rim)

function fitCamera(box: THREE.Box3) {
  const size = box.getSize(new THREE.Vector3())
  const centre = box.getCenter(new THREE.Vector3())
  const halfV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
  const halfH = halfV * camera.aspect
  const distance =
    Math.max(size.y / 2 / halfV, size.x / 2 / halfH, size.z / 2 / halfH) *
    FIT_MARGIN
  camera.position.set(centre.x, centre.y, centre.z + distance)
  camera.lookAt(centre)
}

function resize() {
  const width = window.innerWidth
  const height = window.innerHeight
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  return width / height
}
window.addEventListener("resize", () => {
  resize()
  if (model) fitCamera(new THREE.Box3().setFromObject(model))
})

resize()

function normalise(root: THREE.Object3D) {
  root.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(root)
  const size = box.getSize(new THREE.Vector3())
  root.scale.setScalar(MODEL_HEIGHT / size.y)
  root.updateWorldMatrix(true, true)

  const scaled = new THREE.Box3().setFromObject(root)
  const centre = scaled.getCenter(new THREE.Vector3())
  root.position.x -= centre.x
  root.position.z -= centre.z
  root.position.y -= scaled.min.y
  root.updateWorldMatrix(true, true)

  return new THREE.Box3().setFromObject(root)
}

let model: THREE.Object3D | null = null

function worldOf(vrm: VRM, bone: VRMHumanBoneName) {
  return vrm.humanoid
    .getRawBoneNode(bone)
    ?.getWorldPosition(new THREE.Vector3())
}

function reportPose(vrm: VRM, stage: string) {
  vrm.scene.updateWorldMatrix(true, true)
  const rows: string[] = []
  for (const side of ["left", "right"] as const) {
    const hand = worldOf(vrm, `${side}Hand`)
    const shoulder = worldOf(vrm, `${side}Shoulder`)
    const hip = worldOf(vrm, "hips")
    const tip = worldOf(vrm, `${side}IndexDistal`)
    if (!hand || !shoulder || !hip || !tip) continue
    rows.push(
      `${side} hand=(${hand.x.toFixed(3)},${hand.y.toFixed(3)},${hand.z.toFixed(3)}) ` +
        `dropFromShoulder=${(shoulder.y - hand.y).toFixed(3)} ` +
        `outFromSpine=${Math.abs(hand.x - hip.x).toFixed(3)} ` +
        `wristToTip=${hand.distanceTo(tip).toFixed(3)}`,
    )
  }
  console.log(`pose[${stage}] ${rows.join("  |  ")}`)
}

async function load() {
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))

  const gltf = await loader.loadAsync(MODEL_URL)
  const vrm = gltf.userData.vrm as VRM | undefined
  if (!vrm) throw new Error("loaded gltf carried no VRM payload")

  vrm.scene.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (mesh.isMesh) {
      mesh.castShadow = false
      mesh.receiveShadow = false
    }
  })

  VRMUtils.rotateVRM0(vrm)
  reportPose(vrm, "bind")

  setRestPose(vrm)
  reportPose(vrm, "set (pre-sync)")

  vrm.update(1 / 60)
  reportPose(vrm, "after vrm.update() sync")

  scene.add(vrm.scene)
  const box = normalise(vrm.scene)
  model = vrm.scene
  fitCamera(box)

  const size = box.getSize(new THREE.Vector3())
  const meta = vrm.meta as unknown as { metaVersion?: string; name?: string; title?: string }
  console.log(
    `loaded VRM ${meta.metaVersion ?? "?"} | normalised ${size.x.toFixed(3)}w ` +
      `${size.y.toFixed(3)}h ${size.z.toFixed(3)}d | "${meta.name ?? meta.title ?? "?"}"`,
  )
  return vrm
}

const clock = new THREE.Clock()

load()
  .then(async (vrm) => {
    const alive = createAlive(vrm)
    let idle: ReturnType<typeof createIdleDirector> | null = null

    lipsync = createLipsync(vrm)
    window.miku?.onAudio((base64, format) => {
      lipsync
        ?.play(base64)
        .then(() => console.log(`[lipsync] playing ${format} clip`))
        .catch((error: unknown) =>
          console.error("[lipsync] decode failed:", (error as Error).message),
        )
    })

    try {
      const urls = (await window.miku?.listIdleClips()) ?? []
      if (urls.length === 0) {
        throw new Error("no .fbx files in face/assets/idle")
      }

      const { clips, failures } = await loadIdleClips(vrm, urls)
      if (failures.length) {
        console.warn(`idle clips skipped: ${failures.join(" | ")}`)
      }
      if (clips.length === 0) {
        throw new Error(`all ${urls.length} clip(s) failed to load`)
      }

      idle = createIdleDirector(vrm, clips)
      const lengths = clips.map((c) => `${c.duration.toFixed(1)}s`).join(", ")
      console.log(
        `idle: ${clips.length}/${urls.length} clips loaded, crossfading | durations: ${lengths}`,
      )
    } catch (error) {
      console.warn(
        `idle animation unavailable (${(error as Error).message}). ` +
          `Drop Mixamo idle FBX files into face/assets/idle/ - she will hold the ` +
          `rest pose with blink and sway only.`,
      )
    }

    renderer.setAnimationLoop(() => {
      const delta = clock.getDelta()
      idle?.update(delta)
      lipsync?.update(delta)
      alive.update(delta)
      vrm.update(delta)
      renderer.render(scene, camera)
    })
  })

  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error("model load failed:", message)
    document.title = `face: load failed - ${message}`
    document.body.style.background = "#ff00ff"
  })
