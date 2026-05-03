#!/bin/bash
# AudioBridge — Compile and run the Core Audio bridge
# Usage: ./start-bridge.sh [--device <id>] [--channel <n>] [--port <port>]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BINARY="$SCRIPT_DIR/AudioBridge"

echo "╔══════════════════════════════════════════╗"
echo "║   Guitar Shop — Core Audio Bridge        ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Compile if binary doesn't exist or source is newer
if [ ! -f "$BINARY" ] || [ "AudioBridge.swift" -nt "$BINARY" ]; then
    echo "[Build] Compiling AudioBridge.swift..."
    swiftc -O AudioBridge.swift -o AudioBridge \
        -framework AVFoundation \
        -framework CoreAudio \
        -framework Network
    echo "[Build] Done."
    echo ""
fi

echo "[Run] Starting AudioBridge..."
echo ""
echo "  ┌─────────────────────────────────────────┐"
echo "  │  Open in browser:                       │"
echo "  │  → http://localhost:9877                 │"
echo "  └─────────────────────────────────────────┘"
echo ""
echo "[Run] Press Ctrl+C to stop."
echo ""

exec "$BINARY" "$@"
