/**
 * Google Gen AI SDK patch, `@google/genai`, the SDK Google ships today.
 *
 * `./google.ts` covers `@google/generative-ai`, which Google deprecated when
 * Gemini 2.0 landed. Both are patched: customers are still on the old one, and
 * dropping it to chase the new one would leave them silently unprotected, which
 * is the exact bug adding this file fixes in the other direction.
 *
 * **This one cannot be patched on the prototype.** Every other patch in this
 * directory does `Klass.prototype.method = wrapped`. In `@google/genai`,
 * `generateContent` is assigned as an **own property in the constructor**,
 * `Models.prototype.generateContent` is `undefined`, and each client instance
 * gets its own copy. Verified against the published package rather than
 * assumed; the prototype approach would have installed cleanly, patched
 * nothing, and reported success.
 *
 * So the exported `GoogleGenAI` constructor is swapped for a subclass that
 * wraps the instance methods after `super()` has created them. Public API only,
 * no reliance on the `*Internal` methods, which are unstable by name.
 *
 * The ES module build (patched through the `register` entry) cannot have an
 * export swapped: a module namespace is read-only. There the constructor's
 * own `this.models = new Models(...)` assignment is caught instead, by a
 * `models` setter on `GoogleGenAI.prototype` that wraps the instance methods
 * and then stores `models` as an ordinary own property. Verified against
 * `@google/genai` 3.3.0, which assigns `models` in the constructor.
 */

import type { GuardMessage } from "../guard"
import { createPatchedMethod, type ModuleLoader } from "./base"

export const NAME = "google-genai"

/** Package names that mean this patch is relevant. See `auto.ts`. */
export const DETECTS = ["@google/genai"]

const PACKAGE = "@google/genai"

/** The modules this patch loads, for the `register` entry to `import()`. */
export const SPECIFIERS = [PACKAGE]

/** The CommonJS build, through a literal `require()` bundlers can see. */
function requireCjs(_specifier: string): unknown {
  return require("@google/genai")
}

/** Marks the `models` setter this patch installs on an ES module build. */
const MODELS_HOOK = Symbol.for("promptguard-sdk.genai-models-hook")

let originalConstructor: unknown = null
let patched = false

// -- Message extraction ------------------------------------------------------

function partText(part: unknown): string {
  if (typeof part === "string") return part
  if (!part || typeof part !== "object") return ""
  const p = part as Record<string, unknown>
  const found: string[] = []

  if (typeof p.text === "string" && p.text) found.push(p.text)

  // Tool traffic. Exfiltration through a tool call is written into the
  // arguments, not into the visible prose, so these are read deliberately.
  for (const key of ["functionCall", "function_call"]) {
    const call = p[key] as Record<string, unknown> | undefined
    if (!call) continue
    if (typeof call.name === "string" && call.name) found.push(call.name)
    if (call.args && typeof call.args === "object") found.push(JSON.stringify(call.args))
  }
  for (const key of ["functionResponse", "function_response"]) {
    const resp = p[key] as Record<string, unknown> | undefined
    if (resp?.response && typeof resp.response === "object")
      found.push(JSON.stringify(resp.response))
  }
  for (const key of ["executableCode", "executable_code"]) {
    const code = p[key] as Record<string, unknown> | undefined
    if (typeof code?.code === "string" && code.code) found.push(code.code)
  }
  for (const key of ["codeExecutionResult", "code_execution_result"]) {
    const result = p[key] as Record<string, unknown> | undefined
    if (typeof result?.output === "string" && result.output) found.push(result.output)
  }

  return found.join("\n")
}

/** Flatten `contents`: a string, a Content, or a list mixing both. */
export function contentsToGuardFormat(contents: unknown): GuardMessage[] {
  if (contents == null) return []
  if (typeof contents === "string") return [{ role: "user", content: contents }]

  const items = Array.isArray(contents) ? contents : [contents]
  const out: GuardMessage[] = []
  for (const item of items) {
    if (typeof item === "string") {
      out.push({ role: "user", content: item })
      continue
    }
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    const parts = record.parts
    const text = Array.isArray(parts)
      ? parts.map(partText).filter(Boolean).join("\n")
      : partText(record)
    if (text) out.push({ role: String(record.role ?? "user"), content: text })
  }
  return out
}

/** The system prompt, which lives in `config` and not in `contents` at all. */
export function systemInstructionText(config: unknown): string {
  if (!config || typeof config !== "object") return ""
  const instruction = (config as Record<string, unknown>).systemInstruction
  if (instruction == null) return ""
  if (typeof instruction === "string") return instruction
  const parts = (instruction as Record<string, unknown>).parts
  if (Array.isArray(parts)) return parts.map(partText).filter(Boolean).join("\n")
  return partText(instruction)
}

export function extractMessages(args: unknown[]): { messages: GuardMessage[]; model: string } {
  const request = (args[0] ?? {}) as Record<string, unknown>
  const messages: GuardMessage[] = []

  const system = systemInstructionText(request.config)
  if (system) messages.push({ role: "system", content: system })
  messages.push(...contentsToGuardFormat(request.contents))

  return { messages, model: typeof request.model === "string" ? request.model : "gemini" }
}

