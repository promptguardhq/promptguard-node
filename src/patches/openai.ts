/**
 * OpenAI SDK patch - wraps `create` on the Chat Completions prototype and,
 * when the installed `openai` version ships it, `create` on the Responses
 * API prototype (`client.responses.create`).
 *
 * This patch covers every framework built on the `openai` npm package:
 * LangChain.js (ChatOpenAI), Vercel AI SDK (openai provider), AutoGen.js,
 * CrewAI.js, and direct usage.
 *
 * Responses API scope: the patch extracts scannable text from the basic
 * `input` forms: a plain string, or an item array of role/content messages
 * (string content or `input_text`/`output_text`/`text` content parts), plus
 * the `instructions` param. Exotic item types (function_call outputs,
 * reasoning items, etc.) are not scanned.
 */

import type { GuardMessage } from "../guard"
import { asSessionId } from "../integrations/session"
import { logger } from "../logger"
import { loadPrototype, type ModuleLoader, unwrapMethod, wrapMethod } from "./base"

const CHAT_COMPLETIONS = "openai/resources/chat/completions"
const RESPONSES = "openai/resources/responses/responses"

/** The modules this patch loads, for the `register` entry to `import()`. */
export const SPECIFIERS = [CHAT_COMPLETIONS, RESPONSES]

let loggedActive = false

/**
 * The CommonJS build, through literal `require()` calls so that bundlers
 * still see the dependency.
 */
function requireCjs(specifier: string): unknown {
  return specifier === RESPONSES
    ? require("openai/resources/responses/responses")
    : require("openai/resources/chat/completions")
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

export function messagesToGuardFormat(messages: unknown[]): GuardMessage[] {
  if (!messages) return []
  const result: GuardMessage[] = []

  for (const raw of messages) {
    if (!raw) continue
    const msg = raw as Record<string, unknown>
    const role: string = String(msg.role ?? "user")
    let content: string

    if (typeof msg.content === "string") {
      content = msg.content
    } else if (Array.isArray(msg.content)) {
      const textParts: string[] = []
      for (const part of msg.content) {
        if (typeof part === "string") textParts.push(part)
        else if (part?.type === "text") textParts.push(part.text ?? "")
      }
      content = textParts.join("\n")
    } else {
      content = String(msg.content ?? "")
    }

    result.push({ role, content })
  }

  return result
}

export function extractResponseContent(response: unknown): string | null {
  try {
    const r = response as { choices?: { message?: { content?: string } }[] }
    if (r?.choices?.[0]?.message?.content) {
      return r.choices[0].message.content
    }
  } catch {
    // ignore
  }
  return null
}

export function applyRedactionToArgs(args: unknown[], redacted: GuardMessage[]): unknown[] | null {
  const params = (args[0] ?? {}) as Record<string, unknown>
  const messages = params.messages as unknown[] | undefined
  if (!Array.isArray(messages)) return null
  // messagesToGuardFormat skips falsy entries, so track the guard index
  // separately from the array position to keep redactions aligned.
  let guardIdx = 0
  const newMessages = messages.map((msg) => {
    if (!msg) return msg
    const r = redacted[guardIdx++]
    if (r && typeof msg === "object") {
      const m = msg as Record<string, unknown>
      // Preserve the multimodal shape: array content is rebuilt as a text
      // part rather than collapsed to a bare string.
      const content = Array.isArray(m.content) ? [{ type: "text", text: r.content }] : r.content
      return { ...m, content }
    }
    return msg
  })
  return [{ ...params, messages: newMessages }, ...args.slice(1)]
}

// ---------------------------------------------------------------------------
// Responses API (client.responses.create)
// ---------------------------------------------------------------------------

function flattenResponsesContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const raw of content) {
      if (typeof raw === "string") {
        texts.push(raw)
      } else if (raw && typeof raw === "object") {
        const part = raw as Record<string, unknown>
        if (
          (part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
          typeof part.text === "string"
        ) {
          texts.push(part.text)
        }
      }
    }
    return texts.join("\n")
  }
  return String(content ?? "")
}

/**
 * Whether a Responses API input item is a message we extract a guard
 * message for. Single source of truth for extraction and redaction so
 * indices stay aligned.
 */
function isResponsesMessageItem(item: unknown): item is Record<string, unknown> {
  if (!item || typeof item !== "object") return false
  const i = item as Record<string, unknown>
  if (i.type !== undefined && i.type !== "message") return false
  return i.role !== undefined || i.content !== undefined
}

/**
 * Extract guard messages from Responses API params: `instructions` (system),
 * then `input` as a plain string or an array of message items.
 */
export function responsesInputToGuardFormat(params: Record<string, unknown>): GuardMessage[] {
  const result: GuardMessage[] = []

  if (typeof params.instructions === "string" && params.instructions) {
    result.push({ role: "system", content: params.instructions })
  }

  const input = params.input
  if (typeof input === "string") {
    result.push({ role: "user", content: input })
    return result
  }
  if (!Array.isArray(input)) return result

  for (const item of input) {
    if (!isResponsesMessageItem(item)) continue
    result.push({
      role: String(item.role ?? "user"),
      content: flattenResponsesContent(item.content),
    })
  }
  return result
}

