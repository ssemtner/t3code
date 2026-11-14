#!/usr/bin/env bash
# Replaces the T3 Code desktop app on this Mac with the latest fork build. Quit the app first.
# Data in ~/.t3 is not touched.
#
#   curl -fsSL https://raw.githubusercontent.com/ssemtner/t3code/machines/scripts/fork-update-app.sh | bash
set -euo pipefail

REPO="${FORK_SYNC_REPO:-ssemtner/t3code}"

if pgrep -qf "/Applications/T3 Code[^/]*\.app/Contents/MacOS/"; then
  echo "T3 Code is running. Quit it with Cmd+Q, then run this again." >&2
  exit 1
fi

work="$(mktemp -d)"
mnt="$work/mnt"
trap 'hdiutil detach -quiet "$mnt" 2>/dev/null || true; rm -rf "$work"' EXIT

url="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
  grep -o '"browser_download_url": *"[^"]*arm64\.dmg"' | head -1 | cut -d'"' -f4)"
if [ -z "$url" ]; then
  echo "No arm64 DMG in the latest release of $REPO." >&2
  exit 1
fi
echo "Downloading $url"
curl -fL --progress-bar -o "$work/app.dmg" "$url"

mkdir "$mnt"
hdiutil attach -nobrowse -quiet "$work/app.dmg" -mountpoint "$mnt"
src="$(find "$mnt" -maxdepth 1 -name '*.app' | head -1)"
dest="/Applications/$(basename "$src")"
rm -rf "$dest"
cp -R "$src" /Applications/
xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
echo "Installed $dest"
open "$dest"