export function extractResponseText(response: unknown): string | null {
  if (!response || typeof response !== "object") return null
  const candidates = (response as Record<string, unknown>).candidates
  if (Array.isArray(candidates)) {
    const texts: string[] = []
    for (const candidate of candidates) {
      const content = (candidate as Record<string, unknown>)?.content as
        | Record<string, unknown>
        | undefined
      const parts = content?.parts
      if (Array.isArray(parts)) texts.push(...parts.map(partText).filter(Boolean))
    }
    if (texts.length) return texts.join("\n")
  }
  const text = (response as Record<string, unknown>).text
  return typeof text === "string" ? text : null
}

/**
 * Rewrite `contents` with the redacted text.
 *
 * The system instruction lives in `config` and is not rewritten here, so a
 * redaction that only fired on it returns null and `base.ts` fails safe to a
 * block rather than forwarding text we were told to remove.
 */
export function applyRedactionToArgs(args: unknown[], redacted: GuardMessage[]): unknown[] | null {
  const body = redacted.filter((m) => m.role !== "system")
  if (!body.length) return null
  const request = (args[0] ?? {}) as Record<string, unknown>
  return [
    {
      ...request,
      contents: body.map((m) => ({ role: m.role ?? "user", parts: [{ text: m.content }] })),
    },
    ...args.slice(1),
  ]
}

// -- Apply / revert ----------------------------------------------------------

const WRAPPED_METHODS = ["generateContent", "generateContentStream"]

function wrapModels(models: Record<string, unknown> | undefined): void {
  if (!models) return
  for (const method of WRAPPED_METHODS) {
    const original = models[method]
    if (typeof original !== "function") continue
    models[method] = createPatchedMethod((original as (...a: unknown[]) => unknown).bind(models), {
      framework: NAME,
      extractMessages: (a: unknown[]) => extractMessages(a),
      extractResponseText,
      applyRedaction: applyRedactionToArgs,
    })
  }
}

/** An ES module namespace object (read-only exports), as opposed to `module.exports`. */
function isModuleNamespace(mod: unknown): boolean {
  return Object.prototype.toString.call(mod) === "[object Module]"
}

/** The ES module build: catch the constructor's `this.models = ...` assignment. */
function hookModelsAssignment(proto: object): boolean {
  const existing = Object.getOwnPropertyDescriptor(proto, "models")
  // Ours already, or a real accessor of the SDK's that must not be clobbered.
  if (existing) return Boolean(existing.set && MODELS_HOOK in existing.set)
  const set = function (this: object, models: unknown): void {
    wrapModels(models as Record<string, unknown> | undefined)
    Object.defineProperty(this, "models", {
      value: models,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
  Object.defineProperty(set, MODELS_HOOK, { value: true })
  Object.defineProperty(proto, "models", { get: () => undefined, set, configurable: true })
  return true
}

function unhookModelsAssignment(proto: object): void {
  const existing = Object.getOwnPropertyDescriptor(proto, "models")
  if (existing?.set && MODELS_HOOK in existing.set) {
    Reflect.deleteProperty(proto, "models")
  }
}

export function apply(load: ModuleLoader = requireCjs): boolean {
  let mod: Record<string, unknown>
  try {
    mod = load(PACKAGE) as Record<string, unknown>
  } catch {
    return false
  }

  const Original = mod?.GoogleGenAI as (new (...args: unknown[]) => unknown) | undefined
  if (typeof Original !== "function") return false

  if (isModuleNamespace(mod)) return hookModelsAssignment(Original.prototype)

  if (patched) return true

  const descriptor = Object.getOwnPropertyDescriptor(mod, "GoogleGenAI")
  if (descriptor && descriptor.writable === false && descriptor.configurable === false) return false

  class PatchedGoogleGenAI extends (Original as new (
    ...args: unknown[]
  ) => Record<string, unknown>) {
    constructor(...args: unknown[]) {
      super(...args)
      wrapModels(this.models as Record<string, unknown> | undefined)
    }
  }

  try {
    Object.defineProperty(mod, "GoogleGenAI", {
      value: PatchedGoogleGenAI,
      writable: true,
      configurable: true,
    })
  } catch {
    return false
  }

  originalConstructor = Original
  patched = true
  return true
}

export function revert(load: ModuleLoader = requireCjs): void {
  let mod: Record<string, unknown>
  try {
    mod = load(PACKAGE) as Record<string, unknown>
  } catch {
    // Package went away between apply() and revert(); nothing to restore.
    return
  }
  if (isModuleNamespace(mod)) {
    const Ctor = mod?.GoogleGenAI as { prototype?: object } | undefined
    if (Ctor?.prototype) unhookModelsAssignment(Ctor.prototype)
    return
  }
  if (!patched) return
  try {
    Object.defineProperty(mod, "GoogleGenAI", {
      value: originalConstructor,
      writable: true,
      configurable: true,
    })
  } catch {
    // Not redefinable any more; nothing to restore.
  }
  originalConstructor = null
  patched = false
}
