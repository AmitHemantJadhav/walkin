# Walk-In — 2-minute demo video script (draft)

> Draft. Record on Saturday after the 20:00 freeze, from `main`. Shots marked **[check]** need the feature working;
> if it isn't, cut the shot and stretch shots 2–3. Target length 1:55.

**Capture:** iPhone screen recording of the headset view (side-by-side) plus a second phone filming the person in
the headset. Cut between the two. For readable shots, also record the same actions in handheld (single view) mode.
**Sound:** voice-over recorded separately; keep the agent's spoken replies audible from the phone.

| # | Time | Picture | Voice-over / audio |
|---|------|---------|--------------------|
| 1 | 0:00–0:10 | Homes.com listing photo → an empty Matterport room. Text: "You found the house. Now what?" | "Homes.com gets you into the house. But an empty room doesn't tell you if your life fits in it." |
| 2 | 0:10–0:22 | Person puts a phone into a headset and puts it on. Cut to the headset view: looking around the empty living room. | "This is Walk-In. A phone, a headset, and a real home that Matterport scanned and digitally emptied." |
| 3 | 0:22–0:45 | Hands appear in view. Add a sofa, pinch it, carry it to the wall, twist with two hands. The box outline around it is green while it fits in the room; slide it partly out of the room (through the wall line) and the outline and the room card turn red. The card's second line gives the reason ("sticks out of the bedroom", "blocks the bedroom door"). | "Real-size furniture, moved with your bare hands. Green means it fits. It's measured against the room from the scan." |
| 4 | 0:45–0:58 | Pinch a floor marker, move to the next scan point, turn back: the sofa is where it was left, partly hidden by the wall. | "Walk to the next room and look back. It's still there, behind the right wall, because we edit the house in metres, not the photo." |
| 5 | 0:58–1:10 | **[check: real mic]** "Hey John" (or pinch-and-hold menu → Talk). "How big is this room?" The reply plays. | Agent audio: the room's real dimensions. VO: "Ask anything. The answers come from the scan." |
| 6 | 1:10–1:28 | Point at a wall: "Put red-brick wallpaper on this wall." The wall changes. Move to another scan point: same wall, still brick. | "Point and talk. A generated tile, placed on the real wall, consistent from every scan point." |
| 7 | 1:28–1:43 | Point at a corner: "What plant should go here?" Reply plays, a plant appears. | Agent audio: the plant suggestion with the reason (light from the window). VO: "It knows where the windows are and how far away they are." |
| 8 | 1:43–1:50 | "Furnish the whole house." Six rooms fill at once (32 pieces in La Mirada). | "Or the whole house in one sentence." |
| 9 | 1:50–1:55 | Wide shot of the person in the headset, then the title card: **Walk-In** — "Homes.com gets you into the house. Walk-In lets you live in it." Team names. | "Walk-In. Built on Matterport digital twins at HackPrinceton." |

## Shot list to record (in this order, one take each plus a spare)
1. Putting on the headset (second phone, 2 angles).
2. Handheld mode: add sofa, grab, carry, twist, fit turns red in the doorway.
3. Headset mode: the same, shorter.
4. Teleport and look back at the sofa.
5. Voice: room size question.
6. Voice: wallpaper, then the same wall from a second scan point.
7. Voice: plant advice.
8. Voice: stage the bedroom.

## Filming notes (from rehearsal)
- Shot 3, red state: with physics on, a sofa stops at walls and door jambs, so you can't park it half outside the room
  or in a doorway. Film that moment with `walkin.physics.enabled = false`, then turn physics back on.
- Carrying a sofa across a staged room jams on the coffee table (#57): clear the room or move the table first.
- The doorway moment ("will my sofa fit through that door?") is beat 5 in `demo-card.md`; use that, not shot 3.

## Before recording
- [ ] Use the demo house with the cleanest scan (La Mirada `zvKHR9DHNjJ`) and note which scan points to stand on.
- [ ] Quiet room; the agent's voice must be audible.
- [ ] Confirm we may show the house publicly in a video (data is licensed for the event only).
- [ ] Export 1080p, under the Devpost size limit, and upload unlisted.
