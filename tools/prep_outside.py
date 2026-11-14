"""Outside + on the market for one house: Vexcel from above, the CoStar / Homes.com listing, in one JSON.

    python tools/prep_outside.py zvKHR9DHNjJ      ->  data/<model>/outside.json + data/<model>/outside/ortho.jpg

CoStar's own slide is "Inside, outside, on the market": Matterport inside, Vexcel outside, CoStar on the market.
This script gets the other two layers for a house we already walk inside. outside.js shows them before you walk in,
and agent.js gives the listing facts to John.

- Vexcel property/extract (POST {"wkt": POINT, "srid": 4326}): the parcel, every building footprint with roof shape,
  material and condition, and site detections (pool, solar, trees, hardscape, vehicles). The primary structure is the house.
- Vexcel ortho/extract: the latest orthophoto (~6 cm per pixel) of a square around that house, the same request as
  the CoStar quickstart's section 7. The hackathon keys cover Los Angeles and Houston only (anywhere else: 403).
- CoStar kit (COSTAR_KIT_ZIP + COSTAR_ZIP_PASSWORD): residential-listings.csv joins MatterportModelId to the
  listing, data/residential-listings.jsonl has price, beds, baths, sq ft, year built, and
  data/residential-listing-features.jsonl has the Homes.com highlights ("Living Room with Fireplace", ...).

Keys come from the environment, ./.env or ../.env (as prep_house.py). Each layer is optional: a missing key or an
uncovered area skips that layer with a message, and the script only fails when it got nothing at all.
Geometry is stored in metres east / north of the ortho centre, so the page needs no map projection.
"""
import csv
import io
import json
import math
import os
import sys
import time
import zipfile
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
M_PER_DEG = 111_320           # metres per degree of latitude
HALF = 32                     # the ortho is a square 2 × HALF metres wide around the house
PX = 1024                     # its size in pixels (~6 cm per pixel, about Vexcel's own resolution)
VEXCEL = "https://api.vexcelgroup.com/v2"


def secret(name):
    v = os.environ.get(name)
    for env in (Path(".env"), Path("../.env"), ROOT / ".env", ROOT.parent / ".env"):
        if not v and env.exists():
            for line in env.read_text().splitlines():
                k, _, val = line.partition("=")
                if k.strip() == name:
                    v = val.strip().strip('"').strip("'")
    return v or None


def find_file(name):
    """A path from .env may be relative to wherever the kit was unpacked: try the usual places."""
    if not name:
        return None
    p = Path(name).expanduser()
    for c in ([p] if p.is_absolute() else [Path.cwd() / p, ROOT / p, ROOT.parent / p, ROOT.parent.parent / p]):
        if c.exists():
            return c
    return None


def model_latlon(model):
    """Lat/lon of the Matterport model: docs/walkin_candidates.csv, else the quickstart's models_index.csv."""
    for f in (ROOT / "docs" / "walkin_candidates.csv", find_file("models_index.csv")):
        if f and Path(f).exists():
            for row in csv.DictReader(open(f, newline="")):
                if row.get("sid") == model and row.get("lat") and row.get("lon"):
                    return float(row["lat"]), float(row["lon"]), row.get("homes_listing_id") or None
    return None, None, None


def to_xy(lat0, lon0):
    k = M_PER_DEG * math.cos(math.radians(lat0))
    return lambda lon, lat: [round((lon - lon0) * k, 2), round((lat - lat0) * M_PER_DEG, 2)]


def parse_wkt_polys(wkt):
    """MULTIPOLYGON / POLYGON WKT -> list of rings [[lon, lat], ...] (outer rings and holes alike)."""
    rings, body = [], wkt[wkt.index("("):]
    for chunk in body.replace("(", " ( ").replace(")", " ) ").split("("):
        pts = chunk.split(")")[0].strip()
        if not pts:
            continue
        ring = [[float(a) for a in p.split()[:2]] for p in pts.split(",") if p.strip()]
        if len(ring) >= 3:
            rings.append(ring)
    return rings


