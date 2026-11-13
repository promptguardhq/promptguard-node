/**
 * Auto-instrumentation for PromptGuard (Node.js).
 *
 * Call {@link init} once at application startup to automatically
 * secure **all** LLM calls made through popular SDKs - regardless of
 * which framework (LangChain.js, Vercel AI SDK, etc.) sits on top.
 *
 * @example
 * ```ts
 * import { init } from 'promptguard-sdk/auto';
 *
 * init({ apiKey: 'pg_live_xxx' });
 *
 * // Everything below is now secured transparently.
 * import OpenAI from 'openai';
 * const client = new OpenAI();
 * await client.chat.completions.create({ ... }); // ← scanned by PromptGuard
 * ```
 */

import { GuardClient } from "./guard"
import { type LogLevel, logger, setLogLevel } from "./logger"
import { resolveCredentials } from "./resolve"

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let guardClient: GuardClient | null = null
let mode: "enforce" | "monitor" = "enforce"
let failOpen = true
let scanResponses = false

const appliedPatches: Array<{ name: string; revert: () => void }> = []

/**
 * ES module builds. A provider that ships separate CommonJS and ES module
 * builds has two copies of every class: `init()` patches the CommonJS copy,
 * and an ES module app's `import OpenAI from "openai"` uses the other one.
 *
 * `esmPatched` holds the patches the `register` entry applied to the ES module
 * copies (`node --import promptguard-sdk/register app.js`). They stay in place
 * for the life of the process: without a Guard client (before `init()`, after
 * `shutdown()`) a patched method calls straight through.
 *
 * `esmUnpatched` holds the patches whose ES module copy is in use but was not
 * patched, decided by `init()`. They are left out of `getAppliedPatches()`, so
 * a startup check on it fails instead of passing while calls go unscanned.
 */
const esmPatched = new Set<string>()
const esmUnpatched = new Map<string, string>()
let esmRegisterRan = false

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InitOptions {
  apiKey?: string
  baseUrl?: string
  /** `"enforce"` blocks violations, `"monitor"` logs only (default: `"enforce"`). */
  mode?: "enforce" | "monitor"
  /** Allow LLM calls when Guard API is unreachable (default: `true`). */
  failOpen?: boolean
  /** Also scan LLM responses (default: `false`). */
  scanResponses?: boolean
  /** HTTP timeout in ms for Guard API calls (default: `10000`). */
  timeout?: number
  /**
   * Retry attempts for transient Guard API failures (network errors and
   * 429/5xx responses) before the `failOpen` policy governs. Default: `3`.
   * Retries never change the eventual decision, see {@link GuardClientConfig}.
   */
  maxRetries?: number
  /** Base delay in ms between Guard API retries (exponential backoff). Default: `1000`. */
  retryDelay?: number
  /**
   * SDK log verbosity (default: `"warn"`). Set to `"silent"` to suppress all
   * SDK logging, or `"info"`/`"debug"` for the init banner and more detail.
   * NOTE: this sets the **process-global** SDK log level (shared with the
   * framework integrations); the most recent setter wins.
   */
  logLevel?: LogLevel
  /** Convenience shorthand for `logLevel: "silent"`. */
  silent?: boolean
}

/**
 * Initialise PromptGuard auto-instrumentation.
 *
 * Patches the provider SDKs (`openai`, `@anthropic-ai/sdk`,
 * `@google/generative-ai`, `cohere-ai`, `@aws-sdk/client-bedrock-runtime`)
 * so every LLM call they make is scanned by the Guard API.
 *
 * **ES module apps:** `init()` patches the providers' CommonJS builds. A
 * provider that also ships an ES module build (`openai`, `@anthropic-ai/sdk`,
 * `@google/genai`, `@google/generative-ai`) has a second copy of its classes,
 * the one a native ES module app's `import` gets. Start Node with
 * `node --import promptguard-sdk/register app.js` to patch those copies too.
 * Without it, `init()` warns for each such provider and
 * {@link getAppliedPatches} leaves it out. See README "ES module apps".
 *
 * When zero patches could be applied, a warning is logged so a
 * misconfiguration never fails silently.
 */
