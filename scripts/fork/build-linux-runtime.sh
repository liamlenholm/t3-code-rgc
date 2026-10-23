#!/usr/bin/env bash
# Builds the fork's Linux x64 server runtime and installs it where the desktop app's
# SSH launcher looks for it (~/.t3/runtime/versions/<version>), so a forked Mac app
# with the same version uses this build instead of downloading an official release.
#
# Usage: scripts/fork/build-linux-runtime.sh [--no-install]
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"
export PATH="$repo/node_modules/.bin:$PATH"

version="$(node -p 'require("./apps/server/package.json").version')"
archive="release-cli/t3-$version-linux-x64.tar.gz"
runtime_dir="$HOME/.t3/runtime/versions/$version"
monitor_stage="$(mktemp -d)"
trap 'rm -rf "$monitor_stage"' EXIT

echo "==> Building t3 $version (server + web)"
vp run --filter t3 build
node scripts/apply-web-brand-assets.ts production apps/server/dist/client

echo "==> Building single executable"
# Node's single-executable builder needs Node 25.7+ (CI pins 26.8.2, matching
# SEA_NODE_VERSION in apps/server/vite.config.ts); the repo itself stays on Node 24.
sea_node_version=26.8.2
if command -v fnm >/dev/null 2>&1; then
  fnm install "$sea_node_version" >/dev/null
  fnm exec --using="$sea_node_version" node apps/server/scripts/cli.ts build-exe
else
  node apps/server/scripts/cli.ts build-exe
fi

echo "==> Staging resource monitor"
mkdir -p "$monitor_stage/linux-x64"
if command -v cargo >/dev/null 2>&1; then
  cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml
  cp native/resource-monitor/target/release/t3-resource-monitor "$monitor_stage/linux-x64/"
else
  # The monitor is unchanged in this fork; reuse the one shipped with an official runtime.
  # Official releases have plain X.Y.Z versions; fork builds carry a prerelease suffix.
  existing="$(ls -d "$HOME"/.t3/runtime/versions/*/resource-monitor/linux-x64/t3-resource-monitor 2>/dev/null \
    | grep -E "/versions/[0-9]+\.[0-9]+\.[0-9]+/" | tail -1)"
  [ -n "$existing" ] || { echo "No cargo and no official runtime to copy the resource monitor from." >&2; exit 1; }
  cp "$existing" "$monitor_stage/linux-x64/"
fi

echo "==> Packing $archive"
node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$version" \
  --resource-monitor-dir "$monitor_stage" --output-dir release-cli
node scripts/smoke-cli-archive.ts --archive "$archive" --expect-version "$version"

if [ "${1:-}" = "--no-install" ]; then
  echo "Built $archive (not installed)."
  exit 0
fi

echo "==> Installing into $runtime_dir"
staging="$(mktemp -d "$HOME/.t3/runtime/versions/.staging-XXXXXX")"
tar -xzf "$archive" -C "$staging" --strip-components=1
"$staging/t3" --version
printf '%s\n' "$version" > "$staging/.install-complete"
if [ -d "$runtime_dir" ]; then
  # A running server keeps its open files; the next launch picks up the new build.
  mv "$runtime_dir" "$runtime_dir.old-$(date +%s)"
fi
mv "$staging" "$runtime_dir"
echo "Installed t3 $version at $runtime_dir"
