#!/usr/bin/env python3
"""Regression for the readiness check in scripts/prod-smoke.sh (INV-972).

Serves /ready from a local fake and runs the smoke in readiness-only mode
(INVOLUTE_SMOKE_ONLY_READY=1). The check must fail on the SPA's HTML 200,
on JSON with the wrong fields, on 404 and on a not-ready 503, and pass on
the API's real answer. Run: python3 scripts/test-readiness.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SMOKE = Path(__file__).resolve().parent / "prod-smoke.sh"

CASES = [
    ("html 200 (SPA fallback)", 200, "text/html; charset=utf-8", "<!doctype html><html></html>", 1),
    ("json with wrong fields", 200, "application/json; charset=utf-8", json.dumps({"status": "starting"}), 1),
    ("json saying database down", 200, "application/json", json.dumps({"status": "ready", "database": "error"}), 1),
    ("404", 404, "text/plain", "Not found", 1),
    ("503 not ready", 503, "application/json", json.dumps({"status": "not-ready", "database": "error"}), 1),
    ("jsonp media type is not json", 200, "application/jsonp", json.dumps({"database": "ok", "status": "ready"}), 1),
    ("ready json", 200, "application/json; charset=utf-8", json.dumps({"database": "ok", "status": "ready"}), 0),
    ("ready json, upper-case media type", 200, "Application/JSON", json.dumps({"database": "ok", "status": "ready"}), 0),
]


def serve(status: int, content_type: str, body: str) -> HTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path != "/ready":
                self.send_response(404)
                self.end_headers()
                return
            payload = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):  # quiet
            return

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main() -> int:
    failures = 0
    for name, status, content_type, body, expected in CASES:
        server = serve(status, content_type, body)
        try:
            result = subprocess.run(
                ["sh", str(SMOKE), f"http://127.0.0.1:{server.server_port}"],
                env={**os.environ, "INVOLUTE_SMOKE_ONLY_READY": "1"},
                capture_output=True, text=True, timeout=60, check=False,
            )
        finally:
            server.shutdown()
        ok = result.returncode == expected
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'}: {name} -> exit {result.returncode} (expected {expected})"
              + ("" if ok else f"\n  stdout: {result.stdout.strip()}\n  stderr: {result.stderr.strip()}"))
    print("all readiness cases behave" if failures == 0 else f"{failures} readiness case(s) wrong")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
