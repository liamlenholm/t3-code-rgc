#!/usr/bin/env bash
# Builds the fork's macOS desktop app (unsigned DMG) on a Mac.
#
# The app's version picks the server runtime it launches over SSH, so it must match the
# runtime built on the remote with scripts/fork/build-linux-runtime.sh (both read
# apps/server/package.json). Local builds have no update feed, so the app never
# auto-updates back to the official release.
#
# Prerequisites: Xcode command line tools, Node 24 (corepack enabled), rustup with
# the target for your Mac (`rustup target add aarch64-apple-darwin`).
#
# Usage: scripts/fork/build-mac.sh
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"

case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "Unsupported Mac architecture: $(uname -m)" >&2; exit 1 ;;
esac

version="$(node -p 'require("./apps/server/package.json").version')"

echo "==> Installing dependencies"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile
export PATH="$repo/node_modules/.bin:$PATH"

# Either variable would configure an update feed pointing at a GitHub repo's releases.
unset GITHUB_REPOSITORY T3CODE_DESKTOP_UPDATE_REPOSITORY

echo "==> Building T3 Code $version for mac-$arch"
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch "$arch" \
  --build-version "$version" --verbose

echo
echo "Built: $(ls -t release/*.dmg | head -1)"
echo "Quit the official T3 Code app, then install this DMG over it."
