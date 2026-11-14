"""Download everything Walk-In needs for one house into walkin/data/<model>/.

Run from the walkin folder (it reads ../.env, or a .env here):
    python prep_house.py                 # La Mirada (zvKHR9DHNjJ)
    python prep_house.py 7axUS8XrcSc     # any model id from models_index.csv

Writes:
    data/<model>/house.json              panos, rooms, walls (+ doors), floors
    data/<model>/panos/<pano>.jpg        furnished 360 (equirectangular)
    data/<model>/panos/<pano>_empty.jpg  defurnished 360 (when the model has that view)
    data/<model>/plan_<floor>.jpg        Matterport's floor plan image per floor
"""
import io, json, math, os, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from PIL import Image

API = "https://api.matterport.com/api/models/graph"
MODEL = sys.argv[1] if len(sys.argv) > 1 else "zvKHR9DHNjJ"
WIDTH = int(os.environ.get("PANO_WIDTH", "2048"))  # 2048 is phone friendly; 4096 for laptop demos
OUT = Path("data") / MODEL
(OUT / "panos").mkdir(parents=True, exist_ok=True)


def secret(name):
    v = os.environ.get(name)
    for env in (Path(".env"), Path("../.env")):
        if not v and env.exists():
            for line in env.read_text().splitlines():
                k, _, val = line.partition("=")
                if k.strip() == name:
                    v = val.strip().strip('"').strip("'")
    if not v:
        sys.exit(f"{name} not found in the environment, ./.env or ../.env")
    return v


S = requests.Session()
S.auth = (secret("MATTERPORT_API_KEY"), secret("MATTERPORT_API_TOKEN"))


class GraphError(RuntimeError):
    pass


def graph(query, **variables):
    r = S.post(API, json={"query": query, "variables": variables}, timeout=120)
    if r.status_code in (401, 403):
        sys.exit(f"Matterport rejected the key (HTTP {r.status_code}). Check MATTERPORT_API_KEY / MATTERPORT_API_TOKEN.")
    r.raise_for_status()
    body = r.json()
    if body.get("errors"):
        raise GraphError("; ".join(e.get("message", "?") for e in body["errors"]))
    return body["data"]


def graph_first(label, *queries, **variables):
    """Try the richest query first; fall back to simpler ones if a field isn't available to our key."""
    for i, q in enumerate(queries):
        try:
            return graph(q, **variables), i
        except GraphError as e:
            print(f"  {label}: variant {i} failed ({str(e)[:140]}), trying a simpler one")
    sys.exit(f"{label}: every query variant failed")


# ---------------------------------------------------------------- panoramas
PANO_FIELDS_FULL = """id label position { x y z } rotation { x y z w }
    anchor { id position { x y z } neighbors floor { id } }
    skybox(resolution: "2k") { children }"""
PANO_FIELDS_MID = """id label position { x y z } rotation { x y z w }
    anchor { id position { x y z } floor { id } }
    skybox(resolution: "2k") { children }"""
PANO_FIELDS_MIN = """id label position { x y z } skybox(resolution: "2k") { children }"""


def q_panos(fields, with_view=True):
    view = 'view(type: "matterport.model.defurnished") { id }' if with_view else ""
    return f"""query($id: ID!) {{ model(id: $id) {{ name address {{ address }}
        panoLocations {{ {fields} }} {view} }} }}"""


print(f"Model {MODEL}: panoramas")
data, variant = graph_first("panos", q_panos(PANO_FIELDS_FULL), q_panos(PANO_FIELDS_MID), q_panos(PANO_FIELDS_MIN),
                            q_panos(PANO_FIELDS_MIN, with_view=False), id=MODEL)
m = data["model"]
panos_raw = m["panoLocations"]
empty_view = (m.get("view") or {}).get("id")
print(f"  {len(panos_raw)} panos, rotation={'yes' if variant <= 1 else 'no'}, neighbors={'yes' if variant == 0 else 'no'}, "
      f"defurnished view={'yes' if empty_view else 'no'}")

empty_faces = {}
if empty_view:
    try:
        d2 = graph(f"""query($id: ID!) {{ model(id: $id) {{ panoLocations {{ id skybox(resolution: "2k") {{ children }} }} }} }}""", id=empty_view)
        empty_faces = {p["id"]: p["skybox"]["children"] for p in d2["model"]["panoLocations"] if p.get("skybox")}
    except GraphError as e:
        print(f"  defurnished panos failed: {e}")


