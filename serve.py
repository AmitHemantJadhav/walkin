"""Static server for Walk-In that tells browsers never to cache, so every edit shows up on refresh (phones too).
Run from the walkin folder:  python serve.py   (port 8000; the cloudflared tunnel keeps working)"""
import http.server, socketserver, sys, urllib.parse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class NoCache(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        # refuse dotfiles: .env (API keys) and .git sit in the served folder and the tunnel makes it public
        parts = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).split("/")
        if any(p.startswith(".") for p in parts):
            self.send_error(404)
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


print(f"Walk-In on http://localhost:{PORT}  (no caching)")
Server(("", PORT), NoCache).serve_forever()
