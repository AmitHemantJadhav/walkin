# CLAUDE.md — read this first

## Who you are
You are the coding agent of one Walk-In teammate. **Your identity is the current git branch**
(`git branch --show-current`): `amit`, `shaurya` or `shruti`.
1. Read `MAIN.md` (the whole project, the task list and the team protocol §7).
2. Read your own file: `agents/<your-branch>.md` (your role, files, plan, and limits).
3. If you were started by `scripts/agent-loop.sh`, also follow `agents/cycle.md` for one cycle and then stop.

You run under your teammate's own GitHub account and git identity. Write commits, PRs and comments as them:
plain, short, specific. **No AI attribution** anywhere (no `Co-Authored-By: Claude`, no "Generated with Claude Code").

## Run it
```bash
cp .env.example .env                    # keys from /costar-keys in the #costar-group Discord
python prep_house.py zvKHR9DHNjJ        # downloads one house into data/<model>/ (~30 s)
python serve.py                         # http://localhost:8000/?m=zvKHR9DHNjJ  (no-cache server)
cloudflared tunnel --url http://localhost:8000   # HTTPS link for phones (gyro + camera need HTTPS)
scripts/smoke.sh                        # run before every commit
```
`data/` and `.env` are git-ignored. The hackathon data is licensed for the event only.

## Files and owners
| File | What | Owner |
|---|---|---|
| `app.js`, `hands.js` | viewer core, headset, gyro, hands interaction | amit |
| `furniture.js` (+ new model/preset files) | catalog, GLB models, staging, fit check | shaurya |
| `agent.js` (new), `serve.py` relays, `prep_house.py` | Gemini agent, voice, data | shruti |
| `index.html` | UI shell — small additive edits only, mention them in the PR | shared |
| `MAIN.md`, `CLAUDE.md`, `agents/*`, `scripts/*` | team docs and tooling | humans (agents: only `agents/<you>.md`) |

New features go in new files and reach the viewer through `window.walkin`
(`house, cal, goTo, addFurniture, furniture, camera, scene, view, current, selected, roomAt, select, checkFit, FURNITURE`).
If you need a new hook in `app.js` and you are not amit, ask for it in an issue or PR comment.

## Facts (verified — do not change without re-checking)
- **World = Matterport model frame**: metres, **Z up**. Pano `position` = camera (~1.5 m up); `anchor.position.z` = floor.
- 360 images are equirectangular in a pano-local frame (y up, z forward = skybox face 1), built by `equirect()`
  (same mapping as CoStar's quickstart). Shader: `lon = atan(l.x, l.z)`, `lat = asin(l.y)`.
- local → model = `R(quaternion) · AXES · RotY(yaw) · Mirror` (AXES maps local y → model z).
  **Verified calibration `{qMode:1, yaw:90, mirror:1}`** on 4 scan points in 4 rooms: projecting a pano onto the floor,
  the wood floor stops exactly on the wall graph. The Debug button shows walls in red; keys Q, M, [ ], , . re-tune.
- Every pano has its own rotation (mostly about Z). Never assume a shared orientation.
- OBJ meshes are auto-rotated by `placeMesh()` (chooses the rotation that puts every scan point inside the mesh).

## Matterport / CoStar API notes (tested Nov 14)
`POST https://api.matterport.com/api/models/graph`, basic auth (API key = user, API token = password), production only,
≤10 req/s (shared keys). Signed URLs expire: re-query instead of caching URLs.
- `panoLocations { id label position rotation{x y z w} anchor{ id position neighbors floor{id} } skybox(resolution:"2k"){children} }`
  → `neighbors` is the navigation graph (anchor ids). Skybox faces: 0 up, 1–4 horizon, 5 down. `4k` exists.
- Defurnished view: `view(type:"matterport.model.defurnished"){id}` → query that id; same pano ids. All 211 residential splat houses have it.
- Walls: `floors { vertices{id position{x y}} edges{ type thickness vertices{id} openings{type width height lowerElevation relativeCenter} } }`.
  Rooms: `rooms { classifications{label} boundary{edges{id}} dimensions(units:metric){areaFloor width depth height} }`.
- Meshes: `assets { meshes(formats:"obj") { filename url } }` → `defurnished_50k.obj` (our occluder), `simple_planes.obj`.
- MatterPak (point cloud + textured OBJ): `bundle(id:"mp:matterpak"){ assets{ url } }` (not `assets.resources`).
- Splats (232 models): `https://beta-app.matterport.com/2026-princeton-hackathon/resources/<sid>/splat/splat.ply`.
  Matterport's own tour already has an "Outside" fly-in — not new, don't pitch it.
- CoStar kit join works: `homes_listing_id` ↔ `residential-listings.csv` (La Mirada → listing 221139020).
- Vexcel (LA + Houston): `property/extract`, `ortho/extract`, `oriented/extract`, `embedding/extract` (header `X-API-KEY`).
- Demo houses: `docs/walkin_candidates.csv`. La Mirada `zvKHR9DHNjJ` is the verified one.

## Gotchas
- Browsers cache ES modules hard → always use `serve.py`; `hands.js` is imported with `?v=Date.now()`.
- iPhone: gyro and camera need HTTPS (tunnel) and a tap to allow. No WebXR in Safari → we render side-by-side (`StereoEffect`).
- Handheld uses the front camera for hands; headset mode switches to the back camera.
- Pano sphere has `depthTest:false`; occluders write depth only (`colorWrite:false`); furniture renders after them.
- Units are metres everywhere. Z is up.
