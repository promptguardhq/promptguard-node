/**
 * Shared patch wrapper: the single place where pre-call scan,
 * block/redact handling, original call, and post-call scan live.
 *
 * Every SDK-specific patch provides a {@link PatchConfig} describing
 * how to extract messages and responses; this module handles the rest.
 */

import {
  GuardApiError,
  type GuardClient,
  type GuardMessage,
  PromptGuardBlockedError,
  safeErrorLabel,
} from "../guard"
import { logger } from "../logger"

export interface PatchConfig {
  framework: string
  /**
   * The call's messages and model, and the Conversation it belongs to when
   * the provider API names one (`sessionId`, sent as `context.session_id`).
   */
  extractMessages: (
    args: unknown[],
    thisArg: unknown,
  ) => { messages: GuardMessage[]; model?: string; sessionId?: string }
  extractResponseText?: (response: unknown, args: unknown[]) => string | null
  /**
   * Rewrite the call args with the redacted message contents.
   * Return `null` when the message shape cannot be redacted safely, in
   * enforce mode that escalates the redact decision to a block.
   */
  applyRedaction?: (args: unknown[], redactedMessages: GuardMessage[]) => unknown[] | null
  shouldIntercept?: (args: unknown[], thisArg: unknown) => boolean
}

/**
 * How a patch loads the provider module it hooks: `require` for the CommonJS
 * build (what `init()` patches), or a lookup into modules that the `register`
 * entry already loaded with `import()`, for the ES module build. A provider
 * that ships both builds has two copies of every class, and each needs its
 * own patch.
 */
export type ModuleLoader = (specifier: string) => unknown

/**
 * Marks a wrapper with the method it replaced. The marker is the patch state:
 * it is what makes wrapping idempotent per class (the CommonJS and ES module
 * copies of a class are wrapped independently, and the same copy is never
 * wrapped twice) and what revert restores. `Symbol.for`, so a second copy of
 * this SDK in the process sees the first one's wrappers.
 */
const ORIGINAL = Symbol.for("promptguard-sdk.patched-original")

type Method = (...args: unknown[]) => unknown

/** `module[exportName].prototype`, or undefined when any step is missing. */
export function loadPrototype(
  load: ModuleLoader,
  specifier: string,
  exportName: string,
): object | undefined {
  try {
    const mod = load(specifier) as Record<string, { prototype?: object } | undefined> | undefined
    return mod?.[exportName]?.prototype
  } catch {
    return undefined
  }
}

/**
 * Replace `owner[key]` with a scanning wrapper, once. Returns whether
 * `owner[key]` is wrapped afterwards (false when there is no such method).
 */
export function wrapMethod(owner: object | undefined, key: string, config: PatchConfig): boolean {
  if (!owner) return false
  const target = owner as Record<string, unknown>
  const current = target[key]
  if (typeof current !== "function") return false
  if (ORIGINAL in current) return true
  const wrapped = createPatchedMethod(current as Method, config)
  Object.defineProperty(wrapped, ORIGINAL, { value: current })
  target[key] = wrapped
  return true
}

/** Restore what {@link wrapMethod} replaced; a no-op when it is not wrapped. */
export function unwrapMethod(owner: object | undefined, key: string): void {
  if (!owner) return
  const target = owner as Record<string, unknown>
  const current = target[key] as (Method & { [ORIGINAL]?: Method }) | undefined
  if (typeof current === "function" && ORIGINAL in current) target[key] = current[ORIGINAL]
}

/**
 * Best-effort detection of streaming calls/results across the patched SDKs.
 *
 * Covers `{ stream: true }` request params (OpenAI/Anthropic/Cohere),
 * async-iterable results (OpenAI/Anthropic `Stream`), and Bedrock's
 * `ConverseStreamCommand` / `InvokeModelWithResponseStreamCommand`.
 */
function isStreaming(args: unknown[], response: unknown): boolean {
  const params = args[0] as Record<string, unknown> | undefined
  if (params && typeof params === "object") {
    if (params.stream === true) return true
    const commandName = (params.constructor as { name?: string } | undefined)?.name ?? ""
    if (commandName.includes("Stream")) return true
  }
  if (response && typeof response === "object" && Symbol.asyncIterator in response) return true
  return false
}

/**
 * Wrap an SDK method with pre-call (and optionally post-call) Guard scans.
 *
 * Known limitation: the wrapper is a plain `async` function, so SDK-specific
 * augmented promise types are not preserved. In particular the OpenAI SDK's
 * `APIPromise` helpers (`.withResponse()`, `.asResponse()`) are unavailable
 * on patched methods: `await` the call and use the plain result instead.
 * Output scanning (`scanResponses: true`) is also skipped for streaming
 * calls, since the stream is consumed incrementally by the caller; a debug
 * log is emitted when that happens. See README "Limitations".
 */
