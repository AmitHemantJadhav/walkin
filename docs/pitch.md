# Walk-In — 3-minute pitch (draft)

> Draft. Judges are CoStar / Matterport engineers: lead with the demo, name their open problem, be exact about
> what the data gave us. Cut any beat whose feature isn't working on `main`.
>
> **Numbers:** only quote figures from [`pitch-facts.md`](pitch-facts.md) (each one says how it was measured,
> and "Things to say carefully" lists what hasn't been tested yet). The beats and fallbacks are in
> [`demo-card.md`](demo-card.md).

**One line:** Homes.com gets you into the house. Walk-In lets you live in it.

## Who does what
- **Speaker:** tells the story, never touches the laptop.
- **Headset:** wears the phone headset, does the gestures and the voice commands. Screen mirrored for the judges.
- **Backup:** has the demo video ready on a second device in case the tunnel or Wi-Fi drops.

## 0:00 – 0:25 · The problem
"Homes.com can already find you a home and drop you into its Matterport tour. And then you stand there, looking at
somebody else's empty room, wondering if your sofa fits.

Virtual staging exists, but it edits pictures. It looks right in one photo and wrong in the next, because a picture
doesn't know where the walls are. You listed that as an open problem: furnish an empty room, consistently."

## 0:25 – 0:40 · The idea
"Matterport already measured this house. So we don't edit the pictures. We edit the house, in metres, and let every
picture follow. That's Walk-In. It runs on a phone in a headset. Let me show you."

## 0:40 – 2:10 · Live demo (headset person acts, speaker narrates)
1. **Stand in the house (10 s).** "This is a real listing, scanned by Matterport and digitally emptied. She's
   looking around with her head."
2. **Will my sofa fit through the front door? (30 s).** Standing on the porch, **＋ Add → Sofa**, pinch it and carry it
   at the front door sideways. It stops, and John says: *"The sofa is 2.10 m across the way you're holding it and
   that door is 1.15 m — turn it and it goes through."* Turn it, carry it in. "Real size, real door, measured by the
   scan. That's the question every buyer actually asks." (Details and traps: `demo-card.md` beat 5.)
3. **Stage it (20 s).** *"Hey John, stage this as a cosy living room."* A full set appears, every piece checked
   against the walls and doorways. Walk to the next scan point and look back. "Still there, same place, hidden
   behind the right wall. That's the consistency an image edit can't give you."
4. **Ask (15 s).** "How big is this room?" → spoken answer with the real dimensions. "That number comes from the
   scan, not from the model's imagination."
5. **Point and talk (20 s).** Point at a wall: "Put red-brick wallpaper on this wall." The wall changes. Move to
   another scan point. "Same wall, from the other side of the room."
6. **Advice (20 s).** Point at a corner: "What plant should go here?" → "This corner gets bright light from the big
   window two metres away, so a monstera would do well." The plant appears. "It knows where the windows are, how big
   they are and how far this spot is from them, because the scan measured them."

*All six run about 115 s against a 90 s slot: plan on dropping step 6 and step 4 (80 s), and add them back only if you are ahead. Never drop step 2.*

## 2:10 – 2:40 · How it works, in three sentences
"Every scan point's 360 photo is drawn around you in the model's own coordinates, with the calibration verified
against your wall graph. Furniture, wallpaper and plants live in those same coordinates, and the empty-house mesh
hides them behind real walls. The agent is Gemini with function calling: its tools are the viewer's own actions,
and it reads rooms, openings and dimensions from the twin instead of guessing."

## 2:40 – 3:00 · Why it matters to CoStar
"Three of your data layers in one experience: the Matterport twin, the listing, and location. No app, no special
hardware: a phone and a twenty-dollar headset. A buyer who has arranged their own furniture in a home is a buyer
who is ready to make a call. Homes.com gets you into the house. Walk-In lets you live in it."

## Questions we should be ready for
- **How is this different from Matterport's own defurnish / staging?** We use the defurnished view as the canvas.
  What we add is interaction in model space: hands, voice, and edits that hold from every scan point.
- **Is the wallpaper really consistent across views?** Yes, by construction: it is a textured quad on the wall
  segment from the wall graph, cut around door openings, not a per-image edit.
- **How accurate is the fit check?** It tests the furniture's real footprint against the room polygon from the
  scan. Known limit today: it doesn't yet account for … *(fill in from Shaurya's fit check v2)*.
- **Does it need WebXR?** No. iPhone Safari has none, so we render stereo ourselves and use the gyroscope.
- **What does the AI actually decide?** Which action to take and how to say it. Sizes, rooms and positions come
  from the twin.
- **Would it scale to every listing?** One API pull per house, about 30 seconds, no manual work. Every residential
  model in the hackathon set that we checked has the defurnished view.
- **Latency?** *(measure on Saturday: time from end of speech to spoken reply, and to wallpaper on the wall.)*

## Checklist before going on
- [ ] Phone charged, headset strap adjusted, screen mirroring tested.
- [ ] Tunnel link open and the house loaded before we walk up.
- [ ] Layout saved so a reload brings the demo scene back.
- [ ] Backup video ready on a second device.
- [ ] One full timed run under 3:00.
