# agents/shruti.md — Shruti's agent (agent, voice & story)

**Plan:** Claude **Pro** — your tokens run out first. Loop every 15 min (`scripts/agent-loop.sh shruti`).
Work in **small, finished steps**: commit and push after every working step, so nothing is lost when the limit hits.
When the limit hits, the loop script posts "This is my last commit for the next 5 hours." and labels your open
issues `handoff`; Amit's and Shaurya's agents take them over. When you're back, check which of your issues are
`taken-over` and skip those. You do not take over other people's issues.
**Branch:** `shruti`. **Lane:** the brain and the voice — and the story we tell the judges.

## You own
`agent.js` (new), the `/api/*` relays in `serve.py`, `prep_house.py`, and `docs/` (Devpost, video script, pitch).
Do not edit `app.js` — request hooks from amit in an issue or PR comment.

## Your tasks (issues labelled `owner:shruti`, in order)
- **R1** Relays in `serve.py`: `POST /api/gemini` (forwards to the Gemini API with `GEMINI_API_KEY` from `.env`),
  `POST /api/tts` (ElevenLabs with `ELEVENLABS_API_KEY`, returns audio). Keys never reach the browser. Add the key
  names to `.env.example`.
- **R2** `agent.js`: a Gemini agent with function calling. Tools map to `window.walkin`: `addFurniture`, `stageRoom`,
  `setWallMaterial`, `placeObject`, `goTo`, plus `describe_house` (rooms with sizes, current room, what's placed,
  CoStar listing facts). Send the current view (`renderer.domElement.toDataURL`) when the user says "this". Keep
  replies to one or two sentences — they are spoken.
- **R3** Voice: a Talk button and `walkin.onTalk` (pinch-hold menu) → Web Speech API speech-to-text → agent →
  `/api/tts` audio. If HackPrinceton has a Vapi prize, offer Vapi as the voice layer instead (ask in `needs-human`).
- **R4** Wallpaper: "red-brick wallpaper on this wall" → Gemini image model makes a seamless tile → `setWallMaterial(walkin.pointer.wall, url, tileMetres)`.
- **R5** Plant advice: use window openings and wall orientation (house lat/lon, sun) for light → suggest a plant,
  generate a preview image, `placeObject('plant-…', x, y)` where the user points.
- **R6** House picker (a small list of 3 houses) + run `prep_house.py` for two more from `docs/walkin_candidates.csv`.
- **R7** `docs/devpost.md`, `docs/video-script.md`, `docs/pitch.md` — draft by Saturday 18:00.

## Notes
- Check the current Gemini model names and the function-calling / image-generation docs before coding — they change.
- Until amit ships `walkin.pointer` and `setWallMaterial`, stub them in `agent.js` (log the call) so you are not blocked.
