"""Static server for Walk-In that tells browsers never to cache, so every edit shows up on refresh (phones too).
Run from the walkin folder:  python serve.py   (port 8000; the cloudflared tunnel keeps working)

Relays (keys are read from .env here and never reach the browser):
  POST /api/gemini[?model=<name>]  body = a Gemini generateContent request (JSON) -> Gemini's JSON reply
  POST /api/tts                    body = {"text": "...", "voice": "<voice id, optional>"} -> audio/mpeg
  POST /api/live-token             -> {token, model, voice, apiVersion}: a one-use Gemini Live token (live.js opens the
                                      voice conversation with it straight from the browser; the real key stays here)
  GET  /api/health                 -> which keys are set (never the keys), mock mode, calls this minute / today,
                                      the last upstream status, cache size and the rate limits
  GET  /api/houses                 -> [{id, name, panos, rooms}] for every data/<id>/house.json (house picker)

Quota (R10, so a rate limit can't kill the demo):
  - Rate limits per endpoint (token buckets): GEMINI_RPM (default 8/min), GEMINI_IMAGE_RPM (2/min, any model
    with "image" in its name), TTS_RPM (20/min). Over the limit -> 429 {"error": {..., "friendly": "..."}}.
  - An upstream 429 is retried once after its Retry-After (at most 10 s), then answered with the friendly 429.
  - Disk cache in .cache/relay/ (git-ignored, never served): identical requests (same model + body) are answered
    from disk and cost nothing. RELAY_CACHE=0 turns it off. Run the demo once before judging to pre-warm it.
  - GEMINI_MOCK=1: canned Gemini replies (tool calls, text, a brick tile image) and a silent TTS clip, so the
    agent flow can be tested without keys or quota.
Static files: no-store for code (so edits show up), a day of private caching for models/ and vendor/; data/ is kept but re-checked on every load (cheap 304s),
so a re-prepped house shows up at once.
"""
import base64, collections, datetime, hashlib, http.server, json, os, re, socketserver, struct, sys, threading, time
import urllib.error, urllib.parse, urllib.request, zlib

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_BODY = 20 * 1024 * 1024  # a view screenshot as inline base64 fits easily
MAX_TTS_CHARS = 1000
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
import openrouter  # noqa: E402  fallback LLM provider (OPENROUTER_API_KEY) when Gemini is missing or failing
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
MOCK = os.environ.get("GEMINI_MOCK", "") not in ("", "0", "false", "no")
# Gemini Live (two-way voice, live.js). Needs a real Gemini key: OpenRouter has no realtime audio.
LIVE_MODEL = os.environ.get("LIVE_MODEL") or "gemini-3.8-live"
LIVE_VOICE = os.environ.get("LIVE_VOICE") or "Charon"
LIVE_API_VERSION = os.environ.get("LIVE_API_VERSION") or "v1beta"   # the docs say v1beta; the SDK also knows v1alpha
CACHE_DIR = os.path.join(ROOT, ".cache", "relay")
CACHE_ON = os.environ.get("RELAY_CACHE", "1") not in ("0", "false", "no")
FRIENDLY_BUSY = "One moment, I'm a bit busy. Ask me again in a few seconds."
STATIC_CACHED = ("/models/", "/vendor/")  # never change during the demo: let phones keep them for a day
REVALIDATED = ("/data/",)                  # re-prepped houses must show up at once: re-check, 304 if unchanged


# ------------------------------------------------------------------ quota: rate limits, stats, disk cache
def _env_num(name, default):
    try:
        return float(os.environ.get(name) or default)
    except ValueError:
        return float(default)


class Bucket:
    """Token bucket: `per_min` requests a minute, bursts up to the same number."""

    def __init__(self, per_min):
        self.rate = max(per_min, 0.01) / 60.0
        self.cap = max(per_min, 1.0)
        self.tokens = self.cap
        self.t = time.monotonic()

    def take(self):
        now = time.monotonic()
        self.tokens = min(self.cap, self.tokens + (now - self.t) * self.rate)
        self.t = now
        if self.tokens >= 1:
            self.tokens -= 1
            return True, 0
        return False, int((1 - self.tokens) / self.rate) + 1


