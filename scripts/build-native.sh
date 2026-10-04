#!/usr/bin/env bash
# Builds the macOS CoreText subtitle helper (bin/subpng) from scripts/subpng.swift.
# Needs the Xcode command line tools (xcode-select --install). macOS only.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v swiftc >/dev/null; then
  echo "swiftc not found. Install the Xcode command line tools: xcode-select --install" >&2
  exit 1
fi
mkdir -p bin
swiftc -O scripts/subpng.swift -o bin/subpng
echo "built bin/subpng"
