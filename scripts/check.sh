#!/usr/bin/env bash
# The local gate: what .github/workflows/ci.yml runs, as one command. Run it
# before you hand back a change; the pre-push hook runs it too.
#
#   bash scripts/check.sh
#
# Not covered: CI's API-contract job, which fetches the published spec over
# the network. Needs `npm ci` first.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
step() { printf '==> %s\n' "$*"; }

step "GitHub holds no secrets; agent files load and resolve; no em or en dashes"
python3 scripts/check_no_github_secrets.py --check
python3 scripts/check_agent_files.py --check
python3 scripts/check_no_dashes.py --check

step "architecture fitness: zero runtime deps, lazy peers, integration layering"
node scripts/check-architecture.mjs

step "lint: biome + tsc"
npx biome check .
npx tsc --noEmit
step "tests"
npm test --silent
step "build, pack"
npm run build --silent
npm pack --dry-run >/dev/null
npm run test:pack --silent
echo "check: all passed"
