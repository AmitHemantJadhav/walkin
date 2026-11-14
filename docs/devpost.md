# Walk-In — Devpost draft

> Draft. Lines marked **[check]** describe features that are planned for Saturday and must be confirmed on `main`
> before submitting. Cut anything that isn't working in the demo.
>
> **Numbers:** only quote figures from [`pitch-facts.md`](pitch-facts.md) (each one says how it was measured,
> and "Things to say carefully" lists what hasn't been tested yet). The beats and fallbacks are in
> [`demo-card.md`](demo-card.md).

**Tagline:** Homes.com gets you into the house. Walk-In lets you live in it.

**Track:** CoStar Group — Inside and Out: AI for the Built World

## Inspiration
A listing shows you a house. It doesn't tell you whether your sofa fits, what the bedroom looks like with your bed
in it, or how the living room feels with a brick wall. Homes.com already has an agent that finds a home and drops
you into the Matterport tour. We wanted to build what happens next: you are inside, so change it.

Virtual staging today is mostly image editing. It looks good in one photo and falls apart in the next one, because
the edit has no idea where the walls are. CoStar lists "furnish an empty room, consistently" as an open problem.
Matterport already measured the house, so we put every edit into the house's real coordinates instead of into pixels.

## What it does
Put your phone in a cheap headset and you are standing in a real home that Matterport scanned and digitally emptied.

- **Walk it.** Look around with your head, pinch a floor marker to move to the next scan point.
- **Furnish it with your bare hands.** Real-size furniture appears in front of you. Pinch to grab, carry it, twist
  with two hands to rotate. It tells you at once whether it fits in the room.
- **Talk to it.** "How big is this room?" "Take me to the kitchen." "Add a queen bed." The agent answers out loud
  from the scan's real measurements. **[check]**
- **Point and change it.** "Put red-brick wallpaper on this wall" generates a seamless tile and puts it on the wall
  you are pointing at. **[check]**
- **Ask for advice.** "What plant should go here?" The agent works out the light from the size of the room's windows and how far
  the spot is from them (measured in the scan), suggests a plant, and places it. It doesn't claim a compass
  direction: the scan isn't aligned to north. **[check]**
- **Stage a room in one sentence.** "Stage this as a modern bedroom" places a full set that fits and keeps the
  doorways clear. **[check]**

Everything you place stays where you put it and looks right from every scan point, because it lives in the house's
model space (metres), not in one photo.

## How we built it
- **Data:** Matterport model API — 360 panoramas for every scan point, the defurnished view, the wall graph with
  door and window openings, room polygons with dimensions, and the empty-house mesh. `prep_house.py` pulls one house
  into a small local bundle.
- **Viewer:** three.js. Each scan point's 360 photo is drawn around you with its own rotation, in the model's
  coordinate frame. We verified the calibration by projecting panoramas onto the floor and checking that the wood
  floor stops exactly on the wall graph, in four rooms.
- **Occlusion:** the empty-house mesh is drawn depth-only, so furniture behind a real wall is hidden by it.
- **Fit check:** furniture footprints are tested against the room polygon from the scan.
- **Hands:** MediaPipe HandLandmarker tracks both hands from the phone camera; we draw them in 3D and turn pinches
  into grab, carry, twist and teleport.
- **Headset:** iPhone Safari has no WebXR, so we render side-by-side stereo and use the gyroscope for head tracking.
- **Agent:** Gemini with function calling. The tools are the viewer's own functions (add furniture, stage a room,
  set a wall material, place an object, go to a room) plus `describe_house`, which hands the model the rooms, sizes,
  what is placed and what the user is pointing at. When you say "this", it also gets the current view as an image.
- **Voice:** speech-to-text in the browser, spoken replies from ElevenLabs. **[check]**
- **Keys:** a small relay in our Python server calls Gemini and ElevenLabs, so no key ever reaches the phone.

## Challenges we ran into
- **Getting the panoramas to line up with the geometry.** Every scan point has its own rotation, and the skybox
  faces, the equirectangular mapping and the model frame each have their own axis convention. One wrong sign and
  furniture slides off the floor as you turn. We ended up verifying against the wall graph rather than by eye.
- **Hand tracking on a phone inside a headset.** Front camera when handheld, back camera in the headset, and
  enough smoothing that a pinch is reliable without feeling laggy.
- **No WebXR on iPhone.** We built the stereo view and gyro tracking ourselves, and needed an HTTPS tunnel because
  Safari only gives camera and motion access to secure pages.
- **Frame rate.** A 360 photo, an occluder mesh, two tracked hands and stereo rendering on a phone.

## Accomplishments that we're proud of
- Edits are consistent from every scan point by construction. Put a sofa down, walk to the next room, look back:
  it is still there, the right size, behind the right wall.
- It runs on a phone and a cardboard-style headset. No app install, no special hardware.
- You use your hands. Nobody had to be taught a controller.

## What we learned
- A digital twin is much more than photos. The wall graph, openings and room dimensions are what make an AI edit
  trustworthy: the model can reason about a room because the room is measured.
- Function calling works best when the tools are the product's real verbs and the model is given facts, not asked
  to guess them.

## What's next for Walk-In
- Your own furniture: scan the sofa you already own and bring it along.
- Exterior and neighbourhood context from Vexcel imagery: which way the garden faces, where the sun is at 6 pm.
- Share a staged home as a link, so a buyer and an agent can walk the same version together.
- Search inside homes: "show me houses where a king bed and two nightstands fit in the main bedroom."

## Built with
three.js · MediaPipe · Matterport model API · CoStar listing data · Gemini API · ElevenLabs · Python · JavaScript ·
cloudflared

## Before submitting
- [ ] Remove every **[check]** line that isn't working on `main`.
- [ ] Add the demo video link and 3–5 screenshots (headset view, fit check, wallpaper, plant).
- [ ] Confirm the exact submission deadline on Devpost / Discord.
- [ ] Confirm what we may show publicly: the Matterport / CoStar data is licensed for the event only.
- [ ] Team names and roles: Amit (XR and hands), Shaurya (furniture and staging), Shruti (agent, voice and story).
