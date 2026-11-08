#!/usr/bin/env node
/**
 * Architecture fitness check: mechanical rules about the shape of `src/`,
 * the ones lint cannot see because they are about which file may depend on
 * which, not about any one line.
 *
 * Each rule restates something AGENTS.md or the code already promises:
 *
 *   1. Zero runtime dependencies. package.json has no `dependencies` (nor
 *      `optionalDependencies`, which npm also installs).
 *   2. Provider and framework SDKs are optional peers. Every
 *      `peerDependencies` entry is `optional: true` in `peerDependenciesMeta`.
 *   3. No value import of a package at module scope. Outside Node built-ins,
 *      `src/` may only `import type` from a package (erased by tsc); a value
 *      import would make `require("promptguard-sdk")` throw for anyone who
 *      has not installed that peer.
 *   4. Peers are loaded lazily. A `require()` or `import()` of a package must
 *      sit inside a function, never at module top level, for the same reason.
 *   5. Layering. Integrations do not import each other (the shared
 *      `integrations/session` helper and an integration's own
 *      `<name>-*.ts` submodules are the exceptions); outside
 *      `src/integrations/` only the public entry `src/index.ts` imports an
 *      integration other than `session`; patches are loaded only lazily by
 *      `auto.ts`'s require table, so nothing outside `src/patches/` imports
 *      one statically, and a patch imports no sibling but `./base`.
 *
 *   node scripts/check-architecture.mjs
 *
 * Dependency-free on purpose: it runs before `npm ci` would matter, and a
 * fitness check that needs its own toolchain is one more thing to drift.
 * `src/generated/` is excluded: it is produced by the sync-from-api workflow.
 */

import { readdirSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SRC = path.join(ROOT, "src")
const BUILTINS = new Set(builtinModules)
const violations = []

function fail(where, rule, fix) {
  violations.push(`${where}: ${rule}\n    fix: ${fix}`)
}

// --- package.json ----------------------------------------------------------

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"))
for (const field of ["dependencies", "optionalDependencies"]) {
  const names = Object.keys(pkg[field] ?? {})
  if (names.length > 0) {
    fail(
      `package.json ${field}`,
      `the SDK has zero runtime dependencies, but ${field} lists ${names.join(", ")}`,
      "move a build or test tool to devDependencies; make a provider or framework SDK an " +
        "optional peerDependency loaded lazily; raise any genuine runtime dependency for " +
        "discussion first (AGENTS.md, Rules: Dependencies)",
    )
  }
}
for (const name of Object.keys(pkg.peerDependencies ?? {})) {
  if (pkg.peerDependenciesMeta?.[name]?.optional !== true) {
    fail(
      `package.json peerDependencies["${name}"]`,
      "every peer dependency must be optional, so installing the SDK never pulls in a provider",
      `add "${name}": { "optional": true } to peerDependenciesMeta`,
    )
  }
}

// --- source scan -----------------------------------------------------------

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return full === path.join(SRC, "generated") ? [] : walk(full)
    return entry.name.endsWith(".ts") ? [full] : []
  })
}

/**
 * Blank out comments (so JSDoc examples are not read as imports) and compute
 * the brace depth at every offset, skipping braces inside strings. Template
 * literal `${...}` nesting is not tracked; nothing here needs it.
 */
function scan(source) {
  const out = source.split("")
  const depth = new Int32Array(source.length + 1)
  let d = 0
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    depth[i] = d
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out[i] = " "
        depth[i++] = d
      }
      continue
    }
    if (c === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] !== "\n") out[i] = " "
        depth[i++] = d
      }
      out[i] = " "
      out[i + 1] = " "
      depth[i] = d
      depth[i + 1] = d
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      i++
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\") depth[i++] = d
        depth[i++] = d
      }
      depth[i++] = d
      continue
    }
    if (c === "{") d++
    else if (c === "}") d--
    i++
  }
  depth[source.length] = d
  return { code: out.join(""), depth }
}

