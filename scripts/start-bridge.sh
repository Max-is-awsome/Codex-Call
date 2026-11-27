#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# The .env file is read by Node, never executed as shell code.
exec "${NODE_BIN:-node}" scripts/start.mjs