LOCK = threading.Lock()
BUCKETS = {"gemini": Bucket(_env_num("GEMINI_RPM", 8)), "image": Bucket(_env_num("GEMINI_IMAGE_RPM", 2)),
           "tts": Bucket(_env_num("TTS_RPM", 20)), "live": Bucket(_env_num("LIVE_RPM", 6))}
STATS = {"recent": collections.deque(), "day": datetime.date.today().isoformat(), "today": 0,
         "cache_hits": 0, "limited": 0, "last": None}


def count_call(kind, status):
    with LOCK:
        now = time.time()
        today = datetime.date.today().isoformat()
        if STATS["day"] != today:
            STATS["day"], STATS["today"] = today, 0
        STATS["recent"].append(now)
        STATS["today"] += 1
        STATS["last"] = {"endpoint": kind, "status": status, "at": time.strftime("%H:%M:%S")}


def health():
    with LOCK:
        recent = STATS["recent"]
        while recent and recent[0] < time.time() - 60:
            recent.popleft()
        try:
            entries = len([f for f in os.listdir(CACHE_DIR) if f.endswith(".bin")])
        except OSError:
            entries = 0
        provider = ("mock" if MOCK else "gemini" if os.environ.get("GEMINI_API_KEY")
                    else "openrouter" if openrouter.key() else "none")
        return {"gemini": bool(os.environ.get("GEMINI_API_KEY")), "tts": bool(os.environ.get("ELEVENLABS_API_KEY")),
                "openrouter": bool(openrouter.key()), "provider": provider,
                "mock": MOCK, "calls_last_minute": len(recent), "calls_today": STATS["today"],
                "rate_limited": STATS["limited"], "cache": {"on": CACHE_ON, "entries": entries, "hits": STATS["cache_hits"]},
                "last_upstream": STATS["last"],
                "limits_per_min": {k: round(b.cap) for k, b in BUCKETS.items()}, "model": GEMINI_MODEL,
                "live": bool(os.environ.get("GEMINI_API_KEY")) and not MOCK, "live_model": LIVE_MODEL, "live_voice": LIVE_VOICE}


def cache_key(*parts):
    h = hashlib.sha256()
    for p in parts:
        h.update(p if isinstance(p, bytes) else str(p).encode())
        h.update(b"\0")
    return h.hexdigest()


def cache_get(key):
    if not CACHE_ON:
        return None
    try:
        with open(os.path.join(CACHE_DIR, key + ".bin"), "rb") as f:
            data = f.read()
        with open(os.path.join(CACHE_DIR, key + ".type"), encoding="utf-8") as f:
            ctype = f.read().strip()
    except OSError:
        return None
    with LOCK:
        STATS["cache_hits"] += 1
    return ctype, data


def cache_put(key, ctype, data):
    if not CACHE_ON:
        return
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = os.path.join(CACHE_DIR, f"{key}.{threading.get_ident()}.tmp")
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, os.path.join(CACHE_DIR, key + ".bin"))
        with open(os.path.join(CACHE_DIR, key + ".type"), "w", encoding="utf-8") as f:
            f.write(ctype)
    except OSError:
        pass