def centroid(ring):
    xs, ys = zip(*ring)
    return sum(xs) / len(xs), sum(ys) / len(ys)


def num(v):
    try:
        return None if v in (None, "None", "") else float(v)
    except (TypeError, ValueError):
        return None


def flag(v):
    return {"True": True, "False": False, True: True, False: False}.get(v)


# ------------------------------------------------------------------ Vexcel
def vexcel_property(key, lat, lon):
    r = requests.post(f"{VEXCEL}/property/extract", headers={"X-API-KEY": key}, timeout=120,
                      json={"wkt": f"POINT({lon} {lat})", "srid": 4326})
    if r.status_code in (401, 403):
        print(f"  Vexcel property: HTTP {r.status_code} ({'key rejected' if r.status_code == 401 else 'area not covered: LA and Houston only'})")
        return None
    r.raise_for_status()
    feats = r.json().get("features") or []
    if not feats:
        print("  Vexcel property: no parcel at this point")
        return None
    return feats[0]


def vexcel_ortho(key, lat, lon, out):
    dlat, dlon = HALF / M_PER_DEG, HALF / (M_PER_DEG * math.cos(math.radians(lat)))
    w, e, s, n = lon - dlon, lon + dlon, lat - dlat, lat + dlat
    r = requests.post(f"{VEXCEL}/ortho/extract", headers={"X-API-KEY": key}, timeout=300, json={
        "wkt": f"POLYGON(({w} {s},{e} {s},{e} {n},{w} {n},{w} {s}))", "srid": 4326,
        "layer": "urban,urban-r,wide-area,urban-g", "crop": "bounding_box", "image-format": "jpeg",
        "destination-dimensions": f"{PX},{PX}", "attribution": "false"})
    if r.status_code in (401, 403):
        print(f"  Vexcel ortho: HTTP {r.status_code} ({'key rejected' if r.status_code == 401 else 'area not covered: LA and Houston only'})")
        return None
    r.raise_for_status()
    if not r.headers.get("Content-Type", "").startswith("image/"):
        print(f"  Vexcel ortho: expected an image, got {r.headers.get('Content-Type')}")
        return None
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(r.content)
    return {"w": w, "e": e, "s": s, "n": n}


def site_facts(feat, xy):
    p = feat["properties"]
    structures = []
    for s in p.get("structures") or []:
        rings = parse_wkt_polys(s.get("footprint.wkt") or "")
        structures.append({
            "primary": flag(s.get("primary-structure")) is True,
            "area_m2": num(s.get("footprint.area")),
            "type": s.get("building-type.class"),
            "roof_shape": s.get("roof-characteristics.shape.value"),
            "roof_material": s.get("roof-characteristics.material.class"),
            "roof_condition": num(s.get("roof-characteristics.condition")),   # Vexcel's 1-5 scale
            "solar": flag(s.get("roof-objects.solar.value")),
            "footprint": [[xy(*q) for q in ring] for ring in rings],
            "_center": centroid(rings[0]) if rings else None,
        })
    geo = feat.get("geometry") or {}
    parcel = []
    if geo.get("type") == "MultiPolygon":
        parcel = [[xy(*q) for q in ring] for poly in geo["coordinates"] for ring in poly]
    elif geo.get("type") == "Polygon":
        parcel = [[xy(*q) for q in ring] for ring in geo["coordinates"]]
    site = {
        "pool": flag(p.get("pool.detected")),
        "solar": any(s.get("solar") for s in structures),
        "tree_cover_pct": num(p.get("parcel-tree-cover.percent")),
        "hardscape_m2": num(p.get("hardscapes.area")),
        "vehicles": int(num(p.get("vehicles.count")) or 0),
        "trampoline": flag(p.get("trampoline.detected")),
        "sport_court": flag(p.get("sport-court.detected")),
        "structures": len(structures),
    }
    meta = {"date": (p.get("metadata.ortho-date-estimate") or "")[:10] or None, "gsd_m": num(p.get("metadata.gsd")),
            "collection": p.get("metadata.collection"), "layer": p.get("metadata.layer-name")}
    return structures, parcel, site, meta


