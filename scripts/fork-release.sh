#!/usr/bin/env bash
# Builds this fork's release artifacts. .github/workflows/fork-release.yml runs it; it runs the same
# way locally.
#
#   scripts/fork-release.sh version <build-number>
#   scripts/fork-release.sh build <version> <output-dir> [--desktop]
#
# `build` writes this host's t3 runtime archive and, with --desktop on an Apple Silicon Mac, the
# unsigned desktop DMG and zip. Needs vp, Node at engines.node, and cargo on PATH. Linux archives
# need an Ubuntu or Debian host (ldd, dpkg-query, patchelf, libatomic1).
set -euo pipefail

cd "$(dirname "$0")/.."

case "${1:-}" in
  version)
    # Upstream's next patch plus -fork.N: newer than the release upstream main carries, older than
    # upstream's next one, and never equal to an upstream stable, nightly or preview version.
    base="$(node -p 'require("./apps/server/package.json").version.replace(/[-+].*$/, "")')"
    IFS=. read -r major minor patch <<<"$base"
    echo "${major}.${minor}.$((patch + 1))-fork.${2:?usage: fork-release.sh version <build-number>}"
    ;;
  build)
    version="${2:?usage: fork-release.sh build <version> <output-dir> [--desktop]}"
    mkdir -p "${3:?usage: fork-release.sh build <version> <output-dir> [--desktop]}"
    out="$(cd "$3" && pwd)"
    desktop="${4:-}"
    case "$(uname -s)-$(uname -m)" in
      Darwin-arm64) platform=mac arch=arm64 key=darwin-arm64 rust_target=aarch64-apple-darwin ;;
      Linux-x86_64) platform=linux arch=x64 key=linux-x64 rust_target=x86_64-unknown-linux-gnu ;;
      *) echo "fork-release: no t3 archive for $(uname -s) $(uname -m)" >&2; exit 1 ;;
    esac
    if [[ -n "$desktop" && "$desktop-$platform" != --desktop-mac ]]; then
      echo "fork-release: --desktop builds only on an Apple Silicon Mac" >&2
      exit 1
    fi

    # The files update-release-package-versions.ts stamps. The binary reports apps/server's
    # version, so they are stamped for the build and put back afterwards.
    stamped=(apps/server/package.json apps/desktop/package.json apps/web/package.json packages/contracts/package.json)
    scratch="$(mktemp -d)"
    for file in "${stamped[@]}"; do
      mkdir -p "$scratch/$(dirname "$file")"
      cp "$file" "$scratch/$file"
    done
    trap 'for file in "${stamped[@]}"; do cp "$scratch/$file" "$file"; done; rm -rf "$scratch"' EXIT
    node scripts/update-release-package-versions.ts "$version"

    if [[ -n "$desktop" ]]; then vp run build:desktop; else vp run --filter t3 build; fi
    node scripts/apply-web-brand-assets.ts production apps/server/dist/client
    node apps/server/scripts/cli.ts build-exe
    cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target "$rust_target"
    mkdir -p "$scratch/resource-monitor/$key"
    cp "native/resource-monitor/target/$rust_target/release/t3-resource-monitor" "$scratch/resource-monitor/$key/"
    node scripts/build-cli-archive.ts --platform "$platform" --arch "$arch" --version "$version" \
      --resource-monitor-dir "$scratch/resource-monitor" --output-dir "$out"
    node scripts/smoke-cli-archive.ts --archive "$out/t3-$version-$key.tar.gz" --expect-version "$version"

    if [[ -n "$desktop" ]]; then
      # No update feed: an unsigned app cannot update itself, so it is replaced by hand.
      env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY \
        node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 \
        --build-version "$version" --skip-build --output-dir "$out"
    fi
    ;;
  *)
    echo "usage: fork-release.sh version <build-number> | build <version> <output-dir> [--desktop]" >&2
    exit 1
    ;;
esac
