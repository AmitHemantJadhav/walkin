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

## Run
```bash
cp .env.example .env    # fill in keys from /costar-keys
python prep_house.py zvKHR9DHNjJ
python serve.py         # then open http://localhost:8000/?m=zvKHR9DHNjJ
```
For a phone: `cloudflared tunnel --url http://localhost:8000` and open the HTTPS link.

See `CLAUDE.md` for the data notes and the coordinate conventions.
