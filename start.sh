#!/bin/bash
# deepseek-bridge launcher
# Auto-detects the platform and ensures Node.js is on PATH before building
# and launching Electron.

set -e

# --- Platform-specific PATH setup ---
case "$(uname -s)" in
  Darwin)
    # macOS — Homebrew installs node to /opt/homebrew/bin (Apple Silicon)
    # or /usr/local/bin (Intel). Add both if they exist.
    if [ -d /opt/homebrew/bin ]; then
      export PATH="/opt/homebrew/bin:$PATH"
    fi
    if [ -d /usr/local/bin ]; then
      export PATH="/usr/local/bin:$PATH"
    fi
    ;;
  Linux)
    # Linux — node is typically on PATH already via apt/dnf/pacman.
    # If not, check common locations.
    for dir in /usr/local/bin /usr/bin; do
      if [ -d "$dir" ] && [ -x "$dir/node" ]; then
        export PATH="$dir:$PATH"
        break
      fi
    done
    ;;
  MINGW*|MSYS*|CYGWIN*)
    # Windows (Git Bash / MSYS2 / Cygwin) — npm/npx should be on PATH
    # via the Node.js Windows installer.
    ;;
esac

# Change to the directory containing this script (the project root).
cd "$(dirname "$0")"

# Build TypeScript then launch Electron with any extra args forwarded.
npm run build
npx electron . "$@"