"""Serve the repo for website/tools/render.html and save the frames it posts.

    python3 website/tools/capture.py [port] [out_dir]   # then open http://localhost:8090/website/tools/render.html
                                               # (or run it headless, see website/README.md)

GET  serves files from the repo root (render.html reads data/<model>/ and vendor/three/).
POST /save/<name>.jpg writes the body to <out_dir>/<name>.jpg (default website/frames). Nothing else can be written.
Render into a fresh out_dir and swap it in when it's complete, so the page never shows half a render.
"""
import http.server
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'website' / 'frames'


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT), **k)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        m = re.fullmatch(r'/save/([a-z0-9_\-]+\.jpg)', self.path)
        if not m:
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / m.group(1)).write_bytes(body)
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        if 'POST' in fmt % args or '404' in fmt % args:
            sys.stderr.write(fmt % args + '\n')


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    if len(sys.argv) > 2:
        OUT = Path(sys.argv[2]).resolve()
    print(f'http://localhost:{port}/website/tools/render.html', flush=True)
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