def equirect(faces, width=WIDTH):
    """Six skybox faces -> one equirectangular image (same mapping as the CoStar quickstart).
    Pano-local frame: y up, z forward (face 1), x = sin(lon)."""
    h = width // 2
    lon = (np.arange(width) + 0.5) / width * 2 * np.pi - np.pi
    lat = np.pi / 2 - (np.arange(h) + 0.5) / h * np.pi
    lon, lat = np.meshgrid(lon, lat)
    x, y, z = np.cos(lat) * np.sin(lon), np.sin(lat), np.cos(lat) * np.cos(lon)
    ax, ay, az = np.abs(x), np.abs(y), np.abs(z)
    out = np.zeros((h, width, 3), np.uint8)
    n = faces[0].width
    arrays = [np.asarray(f) for f in faces]
    for k, mask, u, v in [
        (1, (az >= ax) & (az >= ay) & (z > 0), x / az, -y / az),
        (2, (ax >= ay) & (ax >= az) & (x > 0), -z / ax, -y / ax),
        (3, (az >= ax) & (az >= ay) & (z < 0), -x / az, -y / az),
        (4, (ax >= ay) & (ax >= az) & (x < 0), z / ax, -y / ax),
        (0, (ay >= ax) & (ay >= az) & (y > 0), x / ay, z / ay),
        (5, (ay >= ax) & (ay >= az) & (y < 0), x / ay, -z / ay),
    ]:
        col = np.clip(((u[mask] + 1) / 2 * n).astype(int), 0, n - 1)
        row = np.clip(((v[mask] + 1) / 2 * n).astype(int), 0, n - 1)
        out[mask] = arrays[k][row, col]
    return Image.fromarray(out)


def fetch_image(url, tries=3):
    for t in range(tries):
        try:
            r = requests.get(url, timeout=120)
            r.raise_for_status()
            return Image.open(io.BytesIO(r.content)).convert("RGB")
        except Exception:
            if t == tries - 1:
                raise
            time.sleep(1 + t)


def build(job):
    pid, urls, path = job
    if path.exists():
        return pid, "cached"
    faces = [fetch_image(u) for u in urls]
    equirect(faces).save(path, quality=85)
    return pid, "ok"


jobs = []
for p in panos_raw:
    if (p.get("skybox") or {}).get("children"):
        jobs.append((p["id"], p["skybox"]["children"], OUT / "panos" / f"{p['id']}.jpg"))
    if p["id"] in empty_faces:
        jobs.append((p["id"], empty_faces[p["id"]], OUT / "panos" / f"{p['id']}_empty.jpg"))
print(f"  building {len(jobs)} 360 images at {WIDTH}x{WIDTH // 2} (cached ones are skipped)...")
t0 = time.time()
with ThreadPoolExecutor(6) as pool:
    for i, (pid, status) in enumerate(pool.map(build, jobs), 1):
        if i % 10 == 0 or i == len(jobs):
            print(f"    {i}/{len(jobs)}  ({time.time() - t0:.0f}s)")

anchor_to_pano = {(p.get("anchor") or {}).get("id"): p["id"] for p in panos_raw if p.get("anchor")}
panos = []
for p in panos_raw:
    a = p.get("anchor") or {}
    pos = [p["position"]["x"], p["position"]["y"], p["position"]["z"]]
    floor_z = a["position"]["z"] if a.get("position") else pos[2] - 1.5
    rot = p.get("rotation")
    panos.append(dict(
        id=p["id"], label=p["label"], pos=pos, floorZ=floor_z,
        rot=[rot["x"], rot["y"], rot["z"], rot["w"]] if rot else None,
        floor=(a.get("floor") or {}).get("id"),
        neighbors=[anchor_to_pano[n] for n in (a.get("neighbors") or []) if n in anchor_to_pano],
        img=f"panos/{p['id']}.jpg" if (OUT / "panos" / f"{p['id']}.jpg").exists() else None,
        imgEmpty=f"panos/{p['id']}_empty.jpg" if (OUT / "panos" / f"{p['id']}_empty.jpg").exists() else None,
    ))

# ---------------------------------------------------------------- rooms, walls, doors
WALL_FULL = """floors { id label sequence vertices { id position { x y } }
    edges { id type thickness vertices { id } openings { type width height lowerElevation relativeCenter } } }"""
WALL_MIN = """floors { id label vertices { id position { x y } } edges { id type thickness vertices { id } } }"""
ROOMS = """rooms { id label floor { id } classifications { label } boundary { edges { id } }
    dimensions(units: metric) { areaFloor width depth height } }"""
PLANS = """assets { floorplans(provider: "matterport") { format flags url resolution origin { x y } floor { id } } }"""
print("Rooms, walls and doors")
data, variant = graph_first("rooms", f"query($id: ID!) {{ model(id: $id) {{ {WALL_FULL} {ROOMS} {PLANS} }} }}",
                            f"query($id: ID!) {{ model(id: $id) {{ {WALL_MIN} {ROOMS} {PLANS} }} }}",
                            f"query($id: ID!) {{ model(id: $id) {{ {WALL_MIN} {ROOMS} }} }}", id=MODEL)