export function createPatchedMethod(
  original: (...args: unknown[]) => unknown,
  config: PatchConfig,
): (...args: unknown[]) => Promise<unknown> {
  return async function patched(this: unknown, ...args: unknown[]) {
    const { getGuardClient, getMode, isFailOpen, shouldScanResponses } = require("../auto")

    if (config.shouldIntercept && !config.shouldIntercept(args, this)) {
      return original.apply(this, args)
    }

    const guard: GuardClient | null = getGuardClient()
    if (!guard) return original.apply(this, args)

    const { messages, model, sessionId } = config.extractMessages(args, this)

    if (!messages.length) {
      // An intercepted call whose body we could not extract anything from
      // proceeds unscanned, say so instead of failing silently, since a
      // provider body shape we don't recognize is an enforcement gap.
      logger.debug(
        `[${config.framework}] intercepted call yielded no scannable messages; proceeding unscanned`,
      )
    }

    if (messages.length) {
      let decision = null

      try {
        decision = await guard.scan(messages, "input", model, {
          framework: config.framework,
          ...(sessionId !== undefined ? { sessionId } : {}),
        })
      } catch (err: unknown) {
        // Only the Guard API being unreachable is eligible for fail-open.
        // Any other error is a real bug and must surface.
        if (!(err instanceof GuardApiError)) throw err
        if (!isFailOpen()) throw err
        logger.warn(
          `Guard API unavailable, allowing request unscanned (failOpen=true): ${safeErrorLabel(err)}`,
        )
      }

      if (decision?.blocked) {
        if (getMode() === "enforce") throw new PromptGuardBlockedError(decision)
        logger.warn(`[monitor] would block: ${decision.threatType} (event=${decision.eventId})`)
      }

      if (decision?.redacted) {
        const redactedMessages = decision.redactedMessages ?? []
        // A redactedMessages list SHORTER than the scanned guard messages
        // would leave the unmatched trailing messages unredacted, the
        // per-SDK mappers silently keep original content for guard indices
        // past the end of the list. Treat a partial list like an
        // unredactable shape.
        const isPartial = redactedMessages.length < messages.length
        if (getMode() === "enforce") {
          // A redact decision with missing/empty/partial redactedMessages
          // cannot be honored either, treat it exactly like an
          // unredactable shape.
          const redactedArgs =
            redactedMessages.length && !isPartial && config.applyRedaction
              ? config.applyRedaction(args, redactedMessages)
              : null
          if (redactedArgs === null) {
            // Redaction cannot be applied to this call shape (or the Guard
            // API returned no/partial redacted messages). Sending the
            // unredacted content would silently leak what the Guard API
            // asked us to redact, so escalate to a block in enforce mode.
            logger.error(
              `redact decision could not be applied for ${config.framework}` +
                (isPartial
                  ? ` (${redactedMessages.length} redacted messages for ${messages.length} scanned)`
                  : "") +
                `; escalating to block (event=${decision.eventId})`,
            )
            throw new PromptGuardBlockedError(decision)
          }
          args = redactedArgs
        } else {
          logger.warn(
            `[monitor] would redact: content passed through unredacted` +
              (isPartial
                ? ` (partial: ${redactedMessages.length} redacted messages for ${messages.length} scanned)`
                : "") +
              ` (event=${decision.eventId})`,
          )
        }
      }
    }

    const response = await original.apply(this, args)

    if (shouldScanResponses() && response && guard && config.extractResponseText) {
      if (isStreaming(args, response)) {
        // Streaming bodies are consumed incrementally by the caller; we
        // cannot buffer them here without breaking stream semantics.
        logger.debug(
          `output scanning skipped for streaming response (framework=${config.framework})`,
        )
        return response
      }
      try {
        const text = config.extractResponseText(response, args)
        if (text) {
          const respDecision = await guard.scan(
            [{ role: "assistant", content: text }],
            "output",
            model,
          )
          if (respDecision.blocked || respDecision.redacted) {
            // A response cannot be rewritten after the fact, so an
            // output-direction redact decision is enforced as a block
            // (mirrors the framework integrations).
            if (getMode() === "enforce") {
              throw new PromptGuardBlockedError(respDecision)
            }
            logger.warn(
              `[monitor] would ${respDecision.redacted ? "redact" : "block"} response: ${respDecision.threatType}`,
            )
          }
        }
      } catch (err: unknown) {
        if (err instanceof PromptGuardBlockedError) throw err
        // Only swallow Guard API outages under fail-open; surface real bugs.
        if (!(err instanceof GuardApiError)) throw err
        if (!isFailOpen()) throw err
        logger.warn(
          `Guard API unavailable, response left unscanned (failOpen=true): ${safeErrorLabel(err)}`,
        )
      }
    }

    return response
  }
}