# ------------------------------------------------------------------ CoStar kit
def costar_listing(model, homes_id):
    kit_path, pw = find_file(secret("COSTAR_KIT_ZIP")), secret("COSTAR_ZIP_PASSWORD")
    if not kit_path or not pw:
        print("  CoStar: COSTAR_KIT_ZIP (the kit zip) or COSTAR_ZIP_PASSWORD not found, skipping the listing")
        return None
    kit = zipfile.ZipFile(kit_path)
    kit.setpassword(pw.encode())
    try:
        index = kit.read("residential-listings.csv").decode("utf-8", "replace")
    except RuntimeError:
        print("  CoStar: the kit rejected COSTAR_ZIP_PASSWORD, skipping the listing")
        return None
    listing_id = None
    for row in csv.DictReader(io.StringIO(index)):  # the kit's own join: MatterportModelId -> listing
        if row.get("MatterportModelId") == model or (homes_id and row.get("ResidentialListingId") == str(homes_id)):
            listing_id, homes_id = int(row["ListingId"]), int(row["ResidentialListingId"])
            break
    if not listing_id:
        print(f"  CoStar: no listing for {model} in residential-listings.csv")
        return None
    rec = feat = None
    needle = str(listing_id).encode()
    with kit.open("data/residential-listings.jsonl") as f:
        for line in f:
            if needle in line:
                d = json.loads(line)
                if d.get("id") == listing_id:
                    rec = d
                    break
    with kit.open("data/residential-listing-features.jsonl") as f:
        for line in f:
            if needle in line:
                d = json.loads(line)
                if d.get("id") == listing_id:
                    feat = d
                    break
    if not rec:
        print(f"  CoStar: listing {listing_id} not in residential-listings.jsonl")
        return None
    enums = json.loads(kit.read("schemas/enums.json"))
    prop, reso = rec.get("property") or {}, rec.get("resoValues") or {}
    st, addr = reso.get("structure") or {}, prop.get("address") or {}
    remarks = (rec.get("remarks") or "").strip()
    first = ". ".join(remarks.split(". ")[:2]).strip()
    out = {
        "source": "CoStar kit: residential-listings + residential-listing-features (Homes.com)",
        "listing_id": listing_id, "homes_listing_id": homes_id,
        "address": addr.get("fullStreetAddress"), "city": addr.get("city"), "state": addr.get("state"), "zip": addr.get("zip"),
        "lat": addr.get("latitude"), "lon": addr.get("longitude"),
        "status": enums.get("ForSaleStatus", {}).get(str(rec.get("forSaleStatus"))),
        "list_date": (rec.get("listDate") or "")[:10] or None,
        "price": rec.get("currentPrice"), "original_price": rec.get("originalPrice"),
        "beds": prop.get("bedsMax") or prop.get("bedsMin"), "baths": prop.get("bathsMax") or prop.get("bathsMin"),
        "baths_full": prop.get("bathsFull"), "baths_half": prop.get("bathsHalf"),
        "sqft": prop.get("sqftMax") or prop.get("sqftMin"), "year_built": prop.get("yearBuilt") or st.get("yearBuilt"),
        "stories": prop.get("stories"), "lot_acres": prop.get("lotSizeAcresMax"),
        "style": st.get("architecturalStyle"), "parking_spaces": prop.get("totalParkingSpaces"),
        "fireplaces": st.get("fireplacesTotal"), "has_fireplace": reso.get("hasFireplace"),
        "hardwood_floors": reso.get("hasHardwoodFloors"), "has_garage": reso.get("hasGarage"),
        "has_basement": reso.get("hasBasement"), "hoa": (reso.get("hoa") or {}).get("hasAssociation"),
        "summary": (first + ("." if first and not first.endswith(".") else "")) or None,
    }
    if feat:
        out["highlights"] = [h["text"] for h in feat.get("highlights") or [] if h.get("text")]
        out["details"] = {f"{s.get('subcategory')}": s.get("lines") for s in feat.get("sections") or [] if s.get("lines")}
    return {k: v for k, v in out.items() if v is not None}


