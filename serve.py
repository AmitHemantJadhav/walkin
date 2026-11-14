"""Static server for Walk-In that tells browsers never to cache, so every edit shows up on refresh (phones too).
Run from the walkin folder:  python serve.py   (port 8000; the cloudflared tunnel keeps working)

Relays (keys are read from .env here and never reach the browser):
  POST /api/gemini[?model=<name>]  body = a Gemini generateContent request (JSON) -> Gemini's JSON reply
  POST /api/tts                    body = {"text": "...", "voice": "<voice id, optional>"} -> audio/mpeg
  GET  /api/health                 -> {"gemini": bool, "tts": bool}  (which keys are set; never the keys)
"""
import http.server, json, os, re, socketserver, sys, urllib.error, urllib.parse, urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_BODY = 20 * 1024 * 1024  # a view screenshot as inline base64 fits easily
MAX_TTS_CHARS = 1000
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_44100_128"


def load_env(path=os.path.join(ROOT, ".env")):
    """Minimal .env reader (KEY=value per line). Real environment variables win."""
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            os.environ.setdefault(k.strip(), v)


load_env()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL") or "gemini-3.6-flash"
TTS_VOICE = os.environ.get("ELEVENLABS_VOICE_ID") or "21m00Tcm4TlvDq8ikWAM"
TTS_MODEL = os.environ.get("ELEVENLABS_MODEL_ID") or "eleven_flash_v2_5"


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    # ---- static files: never serve dotfiles (.env, .git) — the tunnel makes this server public
    def _hidden(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        return any(part.startswith(".") for part in path.replace("\\", "/").split("/") if part)

    def do_GET(self):
        if urllib.parse.urlsplit(self.path).path == "/api/health":
            return self._json(200, {"gemini": bool(os.environ.get("GEMINI_API_KEY")),
                                    "tts": bool(os.environ.get("ELEVENLABS_API_KEY"))})
        if self._hidden():
            return self.send_error(404)
        super().do_GET()

    def do_HEAD(self):
        if self._hidden():
            return self.send_error(404)
        super().do_HEAD()

    # ---- relays
    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if n < 0 or n > MAX_BODY:
            return self._json(413, {"error": "body too large or missing Content-Length"})
        body = self.rfile.read(n)
        if url.path == "/api/gemini":
            return self._gemini(url, body)
        if url.path == "/api/tts":
            return self._tts(body)
        self._json(404, {"error": "unknown endpoint"})

    def _gemini(self, url, body):
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            return self._json(503, {"error": "GEMINI_API_KEY is not set in .env"})
        model = (urllib.parse.parse_qs(url.query).get("model") or [GEMINI_MODEL])[0]
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", model):
            return self._json(400, {"error": "bad model name"})
        try:
            json.loads(body)
        except ValueError:
            return self._json(400, {"error": "body must be JSON"})
        self._forward(GEMINI_URL.format(model=model), body,
                      {"Content-Type": "application/json", "x-goog-api-key": key})

    def _tts(self, body):
        key = os.environ.get("ELEVENLABS_API_KEY")
        if not key:
            return self._json(503, {"error": "ELEVENLABS_API_KEY is not set in .env"})
        try:
            req = json.loads(body)
            text = str(req["text"]).strip()
        except (ValueError, KeyError, TypeError):
            return self._json(400, {"error": 'body must be JSON like {"text": "..."}'})
        voice = str(req.get("voice") or TTS_VOICE)
        if not text or not re.fullmatch(r"[A-Za-z0-9]{1,64}", voice):
            return self._json(400, {"error": "empty text or bad voice id"})
        payload = json.dumps({"text": text[:MAX_TTS_CHARS], "model_id": TTS_MODEL}).encode()
        self._forward(TTS_URL.format(voice=voice), payload,
                      {"Content-Type": "application/json", "xi-api-key": key, "Accept": "audio/mpeg"})

    def _forward(self, target, data, headers):
        """POST to the upstream API and pass its status, content type and body back. Keys stay in `headers`."""
        try:
            with urllib.request.urlopen(urllib.request.Request(target, data=data, headers=headers), timeout=90) as r:
                status, ctype, out = r.status, r.headers.get("Content-Type"), r.read()
        except urllib.error.HTTPError as e:
            status, ctype, out = e.code, e.headers.get("Content-Type"), e.read()
        except Exception as e:  # network down, timeout…
            return self._json(502, {"error": f"upstream unreachable: {type(e).__name__}"})
        self._send(status, ctype or "application/octet-stream", out)

    def _json(self, status, obj):
        self._send(status, "application/json", json.dumps(obj).encode())

    def _send(self, status, ctype, data):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    os.chdir(ROOT)
    print(f"Walk-In on http://localhost:{PORT}  (no caching; relays: /api/gemini, /api/tts)")
    Server(("", PORT), Handler).serve_forever()
