# Walk-In

**Homes.com gets you into the house. Walk-In lets you live in it.**

Put your phone in a headset, walk a real home that has been scanned and digitally emptied, and arrange real-size
furniture with your bare hands. Pinch to grab, twist with both hands to rotate, and it tells you whether it fits.

Built at HackPrinceton Fall 2026 for the CoStar Group track, on Matterport digital twins (360 panoramas, the
defurnished view, wall graph with doorways, room dimensions and the empty-house mesh).

## How it works
- Every scan point's 360 photo is drawn around you with its own rotation, in the house's real coordinates (metres).
- Furniture is placed in those same coordinates, so it stays put and lines up from every scan point.
- The empty-house mesh hides furniture behind real walls; the room outline gives a live "fits / doesn't fit".
- MediaPipe tracks both hands from the phone camera; your hands are drawn in 3D in front of you.
- Point at a wall and say *"put red brick wallpaper on this wall"*, or *"stage this as a cosy living
  room"*, or *"furnish the whole house"* — the agent's tools are the viewer's own functions, and it
  reads the rooms, openings and dimensions from the twin rather than guessing.

## Run
```bash
cp .env.example .env    # fill in keys from /costar-keys
python prep_house.py zvKHR9DHNjJ
python serve.py         # then open http://localhost:8000/?m=zvKHR9DHNjJ
```
For a phone: `cloudflared tunnel --url http://localhost:8000` and open the HTTPS link.

### No keys?

The whole thing runs without a Matterport key, a Gemini key or a network, on a synthetic house:

```bash
python3 tools/fake_house.py          # writes data/fixture, no keys, ~10 s
GEMINI_MOCK=1 python3 serve.py       # then open http://localhost:8000/?m=fixture
```

All seven demo beats work there, the sofa through the 1.15 m doorway included. The mock picks a tool
from your words and even generates a wall tile.

Once it is up, stand inside a room and run `await walkin.preflight()` in the console: nine pass/fail
lines covering the house, the agent, staging, physics, the wallpaper tiles and the frame rate.

See `CLAUDE.md` for the data notes and the coordinate conventions, `docs/demo-runbook.md` for the
three-minute run and `docs/demo-card.md` for the one-screen version.