export function extractResponsesResponseText(response: unknown): string | null {
  try {
    const r = response as Record<string, unknown>
    if (typeof r?.output_text === "string" && r.output_text) return r.output_text
    const output = r?.output
    if (Array.isArray(output)) {
      const texts: string[] = []
      for (const item of output) {
        if (isResponsesMessageItem(item)) {
          const text = flattenResponsesContent(item.content)
          if (text) texts.push(text)
        }
      }
      return texts.length ? texts.join("\n") : null
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Map redacted guard messages back onto Responses API args. Mirrors
 * {@link responsesInputToGuardFormat}: `instructions` first (when emitted),
 * then string input or message items in order. Returns `null` for shapes we
 * cannot rewrite safely (escalated to block in enforce mode).
 */
export function applyResponsesRedactionToArgs(
  args: unknown[],
  redacted: GuardMessage[],
): unknown[] | null {
  const params = (args[0] ?? {}) as Record<string, unknown>
  const newParams = { ...params }
  let guardIdx = 0

  if (typeof params.instructions === "string" && params.instructions) {
    const r = redacted[guardIdx++]
    if (r) newParams.instructions = r.content
  }

  const input = params.input
  if (typeof input === "string") {
    const r = redacted[guardIdx]
    if (!r) return null
    newParams.input = r.content
    return [newParams, ...args.slice(1)]
  }

  if (!Array.isArray(input)) {
    // Only `instructions` was extracted; anything else is unredactable.
    return guardIdx > 0 ? [newParams, ...args.slice(1)] : null
  }

  newParams.input = input.map((item) => {
    if (!isResponsesMessageItem(item)) return item
    const r = redacted[guardIdx++]
    if (!r) return item
    // Preserve the structured shape: part arrays are rebuilt as a text part.
    const content = Array.isArray(item.content)
      ? [{ type: "input_text", text: r.content }]
      : r.content
    return { ...item, content }
  })
  return [newParams, ...args.slice(1)]
}

// ---------------------------------------------------------------------------
// Apply / revert
// ---------------------------------------------------------------------------

function applyChatCompletionsPatch(load: ModuleLoader): boolean {
  return wrapMethod(loadPrototype(load, CHAT_COMPLETIONS, "Completions"), "create", {
    framework: "openai",
    extractMessages: (args) => {
      const params = (args[0] ?? {}) as Record<string, unknown>
      const messages = params.messages as unknown[] | undefined
      return {
        messages: messages ? messagesToGuardFormat(messages) : [],
        model: params.model ? String(params.model) : undefined,
      }
    },
    extractResponseText: (response) => extractResponseContent(response),
    applyRedaction: applyRedactionToArgs,
  })
}

/**
 * The Conversation a Responses call belongs to, as its `session_id`.
 *
 * `conversation` is the call's own conversation, an id or `{ id }`: the same
 * on every turn. `previous_response_id` is not read: it names the previous
 * response, so it changes every turn.
 */
export function responsesConversationId(conversation: unknown): string | undefined {
  const id =
    conversation && typeof conversation === "object"
      ? (conversation as { id?: unknown }).id
      : conversation
  return typeof id === "string" ? asSessionId(id) : undefined
}

function applyResponsesPatch(load: ModuleLoader): boolean {
  // Older `openai` versions have no Responses API; the chat.completions patch
  // still applies without it.
  return wrapMethod(loadPrototype(load, RESPONSES, "Responses"), "create", {
    framework: "openai",
    extractMessages: (args) => {
      const params = (args[0] ?? {}) as Record<string, unknown>
      return {
        messages: responsesInputToGuardFormat(params),
        model: params.model ? String(params.model) : undefined,
        sessionId: responsesConversationId(params.conversation),
      }
    },
    extractResponseText: (response) => extractResponsesResponseText(response),
    applyRedaction: applyResponsesRedactionToArgs,
  })
}

/**
 * Patch the copy of the SDK that `load` reaches: the CommonJS build by
 * default, the ES module build when the `register` entry passes its loader.
 * Idempotent per copy.
 */
export function apply(load: ModuleLoader = requireCjs): boolean {
  const chatPatched = applyChatCompletionsPatch(load)
  const responsesPatched = applyResponsesPatch(load)
  if (!chatPatched && !responsesPatched) return false

  if (!loggedActive) {
    loggedActive = true
    logger.debug(
      "openai patch active " +
        `(chat.completions=${chatPatched}, responses=${responsesPatched}): ` +
        "APIPromise helpers (.withResponse()/.asResponse()) " +
        "are not preserved on patched methods, see README 'Limitations'",
    )
  }
  return true
}

export function revert(load: ModuleLoader = requireCjs): void {
  unwrapMethod(loadPrototype(load, CHAT_COMPLETIONS, "Completions"), "create")
  unwrapMethod(loadPrototype(load, RESPONSES, "Responses"), "create")
}
