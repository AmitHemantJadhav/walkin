"""Preflight before a demo (R10): is the AI path alive, and how fast is it?

Run it against the server that will be on stage (it goes through the same /api relays the phone uses):
    python3 tools/preflight.py                         # http://localhost:8000
    python3 tools/preflight.py https://<tunnel>.trycloudflare.com
    python3 tools/preflight.py --only text             # text | image | tts (one call instead of three)

It makes at most three real calls (one text, one image, one TTS), each with a fresh nonce so the relay's disk
cache can't answer for it, and prints status, latency and model per call, then /api/health (quota, last status).
Exit code 0 when every call it made returned 200, 1 otherwise. Never prints a key.
"""
import argparse, json, sys, time, urllib.error, urllib.request, uuid

IMAGE_MODEL = "gemini-3.1-flash-image"   # keep in step with agent.js IMAGE_MODEL
SLOW_S = {"text": 4.0, "image": 9.0, "tts": 3.0}   # agent.js waits 12 s per turn and 9 s for an image


def call(base, path, body, timeout=40):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    t = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data, status, ctype = r.read(), r.status, r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        data, status, ctype = e.read(), e.code, e.headers.get("Content-Type", "")
    except Exception as e:  # unreachable, timeout
        return None, time.monotonic() - t, type(e).__name__, ""
    return status, time.monotonic() - t, data, ctype


def detail(status, data, ctype):
    if status is None:
        return f"unreachable ({data})"
    if "json" in ctype:
        try:
            j = json.loads(data)
        except ValueError:
            return f"{len(data)} bytes"
        if status != 200:
            err = j.get("error")
            return (err.get("friendly") or err.get("message")) if isinstance(err, dict) else str(err)
        cand = (j.get("candidates") or [{}])[0]
        parts = (cand.get("content") or {}).get("parts") or []
        text = " ".join(p.get("text", "") for p in parts if isinstance(p, dict)).strip()
        img = next((p["inlineData"] for p in parts if isinstance(p, dict) and "inlineData" in p), None)
        mock = " [MOCK]" if j.get("mock") else ""
        if img:
            return f"image {img.get('mimeType')} {len(img.get('data', '')) * 3 / 4 / 1024:.1f} KB{mock}"
        return f"\"{text[:70]}\" finish={cand.get('finishReason')}{mock}"
    return f"{ctype or 'unknown type'} {len(data) / 1024:.1f} KB"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("base", nargs="?", default="http://localhost:8000")
    ap.add_argument("--only", choices=["text", "image", "tts"])
    a = ap.parse_args()
    base = a.base.rstrip("/")
    nonce = uuid.uuid4().hex[:8]

    try:
        with urllib.request.urlopen(base + "/api/health", timeout=10) as r:
            health = json.loads(r.read())
    except Exception as e:
        print(f"Can't reach {base}/api/health ({type(e).__name__}). Is serve.py running?")
        return 1
    model = health.get("model", "?")
    print(f"Server {base}: keys gemini={'yes' if health.get('gemini') else 'NO'} tts={'yes' if health.get('tts') else 'NO'}"
          f"{'  MOCK MODE' if health.get('mock') else ''}  text model {model}")

    checks = {
        "text": ("/api/gemini", {"contents": [{"role": "user", "parts": [{"text": f"Preflight {nonce}. Reply with the single word: ready"}]}],
                                  "generationConfig": {"maxOutputTokens": 64}}, model),
        "image": (f"/api/gemini?model={IMAGE_MODEL}", {"contents": [{"role": "user", "parts": [{"text": f"A small seamless red brick texture, square. ({nonce})"}]}],
                                                        "generationConfig": {"responseModalities": ["IMAGE"]}}, IMAGE_MODEL),
        "tts": ("/api/tts", {"text": f"Walk-In is ready. {nonce[:4]}"}, "ElevenLabs"),
    }
    ok = True
    for name, (path, body, label) in checks.items():
        if a.only and name != a.only:
            continue
        status, secs, data, ctype = call(base, path, body)
        good = status == 200
        ok &= good
        flag = "OK  " if good else "FAIL"
        slow = "  SLOW" if good and secs > SLOW_S[name] else ""
        print(f"  {flag} {name:<5} {label:<26} {status if status else '---'}  {secs:5.1f} s{slow}  {detail(status, data, ctype)}")

    try:
        with urllib.request.urlopen(base + "/api/health", timeout=10) as r:
            h = json.loads(r.read())
        print(f"Quota: {h.get('calls_last_minute', '?')} calls in the last minute, {h.get('calls_today', '?')} today, "
              f"{h.get('rate_limited', 0)} rate-limited; limits/min {h.get('limits_per_min')}; last upstream {h.get('last_upstream')}; "
              f"cache {h.get('cache')}")
    except Exception:
        pass
    print("READY" if ok else "NOT READY: fix the FAIL lines before going on stage")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
