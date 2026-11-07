#!/usr/bin/env bash
# Everything a commit must pass. Needs pico on the PATH, Node, and `npm install` in generator/
# and oracle/; MAPPINGS points at a mavlink-mappings checkout (default: ../../mavlink-mappings,
# next to this repository's parent).
set -euo pipefail
cd "$(dirname "$0")/.."
mappings="${MAPPINGS:-$PWD/../../mavlink-mappings}"

echo "==> generated dialects are up to date"
node generator/generate.mjs "$mappings" > /dev/null
pico fmt src/dialects > /dev/null
git diff --exit-code --stat -- src/dialects

echo "==> generated dialects match mavlink-mappings"
node oracle/check-mappings.mjs

echo "==> interop fixtures from node-mavlink are up to date"
node oracle/interop.mjs > /dev/null
pico fmt src/interop.test.pi > /dev/null
git diff --exit-code --stat -- src/interop.test.pi

echo "==> pico fmt and lint (hand-written code; the dialects keep mavlink-mappings' names)"
pico fmt --check src/*.pi spike
pico lint src/*.pi spike

echo "==> pico test"
pico test "$PWD"
echo "==> all checks passed"
