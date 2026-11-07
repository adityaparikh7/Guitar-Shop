#!/usr/bin/env python3
"""
Static dev server for Guitar Shop.

The app wants SharedArrayBuffer for its zero-copy audio transport, and browsers
only hand that out to a cross-origin isolated page — which means COOP and COEP
headers on every response. A plain `python3 -m http.server` does not send them,
so the app silently falls back to the slower postMessage transport.

The bundled AudioBridge serves the app with the same two headers on port 9877,
so this is only needed when working on the front end without the bridge running.

    python3 tools/serve.py [port]

The port comes from the first argument, else $PORT, else 8765.
"""

import functools
import http.server
import os
import pathlib
import sys

DEFAULT_PORT = 8765
PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Required for crossOriginIsolated, and therefore SharedArrayBuffer.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # Audio worklets and presets change constantly while developing.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quiet by default; the browser console is the useful log here.
        if os.environ.get("SERVE_VERBOSE"):
            super().log_message(fmt, *args)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", DEFAULT_PORT))
    handler = functools.partial(Handler, directory=str(PROJECT_ROOT))
    # Loopback only: this serves the whole project directory.
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    print(f"Guitar Shop → http://localhost:{port}  (COOP/COEP on, SharedArrayBuffer available)")
    print(f"Serving {PROJECT_ROOT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
