# agents/amit.md — Amit's agent (XR & hands)

**Plan:** Claude Max. Loop every 12 min (`scripts/agent-loop.sh amit`). You can take over `handoff` issues.
**GitHub:** AmitHemantJadhav. **Branch:** `amit`. **Lane:** being inside the house — headset, hands, pointing, walls.

## You own
`app.js`, `hands.js`, `scripts/live.sh`, and (small, additive) `index.html`.
You are the only agent that edits `app.js`. Teammates ask you for hooks; add them promptly and announce them in your PR.

## Your tasks (issues labelled `owner:amit`, in order)
- **A1** Headset performance on iPhone: ≥45 fps in headset mode with hands on. Adaptive pixel ratio, sphere 64×32,
  skip hand drawing when no hand, throttle hand detection to every other frame on mobile. Log fps in Debug.
- **A2** Gesture polish: one-euro filter on landmarks, grab radius 0.4 m around the pinch point, pinch-to-teleport
  only when pointing at a puck for 300 ms, two-hand twist and carry stable.
- **A3** `walkin.pointer`: updated every frame from the active hand ray (or screen centre without hands):
  `{type: 'wall'|'floor'|'furniture'|null, wall: {floor, index, a, b}, point: [x,y,z], room}`. Wall hit = ray vs
  wall quads built from `house.floors[].walls` (skip doorways). Draw a subtle highlight on the pointed wall.
  Shruti's agent needs this for "this wall" — prioritise it.
- **A4** `walkin.setWallMaterial(wall, textureUrl, tileMetres = 1)`: a quad 1 cm in front of the wall face toward
  the camera, height = room height, cut around doorway openings, texture repeated at real scale, multiplied by the
  photo's luminance so lighting matches; occluded by the mesh like furniture; persists across scan points.
  `walkin.clearWallMaterial(wall)` too.
- **A5** In-headset radial menu: pinch and hold 0.6 s in empty space → ring of 6 options at the hand (Sofa, Bed,
  Table, Plant, Empty/Scanned, Talk). Talk calls `walkin.onTalk?.()` (Shruti implements it).
- **A6** Smoother pano transitions (ease + short fade through the mesh, or depth-aware blend).
- **A7** `scripts/live.sh` already serves `main`; keep it working; tell the team the tunnel URL in the status issue.

## Notes
- Calibration `{qMode:1, yaw:90, mirror:1}` is verified — don't touch it.
- Test every change in headset mode on a phone before asking for review if it touches rendering or hands.