const lineOf = (text, offset) => text.slice(0, offset).split("\n").length
const isRelative = (spec) => spec.startsWith(".")
const isBuiltin = (spec) => spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0])

const STATIC_IMPORT =
  /^[ \t]*(import|export)\s+(type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s*["']([^"']+)["']/gm
const SIDE_EFFECT_IMPORT = /^[ \t]*import\s*["']([^"']+)["']/gm
const DYNAMIC_LOAD = /\b(require|import)\s*\(\s*["']([^"']+)["']\s*\)/g

for (const file of walk(SRC)) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/")
  const fromSrc = path.relative(SRC, file).split(path.sep).join("/")
  const { code, depth } = scan(readFileSync(file, "utf8"))
  const at = (offset) => `${rel}:${lineOf(code, offset)}`

  const statics = []
  for (const m of code.matchAll(STATIC_IMPORT)) {
    statics.push({ offset: m.index, typeOnly: Boolean(m[2]), spec: m[3] })
  }
  for (const m of code.matchAll(SIDE_EFFECT_IMPORT)) {
    statics.push({ offset: m.index, typeOnly: false, spec: m[1] })
  }

  for (const { offset, typeOnly, spec } of statics) {
    if (!isRelative(spec)) {
      if (!typeOnly && !isBuiltin(spec)) {
        fail(
          at(offset),
          `value import of package "${spec}" at module scope; the SDK must load without it`,
          `use \`import type\` for its types and require("${spec}") inside the function ` +
            "that needs it, guarded so a missing peer is reported rather than thrown",
        )
      }
      continue
    }
    checkLayering(fromSrc, spec, at(offset), typeOnly)
  }

  for (const m of code.matchAll(DYNAMIC_LOAD)) {
    const spec = m[2]
    if (isRelative(spec) || isBuiltin(spec)) continue
    if (depth[m.index] === 0) {
      fail(
        at(m.index),
        `${m[1]}("${spec}") at module top level loads an optional peer eagerly`,
        `move ${m[1]}("${spec}") inside the function that needs it (see src/patches/*.ts)`,
      )
    }
  }
}

/** `fromSrc` is the importing file relative to src/, `spec` a relative specifier. */
function checkLayering(fromSrc, spec, where, typeOnly) {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromSrc), spec))
  const fromDir = path.posix.dirname(fromSrc)
  const fromBase = path.posix.basename(fromSrc, ".ts")

  if (target.startsWith("integrations/") && target !== "integrations/session") {
    const targetBase = path.posix.basename(target)
    if (fromDir === "integrations") {
      const ownSubmodule = targetBase.startsWith(`${fromBase}-`)
      if (!ownSubmodule && !typeOnly) {
        fail(
          where,
          `integration "${fromBase}" imports integration "${targetBase}"; integrations are independent`,
          "move the shared code into src/integrations/session.ts or a core module (guard, " +
            `logger, resolve), or name it ${fromBase}-<part>.ts if it belongs to ${fromBase} alone`,
        )
      }
    } else if (fromSrc !== "index.ts") {
      fail(
        where,
        `${fromSrc} imports ${target}; only src/index.ts re-exports integrations`,
        "core and patches must not depend on a framework integration: move the shared code " +
          "into a core module or src/integrations/session.ts",
      )
    }
  }

  if (target.startsWith("patches/")) {
    if (fromDir !== "patches") {
      fail(
        where,
        `${fromSrc} statically imports ${target}; patches are loaded lazily by auto.ts`,
        "add the patch to the require table in src/auto.ts instead of importing it",
      )
    } else if (target !== "patches/base") {
      fail(
        where,
        `patch ${fromSrc} imports ${target}; a patch may share code only through ./base`,
        "move the shared code into src/patches/base.ts",
      )
    }
  }
}

if (violations.length > 0) {
  console.error(`check-architecture: ${violations.length} violation(s)\n`)
  for (const v of violations) console.error(`  ${v}\n`)
  console.error("The rules and why they exist: the header of scripts/check-architecture.mjs.")
  process.exit(1)
}
console.log("check-architecture: ok")
