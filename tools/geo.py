"""Where north is, for every prepped house.

The sun and the view out of a window both need the model frame's compass bearing, and nothing in
house.json carries it. Matterport's API does: model.geocoordinates.rotation is the quaternion between
East-North-Up and the model frame, populated by processing on every model tried so far.

Convention, verified rather than read off the docs: treat the quaternion as model -> ENU. Under that
reading La Mirada's +Y axis bears 266.4 degrees, and an independent derivation from OpenStreetMap -
street centreline, building footprint and the front-door wall - gave 269 +/- 2. The other reading
gives 93.6, which is the mirror and wrong. So: bearing(+Y) = compass(R(q) * (0,1,0)).

Writes data/<model>/geo.json = {lat, lon, bearingY, rotation, source}. Keys are read from the
environment inside this process and never printed.

Usage: python tools/geo.py            # every data/*/house.json
       python tools/geo.py <model-id>
"""
import glob
import json
import math
import os
import sys

import requests
from dotenv import load_dotenv

load_dotenv(dotenv_path='.env')
Q = """query($id: ID!) { model(id: $id) { id name
  geocoordinates { latitude longitude rotation { x y z w } source } } }"""


def bearing_of_y(q):
    """Compass bearing (clockwise from north) of the model's +Y axis."""
    z, w = q['z'], q['w']
    ang = 2 * math.atan2(z, w)                       # pure rotation about Z in every model seen
    east, north = -math.sin(ang), math.cos(ang)      # R(ang) applied to (0, 1)
    return (math.degrees(math.atan2(east, north)) + 360) % 360


def main():
    key, tok = os.environ.get('MATTERPORT_API_KEY'), os.environ.get('MATTERPORT_API_TOKEN')
    if not (key and tok):
        sys.exit('MATTERPORT_API_KEY / MATTERPORT_API_TOKEN not set')
    models = sys.argv[1:] or [os.path.basename(os.path.dirname(p)) for p in glob.glob('data/*/house.json')
                               if not os.path.basename(os.path.dirname(p)).startswith('fixture')]
    for sid in models:
        r = requests.post('https://api.matterport.com/api/models/graph', auth=(key, tok),
                          json={'query': Q, 'variables': {'id': sid}}, timeout=30)
        m = ((r.json().get('data') or {}).get('model')) or {}
        g = m.get('geocoordinates')
        if not g or not g.get('rotation'):
            print(f'{sid}: no geocoordinates (status {r.status_code})')
            continue
        out = dict(model=sid, lat=g['latitude'], lon=g['longitude'], bearingY=round(bearing_of_y(g['rotation']), 2),
                   rotation=g['rotation'], source=g.get('source'))
        with open(os.path.join('data', sid, 'geo.json'), 'w') as f:
            json.dump(out, f, indent=1)
        print(f"{sid} {m.get('name')!r}: lat {out['lat']:.5f} lon {out['lon']:.5f}  +Y bears {out['bearingY']:.1f} deg  ({out['source']})")
        if sid == 'zvKHR9DHNjJ':
            ok = abs(((out['bearingY'] - 269 + 180) % 360) - 180) < 10
            print('   self-check against OSM 269 deg:', 'ok' if ok else 'MISMATCH - convention flipped?')


if __name__ == '__main__':
    main()
