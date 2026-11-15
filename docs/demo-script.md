# Walk-In: the 3-minute demo

**One line:** Homes.com gets you *into* a house. Walk-In lets you *live in it*, and lease the office next door, before you sign.

**Who does what**
- **Amit** presents and talks to John. John hears the room through the phone's microphone.
- **Judge A** wears the headset (phone in At eyes mode) and uses their hands.
- **Judge B** watches the same view on the Mac (AirPlay mirror).
- **Shaurya** sits at the laptop as backup: typed John, resets, the tunnel.

Every prompt below was run in this order against the real model on the current build (Nov 15, with #139 merged). The times and John's replies are what it actually did.

---

## 0:00 – 1:00 · Outside: the pitch, on CoStar's own data

**On screen:** the La Mirada opener. It shows the Homes.com listing card (**$1,195,000**, 3 bd · 1.5 ba · 1,628 sq ft · built 1920) over the **Vexcel aerial**, with the roof footprint traced from above.

**Say (about 40 s):**
> "Every Homes.com listing already has a 3D tour. But a tour shows you someone else's furniture. It can't tell you if your sofa fits, if the bedroom gets morning sun, or how many desks an office floor will take.
> Walk-In takes CoStar's own data: the Homes.com listing, the Vexcel aerial, and the Matterport scan with the furniture digitally removed. You walk the real space at real size, with your hands and your voice.
> No app. It's a web page, on a phone, in a ten-dollar headset."

**Do:** Judge A taps **Walk in**. The view dives from the aerial into the empty house, and At eyes switches on by itself. From here nobody touches the phone.

**Wow:** the dive from the satellite view into the real, empty living room.

---

## 1:00 – 2:00 · The house: furnish it, live in it

| # | Amit says | What happens | Time |
|---|---|---|---|
| 1 | **"John, what would look good in this room?"** | John furnishes the living room with real-size, photoreal pieces that drop in one after another, with a knitted throw on the sofa and the coffee table styled. *"I've arranged a warm, classic living room set to complement this 1920 California Bungalow. The full set comes to about $3,184."* | 4–8 s (8 s the first time, while the models download) |
| 2 | *(to Judge A)* "Reach out and pinch the sofa. Pull it, twist with both hands." | The judge carries a real-size 2.1 m sofa with bare hands. It lifts off its shadow and leans as it moves, slides along whatever it meets, and its outline turns red if it doesn't fit. | ~10 s |
| 3 | **"John, decorate this room as if I'm a Ronaldo fan."** | A Portugal-red feature wall, red accents on the furniture, and three AI-drawn posters that sharpen within seconds. | 4 s + art |
| 4 | **"Now show me a summer evening, 6 pm in June."** *(no "John": still inside the 30 s follow-up window)* | Golden-hour sun through the real windows onto the floor: *"direct sun enters through 9 west-facing windows across about 6.8 square metres of floor"* (NOAA sun position, true north from the scan). The furniture throws shadows. This is the most floor sun of any time we tried; a December sunset only lights the far walls. | 4 s |

**Wow:** #3 gets the laugh. #4 is the "this is real data" moment: true north, real windows, any date.

**If there's time left:**
- "John, will a king bed fit in the master bedroom?" gets *"Yes, 1.95 by 2.15 m, easily, in a 3.99 by 4.07 m room"* (3 s).
- "Make it cosier, add curtains" adds a pouf, a console with a lamp and curtains at the real windows (new in #139; not rehearsed through the model, so only as an extra).

---

## 2:00 – 3:00 · The office: a broker's test fit in 30 seconds

| # | Amit says | What happens | Time |
|---|---|---|---|
| 5 | **"John, take me to the office."** | *"Taking you over to the Suite 300 office space now."* The office loads still in the headset, with no tap (tested in the browser; try it once on the iPhone). | 3 s + load |
| 6 | *(while it loads)* "13,000 of the 15,000 scans CoStar gave us are commercial. Here's what a tenant rep does in a week." | | |
| 7 | **"John, seat 50 people here."** | 50 real desks with monitors and chairs. *"50 seats across four rows, 46 within 7.5 metres of a window. The longest walk to an exit is 34 metres."* | 5 s |
| 8 | **"Make them private offices."** | Glass-fronted cabins along corridors. *"48 private offices, the maximum that fits here, 30 near a window. The longest walk to an exit is 41 metres."* | 4 s |
| 9 | **"Add four 8-person meeting rooms on the back wall and a kitchen by the entrance."** | The zones appear where asked and the offices re-flow around them. *"…leaving room for 42 private offices, 24 within 7.5 metres of a window."* | 5.5 s |

**Close (about 10 s):**
> "A test fit like that takes days and an architect. This took thirty seconds, from CoStar's own scan, and you were standing in it."

**Wow:** #7 → #8, the whole floor rearranged by one sentence, with code occupancy and egress numbers spoken.

---

## Rules on stage
- **Say "John" only to John.** "John" alone now wakes him. In the pitch, say "our assistant".
- **After John answers, he listens for 30 s without his name.** Say **"Thanks John"** before you turn to talk to the judges, or he'll answer them.
- **One command at a time.** Wait for John to finish speaking before the next.
- **Don't** use "renovate the whole house" on stage. It's the biggest effect but takes 6–12 s of silence.

## If something goes wrong
| Problem | Do this |
|---|---|
| John doesn't react | Say it again with "John" first. Still nothing: Shaurya types it in the laptop's John box. |
| "Switching to my backup voice" | Keep going. The backup answers the same prompts. |
| Office switch asks for a tap | Judge A taps the screen once; the view follows their head again. |
| Furniture in the wrong place | "John, undo that." |
| The tunnel drops | Shaurya restarts it and reads out the new link; reopen it from the Home Screen icon. |
| Hands lost | "Hands" on the left bar, or the pinch-and-hold ring menu. |
| A piece won't go through a door | Normal: it slides along the jamb. Turn it with two hands, or "John, move the sofa to the bedroom". |

## T-minus 10 minutes
1. Charge the phone. Set Auto-Lock to **Never** (Settings → Display & Brightness). The app keeps the screen on as well.
2. Open Walk-In from the **Home Screen icon** (full screen, no URL bar) on the current tunnel link.
3. **AirPlay** the iPhone to the Mac (Control Center → Screen Mirroring). Test it.
4. **Warm the models:** in a run-through, do beats 1, 3 and 7 once. The photoreal furniture downloads the first time it's placed in a session.
5. **Reset:** open the house link fresh (the opener shows on a fresh load) and clear placed furniture with ⋯ → Clear room. A run leaves the house decorated and the office laid out.
6. Check the server: `curl localhost:8020/api/health` should show `"gemini": true` and `"live": true`.
7. Do one full run with a stopwatch. Target: 2:50.
