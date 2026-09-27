const MS_PER_CHAR = 85
const MIN_VISIBLE_MS = 2500
const MAX_VISIBLE_MS = 10000

/**
 * Owns the subtitle strip under the avatar.
 *
 * Visibility is driven by a single timer that is replaced on every show(), so a
 * new line always supersedes the old one and the strip can never be left holding
 * text she is no longer saying. Duration scales with length at a rough reading
 * pace, clamped so a one-word reply does not flash and a long one has time to be
 * read.
 */
export function createSubtitle(element: HTMLElement) {
  let timer: number | undefined

  function show(text: string) {
    const trimmed = text.trim()
    clear()
    if (!trimmed) return

    element.textContent = trimmed
    element.classList.add("visible")

    const duration = Math.min(
      MAX_VISIBLE_MS,
      Math.max(MIN_VISIBLE_MS, trimmed.length * MS_PER_CHAR),
    )
    timer = window.setTimeout(clear, duration)
  }

  function clear() {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
    if (!element.classList.contains("visible")) return
    element.classList.remove("visible")
    element.textContent = ""
  }

  return { show, clear }
}
