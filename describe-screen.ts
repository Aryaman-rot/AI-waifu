import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import screenshot from "screenshot-desktop"

type Style = "anthropic" | "openai"

type Candidate = {
  provider: string
  model: string
  baseURL: string
  style: Style
}

// Same routing order the opencode-see-image plugin uses: the Go subscription
// model first, then the Go free models (Zen's free tier rejects outside
// OpenCode, so opencode/mimo-v2.5-free is not reachable over plain HTTP).
const CANDIDATES: Candidate[] = [
  { provider: "opencode-go", model: "minimax-m3", baseURL: "https://opencode.ai/zen/go/v1", style: "anthropic" },
  { provider: "opencode-go", model: "longcat-2.5-preview-free", baseURL: "https://opencode.ai/zen/go/v1", style: "openai" },
  { provider: "opencode-go", model: "space-bunny-free", baseURL: "https://opencode.ai/zen/go/v1", style: "openai" },
]

const PROMPT =
  "Describe what is currently on this screen in one or two sentences. Mention the main app or window and any visible text, code, or dialog."

const SESSION_ID = process.env.OPENCODE_SESSION_ID ?? "ai-waifu-screen-describer"
const USER_AGENT = "ai-waifu-screen-describer/1.0"

function dataDirs(): string[] {
  const dirs: string[] = []
  if (process.env.OPENCODE_DATA_DIR) dirs.push(process.env.OPENCODE_DATA_DIR)
  if (process.env.XDG_DATA_HOME) dirs.push(path.join(process.env.XDG_DATA_HOME, "opencode"))
  dirs.push(path.join(os.homedir(), ".local/share/opencode"))
  if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "opencode"))
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "opencode"))
  }
  return dirs
}

function readProviderKey(provider: string): string | null {
  const fromEnv =
    process.env[`${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`] ??
    process.env.OPENCODE_API_KEY
  if (fromEnv) return fromEnv
  for (const dir of dataDirs()) {
    const authPath = path.join(dir, "auth.json")
    if (!fs.existsSync(authPath)) continue
    try {
      const entry = JSON.parse(fs.readFileSync(authPath, "utf8"))[provider]
      if (entry?.type === "api" && entry?.key) return entry.key as string
    } catch {}
  }
  return null
}

function requestBody(png: Buffer, candidate: Candidate) {
  if (candidate.style === "anthropic") {
    return {
      model: candidate.model,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    }
  }
  return {
    model: candidate.model,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  }
}

function extractText(data: any, style: Style): string {
  if (style === "anthropic") {
    return (data?.content ?? [])
      .map((c: any) => c?.text)
      .filter((t: any) => typeof t === "string" && t.length)
      .join("\n")
      .trim()
  }
  const content = data?.choices?.[0]?.message?.content
  if (Array.isArray(content)) {
    return content
      .map((c: any) => c?.text)
      .filter((t: any) => typeof t === "string" && t.length)
      .join("\n")
      .trim()
  }
  return String(content ?? "").trim()
}

async function describe(png: Buffer, candidate: Candidate): Promise<string> {
  const key = readProviderKey(candidate.provider)
  if (!key) throw new Error(`no stored API key for provider "${candidate.provider}"`)

  const res = await fetch(`${candidate.baseURL}/${candidate.style === "anthropic" ? "messages" : "chat/completions"}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "x-opencode-session": SESSION_ID,
      "user-agent": USER_AGENT,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody(png, candidate)),
  })

  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)

  const text = extractText(await res.json(), candidate.style)
  if (!text) throw new Error("model returned no text")
  return text
}

const png = (await screenshot({ format: "png" })) as Buffer
console.error(`captured ${png.byteLength} bytes in memory`)

const failures: string[] = []
for (const candidate of CANDIDATES) {
  try {
    console.log(await describe(png, candidate))
    process.exit(0)
  } catch (e) {
    failures.push(`${candidate.provider}/${candidate.model}: ${(e as Error).message}`)
  }
}

console.error(`all vision routes failed:\n  ${failures.join("\n  ")}`)
process.exit(1)
