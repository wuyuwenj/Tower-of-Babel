#!/usr/bin/env sh
# Provision a fresh worktree by pointing it at the main checkout's heavy and
# local-only paths instead of making it its own copy of them. Run by
# /worktree after it creates a tree; safe to run by hand at any time.
#
# Every link is a no-op when the source is missing or the target already
# exists, so running this twice changes nothing the second time.
set -eu

main_dir=$(git rev-parse --path-format=absolute --git-common-dir)
main_dir=${main_dir%/.git}

# In the main checkout these paths ARE the sources. Linking them to
# themselves would be a loop, so there is nothing to do here.
if [ "$(pwd -P)" = "$main_dir" ]; then
  echo "worktree-setup: main checkout, nothing to link"
  exit 0
fi

link() {
  if [ ! -e "$main_dir/$1" ]; then
    echo "worktree-setup: skip $1 (not in the main checkout)"
  elif [ -e "$1" ] || [ -L "$1" ]; then
    echo "worktree-setup: keep $1 (already here)"
  else
    ln -sfn "$main_dir/$1" "$1"
    echo "worktree-setup: link $1"
  fi
}

# Convex keys and the deployment URL. Browser-local player names work without
# it, but the shared tower does not, and a worktree with no .env silently
# becomes a single-player tower.
link .env

# ~230MB of seed splats. The resolver falls back to the CDN when they are
# absent, so this is a speed link, not a correctness one: 19ms off disk
# against a 35MB stream from GCS for level 1 alone.
link public/worlds

# Reinstalling these per tree costs minutes and ~244MB. Sharing them means
# every worktree runs whatever the main checkout last installed, so re-run
# `npm install` here if this branch changes package.json.
link node_modules

# The main checkout is normally where deps get installed, but it does not have
# to be, and if it has none there is nothing to share. Say so rather than
# leaving a silent skip: one install there is what turns the link on.
if [ ! -e "$main_dir/node_modules" ]; then
  echo "worktree-setup: run 'npm install' in $main_dir once to share deps across worktrees"
fi

exit 0