export function init(options: InitOptions = {}): void {
  if (options.silent) {
    setLogLevel("silent")
  } else if (options.logLevel) {
    setLogLevel(options.logLevel)
  }

  const { apiKey, baseUrl } = resolveCredentials(options.apiKey, options.baseUrl)

  const resolvedMode = options.mode ?? "enforce"
  if (resolvedMode !== "enforce" && resolvedMode !== "monitor") {
    throw new Error(`mode must be 'enforce' or 'monitor', got '${resolvedMode}'`)
  }

  guardClient = new GuardClient({
    apiKey,
    baseUrl,
    timeout: options.timeout ?? 10_000,
    maxRetries: options.maxRetries,
    retryDelay: options.retryDelay,
  })

  mode = resolvedMode
  failOpen = options.failOpen ?? true
  scanResponses = options.scanResponses ?? false

  applyPatches()

  // One-line confirmation of which provider SDKs are actually protected.
  // Suppressed by default (info level); set logLevel: "info" to see it, or
  // read the same list programmatically via getAppliedPatches(). When ZERO
  // patches applied, applyPatches() already logged a warn (visible by default).
  const protecting = getAppliedPatches()
  logger.info(
    `auto-instrumentation initialised (mode=${mode}, fail_open=${failOpen}), ` +
      `protecting: ${protecting.length ? protecting.join(", ") : "none"}`,
  )
}

export function shutdown(): void {
  for (const patch of appliedPatches) {
    try {
      patch.revert()
    } catch {
      // best-effort
    }
  }
  appliedPatches.length = 0
  guardClient = null
}

// ---------------------------------------------------------------------------
// Accessors (used by patches)
// ---------------------------------------------------------------------------

export function getGuardClient(): GuardClient | null {
  return guardClient
}

export function getMode(): "enforce" | "monitor" {
  return mode
}

export function isFailOpen(): boolean {
  return failOpen
}

export function shouldScanResponses(): boolean {
  return scanResponses
}

/**
 * Runtime canary: the names of the auto-instrumentation patches that were
 * actually applied by {@link init} (e.g. `["openai", "anthropic"]`).
 *
 * A provider is left out when an ES module app uses the provider's separate
 * ES module build and that build is not patched (Node was not started with
 * `--import promptguard-sdk/register`); `init()` warns about it too. Assert on
 * this at startup when you rely on enforce mode:
 *
 * @example
 * ```ts
 * init({ apiKey: "pg_live_xxx" });
 * if (!getAppliedPatches().includes("openai")) {
 *   throw new Error("PromptGuard did not patch the openai SDK");
 * }
 * ```
 */
export function getAppliedPatches(): string[] {
  return appliedPatches.map((p) => p.name).filter((name) => !esmUnpatched.has(name))
}

// ---------------------------------------------------------------------------
// Patch orchestration
// ---------------------------------------------------------------------------

/**
 * Every patch module, with the packages each one can hook.
 *
 * `detects` is what lets `init()` tell "the customer does not use this
 * provider" apart from "the customer uses it and we failed to hook it". Those
 * two used to look identical, so a customer with `openai` and `@google/genai`
 * installed saw a healthy startup and had no idea their Gemini traffic was
 * unscanned.
 */
const PATCH_MODULES = [
  { name: "openai", path: "./patches/openai", detects: ["openai"] },
  { name: "anthropic", path: "./patches/anthropic", detects: ["@anthropic-ai/sdk"] },
  { name: "google-genai", path: "./patches/google-genai", detects: ["@google/genai"] },
  { name: "google-generativeai", path: "./patches/google", detects: ["@google/generative-ai"] },
  { name: "cohere", path: "./patches/cohere", detects: ["cohere-ai"] },
  { name: "bedrock", path: "./patches/bedrock", detects: ["@aws-sdk/client-bedrock-runtime"] },
]

