#!/bin/sh
# Maintainer command only. Committed assets keep normal builds font/toolchain independent.
set -eu
if [ "$(uname -s)" != Darwin ]; then
  printf '%s\n' 'Goga icon generation requires macOS.' >&2
  exit 1
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/goga-icon-build.XXXXXXXX")
trap 'rm -rf "$temporary"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$temporary/modules" "$temporary/render"
# Compile explicitly: Swift JIT does not consistently link the AppKit font symbols.
/usr/bin/swiftc -module-cache-path "$temporary/modules" -framework AppKit \
  "$root/scripts/generate-icon.swift" -o "$temporary/render-icon"
"$temporary/render-icon" "$temporary/render"
