#!/usr/bin/env bash
#
# install.sh — install / uninstall the local-notify OpenCode plugin.
#
# Usage:
#   ./install.sh                 Symlink the plugin into the OpenCode plugins dir
#   ./install.sh --copy          Copy instead of symlink (static snapshot)
#   ./install.sh --force         Replace an existing plugin file/symlink
#   ./install.sh --no-test       Don't send a test notification after installing
#   ./install.sh --uninstall     Remove the plugin from the plugins dir
#   ./install.sh --help
#
set -euo pipefail

PLUGIN_NAME="local-notify.ts"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/$PLUGIN_NAME"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}"
DEST_DIR="$CONFIG_DIR/opencode/plugins"
DEST="$DEST_DIR/$PLUGIN_NAME"

MODE="link"      # link | copy
FORCE=0
RUN_TEST=1
ACTION="install" # install | uninstall

# --- output helpers ----------------------------------------------------------

if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

info()  { printf '%s\n' "$*"; }
ok()    { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()   { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

usage() {
  # Print the leading comment block (from line 3) up to the first non-comment.
  awk 'NR >= 3 && /^#/ { sub(/^# ?/, ""); print; next } NR >= 3 { exit }' "$0"
}

# --- args --------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --copy)      MODE="copy" ;;
    --force|-f)  FORCE=1 ;;
    --no-test)   RUN_TEST=0 ;;
    --uninstall) ACTION="uninstall" ;;
    -h|--help)   usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
  shift
done

# --- dependency check --------------------------------------------------------

check_dependencies() {
  if ! command -v notify-send >/dev/null 2>&1; then
    warn "notify-send not found on PATH — notifications won't work."
    warn "Install libnotify (Debian/Ubuntu: sudo apt install libnotify-bin;"
    warn "Fedora: sudo dnf install libnotify; Arch: sudo pacman -S libnotify)."
  else
    ok "notify-send found ($(command -v notify-send))"
  fi

  if ! command -v canberra-gtk-play >/dev/null 2>&1; then
    warn "canberra-gtk-play not found — sounds are disabled."
    warn "Install libcanberra (Debian/Ubuntu: sudo apt install libcanberra-gtk-module"
    warn "or sound-theme-freedesktop; Fedora: sudo dnf install libcanberra;"
    warn "Arch: sudo pacman -S libcanberra). You can also set \"sound\": false"
    warn "in ~/.config/opencode/local-notify.json."
  else
    ok "canberra-gtk-play found ($(command -v canberra-gtk-play))"
  fi
}

# --- install -----------------------------------------------------------------

install_plugin() {
  [ -f "$SRC" ] || die "Plugin source not found: $SRC"

  mkdir -p "$DEST_DIR"

  if [ -e "$DEST" ] || [ -L "$DEST" ]; then
    if [ "$FORCE" -ne 1 ]; then
      # Idempotent: same symlink, or byte-identical copy — nothing to do.
      if [ -L "$DEST" ] && [ "$(readlink "$DEST")" = "$SRC" ]; then
        ok "Already installed: $DEST -> $SRC"
        exit 0
      fi
      if [ -f "$DEST" ] && [ ! -L "$DEST" ] && cmp -s "$SRC" "$DEST"; then
        ok "Already installed (up to date): $DEST"
        exit 0
      fi
      current="$(readlink "$DEST" 2>/dev/null || echo "$DEST")"
      die "Already installed at $DEST ($current). Re-run with --force to replace."
    fi
    rm -f "$DEST"
    warn "Replaced existing $DEST"
  fi

  if [ "$MODE" = "copy" ]; then
    cp "$SRC" "$DEST"
    ok "Copied plugin to $DEST"
  else
    ln -s "$SRC" "$DEST"
    ok "Symlinked plugin: $DEST -> $SRC"
  fi

  if [ "$RUN_TEST" -eq 1 ] && command -v notify-send >/dev/null 2>&1; then
    notify-send --app-name=OpenCode --urgency=normal \
      "🔔 local-notify installed" "Restart OpenCode to activate (or save the plugin to hot-reload)" \
      2>/dev/null || true
    command -v canberra-gtk-play >/dev/null 2>&1 \
      && canberra-gtk-play -i complete 2>/dev/null || true
    info "  Sent a test notification (skip with --no-test)."
  fi

  info ""
  info "${BOLD}Next:${RESET} restart OpenCode, or save the plugin file to trigger hot-reload."
  info "Optional config: $CONFIG_DIR/opencode/local-notify.json"
}

# --- uninstall ---------------------------------------------------------------

uninstall_plugin() {
  if [ ! -e "$DEST" ] && [ ! -L "$DEST" ]; then
    info "Nothing to uninstall: $DEST does not exist."
    exit 0
  fi
  rm -f "$DEST"
  ok "Removed $DEST"
  info "Restart OpenCode (or save another plugin) to unload it."
}

# --- main --------------------------------------------------------------------

info "${BOLD}local-notify installer${RESET}"
if [ "$ACTION" = "uninstall" ]; then
  uninstall_plugin
else
  check_dependencies
  install_plugin
fi
