# Walk-In landing page

`website/index.html`: a scroll-driven fly-down from the neighbourhood (Vexcel aerial) into the Matterport dollhouse,
through La Mirada's front door, ending on the real 360 photo inside, where the play button opens the demo video.
three.js draws the frames and blends each into the next. GSAP ScrollTrigger turns the scroll into a frame position.

Run it: `python3 -m http.server 8080 -b 127.0.0.1 -d website`, then open http://localhost:8080/. Serve only `website/`
and only on localhost: run from the repo root, http.server would also serve `.env` and `data/` to anyone on the network
(it doesn't hide dotfiles the way serve.py does). three.js and GSAP come from CDNs, so the folder is all the page needs.

- `index.html`, `style.css`, `main.js`: the page (three.js and GSAP from CDNs)
- `frames/f_000.jpg` … `f_299.jpg`: the rendered fly-down, 1920×1080 (made for a laptop screen). The page decodes only the frames near the scroll position
- `assets/demo.mp4`: the demo video (not added yet). Until it's there, the player says it's on its way.

## Re-rendering the frames

Needs the house data in `data/<model>/` (git-ignored):

```bash
python prep_house.py zvKHR9DHNjJ                  # 360 photos + walls
python tools/prep_outside.py zvKHR9DHNjJ          # Vexcel footprint + 64 m ortho
python tools/matterpak.py fetch zvKHR9DHNjJ       # the textured scan (dollhouse)
python website/tools/fetch_aerial.py              # 400 m Vexcel ortho for the opening shot
python website/tools/capture.py                   # serves the repo, saves posted frames to website/frames/
# then open http://localhost:8090/website/tools/render.html?save=1&n=300&w=1920&h=1080   (?only=150 previews one frame)
```

`tools/align.json` places the scan on the aerial photo: the wall graph fitted onto Vexcel's house footprint
(rotation 89.48°, mean error 0.55 m, front door facing the street). The camera path and its pacing are in
`render.html`: the speed is set by how fast the view appears to move, so the high part goes fast and the door slow.

Data: Vexcel, Matterport and CoStar data are licensed for the hackathon only. Keep the site private or take the frames down after the event.