/**
 * Packages we know about and deliberately do NOT hook, with the same advice.
 *
 * Every one works today through the proxy, point the client's base URL at
 * PromptGuard. Listing them is not a promise to hook them; it is the difference
 * between telling a customer "not instrumented, here is the one-line fix" and
 * telling them nothing while they believe they are covered.
 *
 * Frameworks are deliberately absent. LangChain's ChatOpenAI calls the `openai`
 * package underneath, which we patch, so its traffic is scanned transitively,
 * warning about it would be a false alarm that trains people to ignore the real
 * ones.
 */
const KNOWN_UNPATCHED = [
  // VERIFIED 2026-08-11, not assumed: `@ai-sdk/openai` 4.0.36 declares only
  // `@ai-sdk/provider` and `@ai-sdk/provider-utils` as dependencies. It does
  // NOT use the `openai` package, so it makes its own HTTP calls and our
  // `openai` patch never sees them. The Vercel AI SDK is covered by the proxy
  // and by nothing else, which is the opposite of what we told people.
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
  "@ai-sdk/google",
  "groq-sdk",
  "@mistralai/mistralai",
  "together-ai",
  "ollama",
  "@google-cloud/aiplatform",
  "@aws-sdk/client-bedrock-agent-runtime",
]

const ADVICE_URL = "https://docs.promptguard.co/integrations/auto-instrumentation"
const ESM_ADVICE_URL = "https://github.com/promptguardhq/promptguard-node#es-module-apps"

function isInstalled(pkg: string): boolean {
  try {
    require.resolve(pkg)
    return true
  } catch {
    return false
  }
}

/** Provider packages that are installed but are NOT being scanned. */
/**
 * Every provider-patch name this SDK is capable of reporting in `patched`.
 *
 * Not re-exported from `index.ts`: the package's public surface is unchanged,
 * and this mirrors the Python SDK's private `_known_patches()`. It exists so
 * the cross-SDK contract's `instrumentation_introspection` section can assert
 * that both SDKs name the same providers, they did not, until v1.6.0 of the
 * contract: this SDK reported `bedrock` while Python reported `boto3-bedrock`.
 */
export function knownPatchNames(): string[] {
  return PATCH_MODULES.map((m) => m.name)
}

export function detectedUnpatched(): string[] {
  const hooked = new Set(getAppliedPatches())
  const found: string[] = []

  for (const mod of PATCH_MODULES) {
    if (hooked.has(mod.name)) continue
    for (const pkg of mod.detects) if (isInstalled(pkg)) found.push(pkg)
  }
  for (const pkg of KNOWN_UNPATCHED) if (isInstalled(pkg)) found.push(pkg)

  return [...new Set(found)].sort()
}

/**
 * What is and is not instrumented, as data rather than a log line.
 *
 * A startup warning is only read by whoever is watching at startup. The same
 * facts in this form can be asserted in the caller's own CI:
 *
 * ```ts
 * expect(instrumentationReport().detectedUnpatched).toEqual([])
 * ```
 *
 * which turns "we told you" into "you cannot ship without knowing".
 */
export function instrumentationReport(): {
  patched: string[]
  detectedUnpatched: string[]
  middleware: string[]
  adviceUrl: string
} {
  return {
    patched: getAppliedPatches(),
    detectedUnpatched: detectedUnpatched(),
    // Request-edge middleware alive in the process (cross-SDK contract v1.7.0).
    // The Python SDK's ASGI/FastAPI middleware reports `fastapi`; this SDK has
    // no such middleware yet, so the list is always empty rather than absent,
    // and a cross-language health check reads the same key in both.
    middleware: [],
    adviceUrl: ADVICE_URL,
  }
}

// ---------------------------------------------------------------------------
// ES module builds
// ---------------------------------------------------------------------------

type PatchModule = {
  apply: (load?: (specifier: string) => unknown) => boolean
  revert: (load?: (specifier: string) => unknown) => void
  SPECIFIERS?: string[]
}

function loadPatchModule(path: string): PatchModule {
  return require(path) as PatchModule
}

/** Conditions Node matches for `import` and for `require()`, in this process. */
function resolutionConditions(kind: "import" | "require"): string[] {
  // Node 22.10+ (`require(esm)`) matches `module-sync` for both, which gives
  // both the same file and so no second copy.
  const sync = (process.features as { require_module?: boolean }).require_module
    ? ["module-sync"]
    : []
  return ["node", kind, ...sync, "default"]
}

