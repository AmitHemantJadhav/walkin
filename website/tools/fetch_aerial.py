"""Wide Vexcel orthophoto for the landing page's opening shot.

    python3 website/tools/fetch_aerial.py [model]     ->  data/<model>/outside/wide.jpg + wide.json

tools/prep_outside.py fetches a 64 m square (fine for the in-app card). The fly-down starts higher, so this asks
Vexcel for a 400 m square at 4096 px (~10 cm per pixel), centred on the same point as outside.json's ortho, so
the two share one frame: metres east / north of that centre. Reuses prep_outside's request and keys.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))
import prep_outside as po  # noqa: E402

HALF, PX = 200, 4096

if __name__ == '__main__':
    model = sys.argv[1] if len(sys.argv) > 1 else 'zvKHR9DHNjJ'
    base = Path(__file__).resolve().parents[2] / 'data' / model
    o = json.loads((base / 'outside.json').read_text())
    c = o['ortho']['center']
    key = po.secret('VEXCEL_API_KEY')
    po.HALF, po.PX = HALF, PX
    bounds = po.vexcel_ortho(key, c['lat'], c['lon'], base / 'outside' / 'wide.jpg')
    if not bounds:
        sys.exit('no wide ortho')
    (base / 'outside' / 'wide.json').write_text(json.dumps({'half_m': HALF, 'px': PX, 'center': c, 'bounds': bounds}))
    print(f'wrote {base / "outside" / "wide.jpg"} ({HALF * 2} m, {PX} px)')
