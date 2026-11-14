#!/usr/bin/env bash
# Keeps the fork branch on top of upstream. Run from a dedicated clone on an always-on machine,
# by an agent that resolves conflicts. Pushing the branch starts the "Fork release" workflow.
#
#   scripts/fork-sync.sh status    what is new upstream and what is released/installed
#   scripts/fork-sync.sh rebase    rebase the fork branch onto upstream/main (exit 3: conflicts)
#   scripts/fork-sync.sh continue  continue the rebase after conflicts are resolved and staged
#   scripts/fork-sync.sh check     install deps and run the changed-files checks
#   scripts/fork-sync.sh push      push the rebased branch (exit 4: needs the user, see message)
set -euo pipefail

BRANCH="${FORK_SYNC_BRANCH:-machines}"
FORK_REPO="${FORK_SYNC_REPO:-ssemtner/t3code}"
UPSTREAM_URL="https://github.com/pingdotgg/t3code.git"

cd "$(git rev-parse --show-toplevel)"
# The origin commit the local rebase started from; the push only replaces that commit.
lease_file="$(git rev-parse --git-dir)/fork-sync-origin"
# Rebased fork commits are unsigned: the signing key is not available to an unattended run.
unsigned=(-c commit.gpgsign=false -c core.editor=true)

fetch() {
  git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"
  git fetch --quiet origin "$BRANCH"
  git fetch --quiet upstream main
}

case "${1:-}" in
  status)
    fetch
    echo "upstream commits not in the fork: $(git rev-list --count "origin/$BRANCH..upstream/main")"
    echo "fork commits on top of upstream:  $(git rev-list --count "upstream/main..origin/$BRANCH")"
    echo "upstream workflow files changed:  $(git diff --name-only "origin/$BRANCH...upstream/main" -- .github/workflows | wc -l | tr -d ' ')"
    echo "latest fork release:              $(gh release view -R "$FORK_REPO" --json tagName,publishedAt --jq '"\(.tagName) (\(.publishedAt))"' 2>/dev/null || echo unknown)"
    echo "t3 installed here:                $( (command -v t3 >/dev/null && t3 --version) || ("$HOME/.local/bin/t3" --version) 2>/dev/null || echo none)"
    echo "last release build:               $(gh run list -R "$FORK_REPO" --workflow fork-release.yml --limit 1 --json status,conclusion,displayTitle --jq '.[0] | "\(.status) \(.conclusion) \(.displayTitle)"' 2>/dev/null || echo unknown)"
    ;;

  rebase)
    if [ -n "$(git status --porcelain)" ]; then
      echo "The working tree has changes. This clone is only for syncing; clean it first." >&2
      exit 2
    fi
    fetch
    origin_sha="$(git rev-parse "origin/$BRANCH")"
    # Keep an earlier rebase that was never pushed, unless origin moved since it was made.
    if [ "$(cat "$lease_file" 2>/dev/null)" != "$origin_sha" ] || ! git rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null; then
      git checkout --quiet -B "$BRANCH" "origin/$BRANCH"
      echo "$origin_sha" >"$lease_file"
    else
      git checkout --quiet "$BRANCH"
    fi
    if git merge-base --is-ancestor upstream/main HEAD; then
      echo "Already on top of upstream/main."
      exit 0
    fi
    if ! git "${unsigned[@]}" rebase upstream/main; then
      echo "Conflicts in:" >&2
      git diff --name-only --diff-filter=U >&2
      exit 3
    fi
    echo "Rebased onto $(git rev-parse --short upstream/main)."
    ;;

  continue)
    if ! git "${unsigned[@]}" rebase --continue; then
      echo "Conflicts in:" >&2
      git diff --name-only --diff-filter=U >&2
      exit 3
    fi
    echo "Rebase finished."
    ;;

  check)
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile --ignore-scripts
    PATH="$PWD/node_modules/.bin:$PATH" node scripts/check-changed.ts
    ;;

  push)
    lease="$(cat "$lease_file")"
    push() { git "$@" push --force-with-lease="$BRANCH:$lease" "${remote:-origin}" "$BRANCH" 2>&1; }
    # A gh token without the `workflow` scope cannot push upstream's workflow file changes.
    if out="$(push -c credential.helper= -c credential.helper='!gh auth git-credential')"; then
      echo "$out"
    elif ! grep -q "workflow" <<<"$out"; then
      echo "$out" >&2
      exit 1
    else
      agent="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/rbw/ssh-agent-socket"
      if rbw unlocked >/dev/null 2>&1 && out="$(remote="git@github.com:$FORK_REPO.git" SSH_AUTH_SOCK="$agent" push)"; then
        echo "$out"
      else
        cat >&2 <<EOF
The push includes upstream workflow file changes, which the gh token here may not push.
Ask the user to do one of these on this machine, then run this command again:
  gh auth refresh -h github.com -s workflow     (once; later pushes need nothing)
  rbw unlock                                    (each time)
EOF
        exit 4
      fi
    fi
    rm -f "$lease_file"
    echo "Pushed. Version being built: $(scripts/fork-release.sh version "<run number>")"
    ;;

  *)
    sed -n '2,9p' "$0" >&2
    exit 64
    ;;
esac