/** The target a package.json `exports` field gives "." under `conditions`. */
function exportTarget(exp: unknown, conditions: string[]): string | undefined {
  if (typeof exp === "string") return exp
  if (Array.isArray(exp)) {
    for (const entry of exp) {
      const target = exportTarget(entry, conditions)
      if (target !== undefined) return target
    }
    return undefined
  }
  if (!exp || typeof exp !== "object") return undefined
  const map = exp as Record<string, unknown>
  if (Object.keys(map).some((k) => k.startsWith("."))) return exportTarget(map["."], conditions)
  for (const [key, value] of Object.entries(map)) {
    if (!conditions.includes(key)) continue
    const target = exportTarget(value, conditions)
    if (target !== undefined) return target
  }
  return undefined
}

/** The installed package's package.json, found from its resolved entry. */
function readPackageJson(pkg: string): { name?: string; exports?: unknown } | null {
  const path = require("node:path")
  const { existsSync, readFileSync } = require("node:fs")
  let dir: string
  try {
    dir = path.dirname(require.resolve(pkg))
  } catch {
    return null
  }
  for (;;) {
    const file = path.join(dir, "package.json")
    if (existsSync(file)) {
      try {
        const json = JSON.parse(readFileSync(file, "utf-8"))
        if (json?.name === pkg) return json
      } catch {
        return null
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Whether `import pkg` loads a different file from `require(pkg)`, so the
 * package has an ES module copy of its classes that `init()` does not reach.
 * A package without `exports` gives `import` its `main`, the same file.
 */
function hasSeparateEsmBuild(pkg: string): boolean {
  const known = separateEsmBuild.get(pkg)
  if (known !== undefined) return known
  const json = readPackageJson(pkg)
  const esm = exportTarget(json?.exports, resolutionConditions("import"))
  const cjs = exportTarget(json?.exports, resolutionConditions("require"))
  const separate = esm !== undefined && cjs !== undefined && esm !== cjs
  separateEsmBuild.set(pkg, separate)
  return separate
}

/** Per package, {@link hasSeparateEsmBuild}: fixed for the life of the process. */
const separateEsmBuild = new Map<string, boolean>()

/**
 * The module specifiers the `register` entry imports: those of every patch
 * whose provider is installed and ships a separate ES module build. Internal,
 * for `register.mts`; not exported from the package root.
 */
export function esmPatchPlan(): string[] {
  const specifiers: string[] = []
  for (const mod of PATCH_MODULES) {
    if (!mod.detects.some((pkg) => isInstalled(pkg) && hasSeparateEsmBuild(pkg))) continue
    try {
      specifiers.push(...(loadPatchModule(mod.path).SPECIFIERS ?? []))
    } catch {
      // A patch module that fails to load is reported by init(), not here.
    }
  }
  return specifiers
}

/**
 * Patch the ES module builds the `register` entry loaded, keyed by the
 * specifiers {@link esmPatchPlan} returned. Internal, for `register.mts`.
 */
export function applyEsmPatches(loaded: Map<string, unknown>): void {
  esmRegisterRan = true
  const load = (specifier: string): unknown => {
    if (!loaded.has(specifier)) throw new Error(`${specifier} was not imported`)
    return loaded.get(specifier)
  }
  for (const mod of PATCH_MODULES) {
    try {
      if (loadPatchModule(mod.path).apply(load)) esmPatched.add(mod.name)
    } catch (err: unknown) {
      logger.debug(
        `${mod.name} ES module patch not applied: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

/**
 * Whether the process entry point is an ES module. An ES module entry file
 * leaves `require.main` undefined, but so do `node -e` and the REPL, which
 * have no entry file (`process.argv[1]`) and run CommonJS unless told
 * `--input-type=module`.
 */
function entryIsEsm(): boolean {
  if (require.main !== undefined) return false
  return process.argv[1] !== undefined || process.execArgv.includes("--input-type=module")
}

/**
 * Per package: whether the app had loaded its CommonJS build before the first
 * `init()` (the `createRequire` workaround), which means the app uses the copy
 * `init()` patches. Decided once, before this SDK requires it itself.
 */
const cjsLoadedByApp = new Map<string, boolean>()

function noteCjsLoadedByApp(): void {
  for (const mod of PATCH_MODULES) {
    for (const pkg of mod.detects) {
      if (cjsLoadedByApp.has(pkg)) continue
      try {
        cjsLoadedByApp.set(pkg, require.resolve(pkg) in require.cache)
      } catch {
        // Not installed; nothing to decide.
      }
    }
  }
}

/**
 * The package whose unpatched ES module build an ES module app would get from
 * `import`, if any. Whether the app imports it at all cannot be seen from here,
 * so the warning says what is known: the app is an ES module and the package
 * ships an ES module build.
 */
function esmGap(mod: (typeof PATCH_MODULES)[number]): string | undefined {
  if (esmPatched.has(mod.name) || !entryIsEsm()) return undefined
  return mod.detects.find((pkg) => !cjsLoadedByApp.get(pkg) && hasSeparateEsmBuild(pkg))
}

function warnAboutEsmGap(pkg: string): void {
  const fix = esmRegisterRan
    ? "The --import promptguard-sdk/register entry ran but could not patch it; " +
      "load it through createRequire() or point that client at the proxy."
    : "Start Node with: node --import promptguard-sdk/register app.js"
  logger.warn(
    `PromptGuard: this app is an ES module and '${pkg}' ships a separate ES module build, ` +
      `which init() does not patch, so calls made through \`import ... from '${pkg}'\` are ` +
      `NOT being scanned. ${fix} See ${ESM_ADVICE_URL}`,
  )
}

function warnAboutUnpatchedLibraries(): void {
  const esmWarned = new Set(esmUnpatched.values())
  for (const pkg of detectedUnpatched()) {
    if (esmWarned.has(pkg)) continue
    logger.warn(
      `PromptGuard: '${pkg}' is installed but auto-instrumentation did NOT hook it, ` +
        `calls made through it are not being scanned. Point that client at the proxy ` +
        `(set its base URL to your PromptGuard endpoint), or see ${ADVICE_URL} for the ` +
        `exact call surfaces we patch.`,
    )
  }
}

function applyPatches(): void {
  noteCjsLoadedByApp()
  esmUnpatched.clear()

  for (const mod of PATCH_MODULES) {
    try {
      const patchModule = loadPatchModule(mod.path)
      if (patchModule.apply()) {
        // apply() is idempotent per patch module, so a second init() without
        // shutdown() reports "already patched" success. Skip the push when
        // the patch is already tracked, a duplicate entry would make the
        // getAppliedPatches() canary lie and call revert() twice on
        // shutdown().
        if (!appliedPatches.some((p) => p.name === mod.name)) {
          appliedPatches.push({ name: mod.name, revert: () => patchModule.revert() })
        }
        const gap = esmGap(mod)
        if (gap !== undefined) {
          esmUnpatched.set(mod.name, gap)
          warnAboutEsmGap(gap)
        }
      } else {
        logger.debug(
          `${mod.name} patch not applied: SDK not resolvable via require() ` +
            `(not installed, or only reachable as ESM)`,
        )
      }
    } catch (err: unknown) {
      logger.debug(
        `${mod.name} patch not applied: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  warnAboutUnpatchedLibraries()

  if (appliedPatches.length === 0) {
    logger.warn(
      "init() applied ZERO auto-instrumentation patches, no supported LLM SDK was " +
        "resolvable via CommonJS require(), so NO calls are being scanned. If your app " +
        'runs as native ESM ("type": "module" / .mjs), start Node with ' +
        "node --import promptguard-sdk/register app.js, or use the LangChain callback " +
        "handler, the Vercel AI SDK middleware, or explicit GuardClient.scan() calls. " +
        'See README "ES module apps". Set logLevel: "debug" for per-SDK reasons.',
    )
  }
}
