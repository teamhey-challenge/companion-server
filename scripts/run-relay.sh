#!/usr/bin/env bash
# Starts the relay detached from the calling shell/tool, logging to a size-rotated file.
# Usage: scripts/run-relay.sh [start|stop|status]   (env: PORT, HEY_*; HEY_LOG_DIR, HEY_LOG_MAX_BYTES, HEY_LOG_KEEP)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${HEY_LOG_DIR:-$ROOT/logs}"
LOG="$LOG_DIR/relay.log"
PIDFILE="$LOG_DIR/relay.pid"
MAX="${HEY_LOG_MAX_BYTES:-5242880}"
KEEP="${HEY_LOG_KEEP:-5}"

running() { [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

rotate() {
  [[ -f "$LOG" ]] || return 0
  local size
  size="$(stat -c %s "$LOG")"
  (( size >= MAX )) || return 0
  for ((i = KEEP - 1; i >= 1; i--)); do
    [[ -f "$LOG.$i" ]] && mv -f "$LOG.$i" "$LOG.$((i + 1))"
  done
  mv -f "$LOG" "$LOG.1"
}

case "${1:-start}" in
  start)
    mkdir -p "$LOG_DIR"
    if running; then echo "already running pid $(cat "$PIDFILE")"; exit 0; fi
    rotate
    cd "$ROOT"
    # setsid: new session, so a closing terminal/tool shell cannot SIGHUP it. The relay
    # writes its own JSON log lines to HEY_LOG_FILE; stdout/stderr only hold crashes.
    HEY_LOG_FILE="$LOG" setsid nohup bun src/index.ts >>"$LOG_DIR/relay.stderr" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"
    disown || true
    echo "started pid $(cat "$PIDFILE") log $LOG"
    ;;
  stop)
    if running; then kill "$(cat "$PIDFILE")"; rm -f "$PIDFILE"; echo stopped; else echo "not running"; fi
    ;;
  status)
    if running; then echo "running pid $(cat "$PIDFILE")"; else echo "not running"; exit 1; fi
    ;;
  *)
    echo "usage: $0 [start|stop|status]" >&2
    exit 2
    ;;
esac