# ------------------------------------------------------------------ main
def main():
    if len(sys.argv) < 2:
        sys.exit("usage: python tools/prep_outside.py <model id>")
    model = sys.argv[1]
    out_dir = ROOT / "data" / model
    if not (out_dir / "house.json").exists():
        sys.exit(f"data/{model}/house.json not found: run python prep_house.py {model} first")
    lat, lon, homes_id = model_latlon(model)
    t0 = time.time()
    result = {"model": model, "created": time.strftime("%Y-%m-%dT%H:%M:%S")}

    print("CoStar listing …")
    listing = costar_listing(model, homes_id)
    if listing:
        result["listing"] = listing
        print(f"  {listing.get('address')}: ${listing.get('price'):,.0f}, {listing.get('beds')} bd / {listing.get('baths')} ba, "
              f"{listing.get('sqft')} sq ft, built {listing.get('year_built')}, {len(listing.get('highlights', []))} highlights")
        if lat is None and listing.get("lat"):
            lat, lon = listing["lat"], listing["lon"]
    if lat is None:
        sys.exit(f"no lat/lon for {model} (docs/walkin_candidates.csv, models_index.csv or the listing)")
    result["model_latlon"] = {"lat": lat, "lon": lon}

    key = secret("VEXCEL_API_KEY")
    if not key:
        print("Vexcel: VEXCEL_API_KEY not found, skipping the aerial view")
    else:
        print("Vexcel property …")
        clat, clon, feat = lat, lon, None
        try:
            feat = vexcel_property(key, lat, lon)
        except requests.RequestException as e:
            print(f"  Vexcel property failed: {e}")
        if feat:
            prim = [s for s in feat["properties"].get("structures") or [] if flag(s.get("primary-structure"))]
            rings = parse_wkt_polys(prim[0].get("footprint.wkt") or "") if prim else []
            if rings:                                      # centre the photo on the house, not on the scan's GPS
                clon, clat = centroid(rings[0])
        xy = to_xy(clat, clon)
        print("Vexcel ortho …")
        try:
            bounds = vexcel_ortho(key, clat, clon, out_dir / "outside" / "ortho.jpg")
        except requests.RequestException as e:
            print(f"  Vexcel ortho failed: {e}")
            bounds = None
        if bounds:
            result["ortho"] = {"file": "outside/ortho.jpg", "half_m": HALF, "px": PX,
                               "center": {"lat": clat, "lon": clon}, "bounds": bounds, "source": "Vexcel ortho/extract"}
            result["model_xy"] = xy(lon, lat)                 # where the scan's GPS says the house is, in metres
        if feat:
            structures, parcel, site, meta = site_facts(feat, xy)
            for s in structures:
                s.pop("_center", None)
            result["structures"], result["parcel"], result["site"] = structures, parcel, site
            if "ortho" in result:
                result["ortho"].update({k: v for k, v in meta.items() if v is not None})
            house = next((s for s in structures if s["primary"]), None)
            if house:
                print(f"  house footprint {house['area_m2']} m², {house['roof_shape']} {house['roof_material']} roof, "
                      f"{site['structures']} structures, pool {site['pool']}, solar {site['solar']}, trees {site['tree_cover_pct']}%")

    if "listing" not in result and "ortho" not in result:
        sys.exit("got neither the listing nor the aerial view: nothing written")
    (out_dir / "outside.json").write_text(json.dumps(result, indent=1))
    print(f"wrote data/{model}/outside.json ({', '.join(k for k in ('listing', 'ortho', 'structures') if k in result)}) "
          f"in {time.time() - t0:.1f} s")


if __name__ == "__main__":
    main()
