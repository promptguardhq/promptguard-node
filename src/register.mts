/**
 * Auto-instrumentation for ES module apps:
 *
 * ```bash
 * node --import promptguard-sdk/register app.js
 * ```
 *
 * `init()` patches the providers' CommonJS builds. A provider that also ships
 * an ES module build has a second copy of its classes, the one a native ES
 * module app's `import OpenAI from "openai"` gets. This entry imports those ES
 * module builds before the app starts and patches them, so the app's own
 * imports are scanned once it calls `init()`. Top-level await makes Node
 * finish the patching before the app's first module runs.
 *
 * It patches; it does not initialise. The app still calls `init()`, and until
 * it does, a patched method calls straight through.
 */

import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { applyEsmPatches, esmPatchPlan } = require("./auto.js") as {
  applyEsmPatches: (loaded: Map<string, unknown>) => void
  esmPatchPlan: () => string[]
}

const loaded = new Map<string, unknown>()
for (const specifier of esmPatchPlan()) {
  try {
    loaded.set(specifier, await import(specifier))
  } catch {
    // Absent in this provider version (an older openai has no Responses API);
    // the patch reports what it could not reach.
  }
}
applyEsmPatches(loaded)
