/**
 * Cohere SDK patch - wraps `Client.prototype.chat` and
 * `ClientV2.prototype.chat` from the `cohere-ai` npm package.
 *
 * Covers direct Cohere usage and frameworks that use it (LangChain.js
 * ChatCohere, Haystack, etc.).
 *
 * Cohere has two client generations:
 *  - V1 (`Client`): `chat({ message, chatHistory })` returning `{ text }`
 *  - V2 (`ClientV2`): `chat({ messages })` returning `{ message.content }`
 */

import type { GuardMessage } from "../guard"
import {
  loadPrototype,
  type ModuleLoader,
  type PatchConfig,
  unwrapMethod,
  wrapMethod,
} from "./base"

const PACKAGE = "cohere-ai"
const CLIENT_CLASSES = ["CohereClientV2", "ClientV2", "CohereClient", "Client"]

/** The modules this patch loads, for the `register` entry to `import()`. */
export const SPECIFIERS = [PACKAGE]

/** The CommonJS build, through a literal `require()` bundlers can see. */
function requireCjs(_specifier: string): unknown {
  return require("cohere-ai")
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

/**
 * Flatten Cohere V2 structured content (`[{ type: "text", text }, ...]`) to
 * scannable text. `String()` on a content-part array would yield
 * `"[object Object]"` and the real text would never be scanned. Mirrors the
 * flattening in patches/openai.ts.
 */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const textParts: string[] = []
    for (const part of content) {
      if (typeof part === "string") textParts.push(part)
      else if ((part as Record<string, unknown> | null)?.type === "text") {
        textParts.push(String((part as Record<string, unknown>).text ?? ""))
      }
    }
    return textParts.join("\n")
  }
  return String(content ?? "")
}

export function messagesToGuardFormat(params: Record<string, unknown>): GuardMessage[] {
  const result: GuardMessage[] = []

  if (params.messages && Array.isArray(params.messages)) {
    for (const msg of params.messages) {
      if (!msg) continue
      const role = String(msg.role ?? "user")
      const content = flattenContent(msg.content ?? "")
      result.push({ role, content })
    }
    return result
  }

  if (params.chatHistory && Array.isArray(params.chatHistory)) {
    for (const msg of params.chatHistory) {
      if (!msg) continue
      const role = String(msg.role ?? "user")
      const content = msg.message != null ? String(msg.message) : flattenContent(msg.content ?? "")
      result.push({ role, content })
    }
  }

  if (params.message) {
    result.push({ role: "user", content: String(params.message) })
  }

  return result
}

export function extractResponseText(response: unknown): string | null {
  try {
    const r = response as Record<string, unknown>
    if (typeof r?.text === "string") return r.text
    const message = r?.message as Record<string, unknown> | undefined
    if (message?.content) {
      const parts = message.content
      if (Array.isArray(parts)) {
        const texts: string[] = []
        for (const p of parts) {
          if (p?.text) texts.push(String(p.text))
        }
        return texts.length ? texts.join("\n") : null
      }
      return String(parts)
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Map redacted guard messages back onto Cohere chat args.
 *
 * Mirrors {@link messagesToGuardFormat}: V2 `messages` map 1:1 (falsy
 * entries skipped), V1 maps `chatHistory` entries first and the trailing
 * `message` last. Returns `null` when no known shape is present.
 */
export function applyRedactionToArgs(args: unknown[], redacted: GuardMessage[]): unknown[] | null {
  const params = (args[0] ?? {}) as Record<string, unknown>

  if (Array.isArray(params.messages)) {
    let guardIdx = 0
    const newMessages = params.messages.map((msg) => {
      if (!msg) return msg
      const r = redacted[guardIdx++]
      if (r && typeof msg === "object") {
        const m = msg as Record<string, unknown>
        // Preserve the structured shape: content-part arrays are rebuilt as
        // a text part rather than collapsed to a bare string.
        const content = Array.isArray(m.content) ? [{ type: "text", text: r.content }] : r.content
        return { ...m, content }
      }
      return msg
    })
    return [{ ...params, messages: newMessages }, ...args.slice(1)]
  }

  if (!Array.isArray(params.chatHistory) && params.message == null) return null

  const newParams = { ...params }
  let guardIdx = 0
  if (Array.isArray(params.chatHistory)) {
    newParams.chatHistory = params.chatHistory.map((msg) => {
      if (!msg) return msg
      const r = redacted[guardIdx++]
      if (r && typeof msg === "object") {
        const m = msg as Record<string, unknown>
        // V1 history entries carry text in `message`; fall back to `content`.
        return m.message != null ? { ...m, message: r.content } : { ...m, content: r.content }
      }
      return msg
    })
  }
  if (params.message != null && redacted[guardIdx]) {
    newParams.message = redacted[guardIdx].content
  }
  return [newParams, ...args.slice(1)]
}

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

const cohereConfig: PatchConfig = {
  framework: "cohere",
  extractMessages: (args) => {
    const params = (args[0] ?? {}) as Record<string, unknown>
    return {
      messages: messagesToGuardFormat(params),
      model: params.model ? String(params.model) : "cohere",
    }
  },
  extractResponseText: (response) => extractResponseText(response),
  applyRedaction: applyRedactionToArgs,
}

// ---------------------------------------------------------------------------
// Apply / revert
// ---------------------------------------------------------------------------

export function apply(load: ModuleLoader = requireCjs): boolean {
  let patchedAny = false
  for (const className of CLIENT_CLASSES) {
    // Names that alias one class are wrapped once (wrapMethod is idempotent).
    if (wrapMethod(loadPrototype(load, PACKAGE, className), "chat", cohereConfig)) {
      patchedAny = true
    }
  }
  return patchedAny
}

export function revert(load: ModuleLoader = requireCjs): void {
  for (const className of CLIENT_CLASSES) {
    unwrapMethod(loadPrototype(load, PACKAGE, className), "chat")
  }
}