# ------------------------------------------------------------------ GEMINI_MOCK=1: canned replies, no keys, no quota
def _png(w, h, pixel):
    raw = b"".join(b"\0" + b"".join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def _brick(x, y):  # 128 px seamless tile: 4 rows of bricks, running bond, grey mortar
    row, by = divmod(y, 32)
    bx = (x + (16 * (row % 2)) * 2) % 64
    if by < 3 or bx < 3:
        return (200, 196, 188)
    shade = ((x * 7 + y * 13 + row * 29) % 23) - 11
    return (max(0, 150 + shade), max(0, 62 + shade // 2), max(0, 48 + shade // 2))


MOCK_TILE = None


def mock_gemini(req, model):
    """Pick a plausible tool call from the user's words, answer tool results with a short sentence."""
    global MOCK_TILE
    if "image" in model or "IMAGE" in json.dumps(req.get("generationConfig") or {}):
        if MOCK_TILE is None:
            MOCK_TILE = base64.b64encode(_png(128, 128, _brick)).decode()
        return {"candidates": [{"content": {"role": "model", "parts": [{"inlineData": {"mimeType": "image/png", "data": MOCK_TILE}}]},
                                "finishReason": "STOP"}], "mock": True}
    contents = req.get("contents") or []
    last = contents[-1] if contents else {}
    parts = last.get("parts") or []
    answered = [p["functionResponse"] for p in parts if isinstance(p, dict) and "functionResponse" in p]
    if answered:
        names = ", ".join(a.get("name", "?") for a in answered)
        say = next((a.get("response", {}).get("say") for a in answered if isinstance(a.get("response"), dict)
                    and a["response"].get("say")), None)
        text = say or f"Mock reply: done ({names})."
        return {"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}], "mock": True}
    words = " ".join(p.get("text", "") for p in parts if isinstance(p, dict)).lower()
    rules = [(r"wallpaper|brick|paint|wall", ("set_wall_material", {"description": "red brick with light grey mortar", "tile_metres": 0.9})),
             (r"plant", ("light_here", {})),
             (r"whole house|entire house|every room|all (the )?rooms", ("stage_house", {})),
             # pass the user's own words through as the style: staging parses a palette and a room type
             # out of free text, so "cosy living room" stages a living room and not a fixed bedroom
             (r"stage|furnish", ("stage_room", {"style": words.strip()[:60] or "modern"})),
             (r"take me|go to|walk to", ("go_to", {"room": "kitchen"})),
             (r"sofa|couch", ("add_furniture", {"kind": "sofa"})),
             (r"bed\b", ("add_furniture", {"kind": "queen"}))]
    call = next((c for pat, c in rules if re.search(pat, words)), ("describe_house", {}))
    if not req.get("tools"):
        return {"candidates": [{"content": {"role": "model", "parts": [{"text": "Mock reply."}]}, "finishReason": "STOP"}], "mock": True}
    return {"candidates": [{"content": {"role": "model", "parts": [{"functionCall": {"name": call[0], "args": call[1]}}]},
                            "finishReason": "STOP"}], "mock": True}


def mock_wav(seconds=0.3, rate=8000):
    n = int(seconds * rate)
    return (b"RIFF" + struct.pack("<I", 36 + n) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate, 1, 8)
            + b"data" + struct.pack("<I", n) + b"\x80" * n)


def houses():
    """Houses downloaded with prep_house.py: [{id, name, panos, rooms}] from data/<id>/house.json."""
    out, data = [], os.path.join(ROOT, "data")
    for mid in sorted(os.listdir(data)) if os.path.isdir(data) else []:
        try:
            with open(os.path.join(data, mid, "house.json"), encoding="utf-8") as f:
                h = json.load(f)
        except (OSError, ValueError):
            continue
        out.append({"id": mid, "name": h.get("name"), "panos": len(h.get("panos") or []), "rooms": len(h.get("rooms") or [])})
    return out


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        path = urllib.parse.urlsplit(self.path).path
        get = self.command in ("GET", "HEAD")
        if get and path.startswith(STATIC_CACHED):
            cc = "private, max-age=86400"
        elif get and path.startswith(REVALIDATED):
            cc = "private, no-cache"   # kept on the phone, but asked about every time (If-Modified-Since -> 304)
        else:
            cc = "no-store, max-age=0"
        # private: the tunnel's edge never stores the licensed data
        self.send_header("Cache-Control", cc)
        super().end_headers()

    # ---- static files: never serve dotfiles (.env, .git) — the tunnel makes this server public
    def _hidden(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        return any(part.startswith(".") for part in path.replace("\\", "/").split("/") if part)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/health":
            return self._json(200, health())
        if path == "/api/houses":
            return self._json(200, houses())
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
        if url.path == "/api/live-token":
            return self._live_token(body)
        self._json(404, {"error": "unknown endpoint"})

    def _live_token(self, body):
        """Mint a one-use, short-lived Gemini Live token. The browser connects to Google with it directly (audio
        is too latency-sensitive to relay), so the real key never leaves this machine."""
        key = os.environ.get("GEMINI_API_KEY")
        if MOCK or not key:
            return self._json(503, {"error": "live voice needs GEMINI_API_KEY (OpenRouter has no realtime audio)"
                                    if not MOCK else "live voice is off in GEMINI_MOCK mode"})
        try:
            req = json.loads(body or b"{}")
        except ValueError:
            req = {}
        version = req.get("apiVersion") if req.get("apiVersion") in ("v1alpha", "v1beta") else LIVE_API_VERSION
        with LOCK:
            ok, wait = BUCKETS["live"].take()
        if not ok:
            return self._busy(wait, "local live limit reached")
        now = datetime.datetime.now(datetime.timezone.utc)
        iso = lambda d: (now + d).strftime("%Y-%m-%dT%H:%M:%SZ")
        url = f"https://generativelanguage.googleapis.com/{version}/auth_tokens"
        headers = {"Content-Type": "application/json", "x-goog-api-key": key}
        base = {"uses": 1, "expireTime": iso(datetime.timedelta(minutes=20)),
                "newSessionExpireTime": iso(datetime.timedelta(minutes=2))}
        # lock the token to our model when the API accepts that, else mint it unconstrained
        tries = [dict(base, liveConnectConstraints={"model": f"models/{LIVE_MODEL}"}), base]
        for attempt, payload in enumerate(tries):
            status, _ctype, out, _retry = self._upstream(url, json.dumps(payload).encode(), headers, timeout=15)
            count_call("live", status)
            if status == 200:
                break
            if status != 400:
                break
        if status != 200:
            msg = out.decode("utf-8", "replace")[:300] if isinstance(out, bytes) else str(out)
            return self._json(502 if status is None or status >= 500 else status,
                              {"error": f"couldn't mint a live token ({status}): {msg}"})
        token = (json.loads(out) or {}).get("name")
        if not token:
            return self._json(502, {"error": "no token in the reply"})
        self._json(200, {"token": token, "model": LIVE_MODEL, "voice": LIVE_VOICE, "apiVersion": version})

    def _gemini(self, url, body):
        model = (urllib.parse.parse_qs(url.query).get("model") or [GEMINI_MODEL])[0]
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", model):
            return self._json(400, {"error": "bad model name"})
        try:
            req = json.loads(body)
        except ValueError:
            return self._json(400, {"error": "body must be JSON"})
        if MOCK:
            return self._json(200, mock_gemini(req if isinstance(req, dict) else {}, model))
        key = os.environ.get("GEMINI_API_KEY")
        kind = "image" if "image" in model.lower() else "gemini"
        req = req if isinstance(req, dict) else {}
        if not key:
            if openrouter.key():
                return self._openrouter(kind, model, req, body)
            return self._json(503, {"error": "GEMINI_API_KEY is not set in .env"})
        # the fallback is the same request answered another way: it must not take a second rate-limit token
        # (it did, so every image cost two of the two-a-minute image tokens and the next one was refused)
        fallback = (lambda: self._openrouter(kind, model, req, body, charge=False)) if openrouter.key() else None
        self._relay(kind, cache_key("gemini", model, body), GEMINI_URL.format(model=model), body,
                    {"Content-Type": "application/json", "x-goog-api-key": key}, fallback=fallback)

    def _openrouter(self, kind, model, req, body, charge=True):
        """Same cache and limits, via OpenRouter; its reply is translated back to Gemini's shape for agent.js."""
        slug = openrouter.model_for(model)
        payload = json.dumps(openrouter.to_openai(req, slug)).encode()
        self._relay(kind, cache_key("openrouter", slug, body), openrouter.URL, payload, openrouter.headers(),
                    transform=lambda out: json.dumps(openrouter.to_gemini(json.loads(out))).encode(), charge=charge)

    def _tts(self, body):
        try:
            req = json.loads(body)
            text = str(req["text"]).strip()
        except (ValueError, KeyError, TypeError):
            return self._json(400, {"error": 'body must be JSON like {"text": "..."}'})
        voice = str(req.get("voice") or TTS_VOICE)
        if not text or not re.fullmatch(r"[A-Za-z0-9]{1,64}", voice):
            return self._json(400, {"error": "empty text or bad voice id"})
        if MOCK:
            return self._send(200, "audio/wav", mock_wav())
        key = os.environ.get("ELEVENLABS_API_KEY")
        if not key:
            return self._json(503, {"error": "ELEVENLABS_API_KEY is not set in .env"})
        payload = json.dumps({"text": text[:MAX_TTS_CHARS], "model_id": TTS_MODEL}).encode()
        self._relay("tts", cache_key("tts", voice, TTS_MODEL, payload), TTS_URL.format(voice=voice), payload,
                    {"Content-Type": "application/json", "xi-api-key": key, "Accept": "audio/mpeg"})

    def _busy(self, retry_after, why):
        with LOCK:
            STATS["limited"] += 1
        self.send_response(429)
        self.send_header("Content-Type", "application/json")
        self.send_header("Retry-After", str(retry_after))
        data = json.dumps({"error": {"message": why, "code": 429, "friendly": FRIENDLY_BUSY},
                           "retry_after": retry_after}).encode()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _relay(self, kind, key, target, data, headers, fallback=None, transform=None, charge=True):
        """Cache, then rate limit, then the upstream call (one polite retry on its 429).
        fallback(): answer another way when the upstream is rate limited, failing (5xx) or unreachable.
        transform(bytes) -> bytes: rewrite a 200 reply (e.g. OpenRouter JSON into Gemini's) before caching it.
        """
        hit = cache_get(key)
        if hit:
            return self._send(200, hit[0], hit[1])
        ok, wait = True, 0
        if charge:
            with LOCK:
                ok, wait = BUCKETS[kind].take()
        if not ok:
            return self._busy(wait, f"local {kind} limit reached")
        for attempt in (1, 2):
            status, ctype, out, retry = self._upstream(target, data, headers)
            count_call(kind, status)
            if status != 429 or attempt == 2 or retry is None or retry > 10:
                break
            time.sleep(retry)
        if fallback and (status is None or status == 429 or status >= 500):
            return fallback()
        if status == 429:
            return self._busy(retry or 30, "upstream rate limit")
        if status is None:
            return self._json(502, {"error": f"upstream unreachable: {out}"})
        if status == 200 and transform:
            try:
                out, ctype = transform(out), "application/json"
            except (ValueError, KeyError, TypeError, IndexError) as e:
                return self._json(502, {"error": f"unexpected upstream reply: {type(e).__name__}"})
        # an image request that came back without an image (a safety or recitation refusal) is not cached:
        # otherwise the same wallpaper or poster prompt fails instantly for the rest of the day
        if status == 200 and not (kind == "image" and b"inlineData" not in out and b'"data"' not in out):
            cache_put(key, ctype or "application/octet-stream", out)
        self._send(status, ctype or "application/octet-stream", out)

    def _upstream(self, target, data, headers, timeout=90):
        """POST to the upstream API. Returns (status, content type, body, retry-after seconds). Keys stay in `headers`."""
        try:
            with urllib.request.urlopen(urllib.request.Request(target, data=data, headers=headers), timeout=timeout) as r:
                return r.status, r.headers.get("Content-Type"), r.read(), None
        except urllib.error.HTTPError as e:
            ra = e.headers.get("Retry-After")
            try:
                ra = int(float(ra)) if ra is not None else (2 if e.code == 429 else None)
            except ValueError:
                ra = 2
            return e.code, e.headers.get("Content-Type"), e.read(), ra
        except Exception as e:  # network down, timeout...
            return None, None, type(e).__name__, None

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
    print(f"Walk-In on http://localhost:{PORT}  (relays: /api/gemini, /api/tts{'; MOCK replies' if MOCK else ''})")
    Server(("", PORT), Handler).serve_forever()
