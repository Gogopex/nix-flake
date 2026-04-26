#!/usr/bin/env bash
set -euo pipefail

SRC="/Users/ludwig/dev/nix-dotfiles/cfg/pi"
DST="${PI_CODING_AGENT_DIR:-/Users/ludwig/.pi/agent}"

mkdir -p "$DST"

copy_file() {
  local name="$1"
  if [[ -f "$SRC/$name" ]]; then
    cp "$SRC/$name" "$DST/$name"
  fi
}

copy_dir() {
  local name="$1"
  if [[ -d "$SRC/$name" ]]; then
    rm -rf "$DST/$name"
    mkdir -p "$DST/$name"
    cp -R "$SRC/$name/." "$DST/$name/"
  fi
}

copy_file settings.json
copy_file presets.json
copy_file keybindings.json
copy_file models.json
copy_file AGENTS.md

copy_dir agents
copy_dir memory
copy_dir skills

# Extensions, prompts, and themes are loaded directly from this repo via
# settings.json, so they do not need to be duplicated into ~/.pi/agent.

echo "Synced Pi config files to $DST"
