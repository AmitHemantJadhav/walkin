"""Describe every scan point of a house once, so John can take you to "the room with the fireplace" or
"somewhere sunny" (CoStar open problem: search inside panoramas).

    python tools/prep_captions.py zvKHR9DHNjJ                 # uses the relay of a running serve.py on :8000
    python tools/prep_captions.py zvKHR9DHNjJ --relay http://localhost:8013/api/gemini --force

For each pano in data/<model>/house.json it sends the furnished 360 photo (downscaled to 1024 x 512) to the
/api/gemini relay of serve.py (Gemini, or OpenRouter as fallback; the key stays in serve.py) and asks for strict JSON:
    {caption: <= 12 words, light: sunny | bright | dim, features: [fixed things], furniture: [two-word names]}
The room label (from the house's own room polygons) is added, and everything is cached in
data/<model>/captions.json keyed by pano id. Panos already described are skipped unless --force.
Calls go one at a time, with a pause between them, and back off on 429, so a shared relay keeps headroom.
data/ is git-ignored (event-licensed data); run this per house after prep_house.py.
"""
import argparse, base64, io, json, re, sys, time
from pathlib import Path

import requests
from PIL import Image

PROMPT = """This is an equirectangular 360-degree photo taken inside a home{room}.
Reply with JSON only, no prose, exactly these keys:
{{"caption": "...", "light": "...", "features": [...], "furniture": [...]}}
- caption: at most 12 words, what makes this spot recognisable (e.g. "sunlit living room with a brick fireplace and bay window").
- light: "sunny" if direct sunlight falls on the floor or walls, "bright" if lots of daylight but no direct sun, else "dim".
- features: up to 6 short tags for fixed things a visitor would ask for, e.g. fireplace, bay window, kitchen island,
  hardwood floor, view of garden, french doors, built-in shelves, skylight, tiled shower, double sink.
- furniture: up to 8 movable pieces you can see, two words each, e.g. "green sofa", "coffee table"."""

LIGHTS = {"sunny", "bright", "dim"}


def point_in_poly(x, y, poly):
    inside, j = False, len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i][:2]
        xj, yj = poly[j][:2]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def room_at(house, x, y, floor):  # same rule as roomAt() in app.js
    for r in house.get("rooms", []):
        poly = r.get("poly") or []
        if len(poly) > 2 and (not floor or not r.get("floor") or r["floor"] == floor) and point_in_poly(x, y, poly):
            return r
    return None


def small_jpeg(path, width=1024):
    im = Image.open(path).convert("RGB")
    im = im.resize((width, width // 2), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=80)
    return base64.b64encode(buf.getvalue()).decode()


def parse(text):
    """The first {...} in the reply, cleaned to the four keys."""
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        raise ValueError(f"no JSON in reply: {text[:120]!r}")
    j = json.loads(m.group(0))
    words = str(j.get("caption", "")).split()
    light = str(j.get("light", "")).strip().lower()
    clean = lambda xs, n: [str(x).strip().lower() for x in (xs or []) if str(x).strip()][:n]
    return {"caption": " ".join(words[:12]), "light": light if light in LIGHTS else "bright",
            "features": clean(j.get("features"), 6), "furniture": clean(j.get("furniture"), 8)}


def describe(relay, img_b64, room_label, tries=6):
    room = f", in the {room_label}" if room_label else ""
    body = {"contents": [{"role": "user", "parts": [
        {"text": PROMPT.format(room=room)}, {"inlineData": {"mimeType": "image/jpeg", "data": img_b64}}]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 400}}
    wait = 10
    for _ in range(tries):
        r = requests.post(relay, json=body, timeout=90)
        if r.status_code == 429:  # the relay's per-minute bucket (or the provider's): wait, then retry
            time.sleep(int(r.headers.get("Retry-After") or wait))
            wait = min(wait * 2, 60)
            continue
        r.raise_for_status()
        parts = r.json()["candidates"][0]["content"]["parts"]
        return parse("".join(p.get("text", "") for p in parts))
    raise RuntimeError("relay kept answering 429")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model")
    ap.add_argument("--relay", default="http://localhost:8000/api/gemini")
    ap.add_argument("--data", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--force", action="store_true", help="describe every pano again")
    ap.add_argument("--pause", type=float, default=8.0, help="seconds between calls (the relay allows ~8 a minute)")
    a = ap.parse_args()

    base = Path(a.data) / a.model
    house = json.loads((base / "house.json").read_text())
    out_path = base / "captions.json"
    out = json.loads(out_path.read_text()) if out_path.exists() and not a.force else {}
    todo = [p for p in house["panos"] if p.get("img") and (a.force or p["id"] not in out)]
    print(f"{a.model}: {len(house['panos'])} panos, {len(todo)} to describe, relay {a.relay}")
    for k, p in enumerate(todo):
        room = room_at(house, p["pos"][0], p["pos"][1], p.get("floor"))
        label = room["label"] if room else None
        t = time.time()
        try:
            d = describe(a.relay, small_jpeg(base / p["img"]), label)
        except Exception as e:  # keep going; a rerun picks up what is missing
            print(f"  {p['id']}: failed ({e})")
            continue
        out[p["id"]] = {"room": label, "room_id": room["id"] if room else None, **d}
        out_path.write_text(json.dumps(out, indent=1))  # after every pano, so an interrupted run keeps its work
        print(f"  [{k + 1}/{len(todo)}] {label or '-'}: {d['caption']} ({d['light']}; {', '.join(d['features'])}) "
              f"{time.time() - t:.1f}s")
        if k + 1 < len(todo):
            time.sleep(a.pause)
    print(f"wrote {out_path} ({len(out)} panos)")


if __name__ == "__main__":
    sys.exit(main())