m = data["model"]

edges_by_id, floors = {}, []
for f in m["floors"]:
    V = {v["id"]: [v["position"]["x"], v["position"]["y"]] for v in f.get("vertices") or []}
    walls = []
    for e in f.get("edges") or []:
        vs = [V.get(v["id"]) for v in e.get("vertices") or []]
        if len(vs) != 2 or None in vs:
            continue
        edges_by_id[e["id"]] = vs
        walls.append(dict(a=vs[0], b=vs[1], type=e.get("type") or "wall", thickness=e.get("thickness") or 0.12,
                          openings=[dict(type=o.get("type"), width=o.get("width"), height=o.get("height"),
                                         bottom=o.get("lowerElevation"), at=o.get("relativeCenter"))
                                    for o in (e.get("openings") or []) if o]))
    floors.append(dict(id=f["id"], label=f.get("label"), sequence=f.get("sequence"), walls=walls))


def room_polygon(room):
    edges = [edges_by_id[e["id"]] for e in (room.get("boundary") or {}).get("edges", []) if e["id"] in edges_by_id]
    if not edges:
        return None
    key = lambda p: (round(p[0], 4), round(p[1], 4))
    loop, rest = [edges[0][0], edges[0][1]], edges[1:]
    while rest:
        for i, (a, b) in enumerate(rest):
            if key(a) == key(loop[-1]) or key(b) == key(loop[-1]):
                loop.append(b if key(a) == key(loop[-1]) else a)
                rest.pop(i)
                break
        else:
            break
    return loop[:-1] if key(loop[0]) == key(loop[-1]) else loop


rooms = []
for r in m["rooms"]:
    label = ((r.get("classifications") or [{}])[0] or {}).get("label") or r.get("label") or "Room"
    if label == "Void":
        continue
    rooms.append(dict(id=r["id"], label=label, floor=(r.get("floor") or {}).get("id"), poly=room_polygon(r),
                      dims=r.get("dimensions") or {}))

plans = []
for fp in (m.get("assets") or {}).get("floorplans") or []:
    if fp.get("format") == "jpg" and fp.get("flags") == ["photogramy"] and fp.get("url") and fp.get("origin"):
        fid = (fp.get("floor") or {}).get("id") or "all"
        path = OUT / f"plan_{fid}.jpg"
        try:
            fetch_image(fp["url"]).save(path, quality=85)
            plans.append(dict(floor=fid, img=path.name, resolution=fp["resolution"], origin=[fp["origin"]["x"], fp["origin"]["y"]]))
        except Exception as e:
            print(f"  floor plan download failed: {e}")

# ---------------------------------------------------------------- meshes (OBJ): the empty-house mesh is used for occlusion
print("Meshes")
meshes = []
try:
    md = graph("""query($id: ID!) { model(id: $id) { assets { meshes(formats: "obj") { filename resolution status url } } } }""", id=MODEL)
    (OUT / "mesh").mkdir(exist_ok=True)
    for me in md["model"]["assets"]["meshes"] or []:
        if me.get("status") != "available" or not me.get("url"):
            continue
        path = OUT / "mesh" / me["filename"]
        if not path.exists():
            r = requests.get(me["url"], timeout=300)
            r.raise_for_status()
            path.write_bytes(r.content)
        meshes.append(dict(file=f"mesh/{me['filename']}", resolution=me.get("resolution"), mb=round(path.stat().st_size / 1e6, 1)))
        print(f"  {me['filename']} ({me.get('resolution')}, {path.stat().st_size / 1e6:.1f} MB)")
except Exception as e:
    print(f"  mesh download failed: {e}")

name = None
try:
    name = graph("query($id: ID!) { model(id: $id) { name } }", id=MODEL)["model"]["name"]
except Exception:
    pass
house = dict(model=MODEL, name=name, panos=panos, floors=floors, rooms=rooms, plans=plans, meshes=meshes,
             created=time.strftime("%Y-%m-%d %H:%M"))
(OUT / "house.json").write_text(json.dumps(house))

rots = [p["rot"] for p in panos if p["rot"]]
same = rots and all(np.allclose(np.abs(r), np.abs(rots[0]), atol=1e-3) for r in rots)
print(f"\nWrote {OUT / 'house.json'}: {len(panos)} panos, {len(rooms)} rooms, "
      f"{sum(len(f['walls']) for f in floors)} walls, {sum(len(w['openings']) for f in floors for w in f['walls'])} openings, "
      f"{len(plans)} floor plans")
print(f"Pano rotations: {'none returned' if not rots else ('all the same' if same else 'they differ per pano')}"
      + (f", e.g. {rots[0]}" if rots else ""))
print(f"Next: python3 -m http.server 8000   then open http://localhost:8000/?m={MODEL}")
