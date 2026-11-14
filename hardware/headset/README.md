# Walk-In headset v2 — iPhone 16, curved face, Cardboard v2 optics

A phone VR headset for the **iPhone 16 (147.6 × 71.6 × 7.8 mm)**. The face side is curved to fit the face,
and the **back is open so the camera can see your hands** (hand tracking in headset mode).
`build.py` generates every part (manifold3d). Change the numbers at the top and re-run.
The first, flat-faced design (25 mm lenses) is not included here.

## Optics: Google Cardboard (I/O 2015) Technical Specifications
From Google's `cardboard_manufacturers_kit.zip`: *Technical Specifications*, *Lens.pdf* and *Design Guidelines v2.2*.

| | spec | this design |
|---|---|---|
| Lens | 34 mm aspheric PMMA, 80° FOV, 3 tabs at 120° (40 mm across the tabs, 1.65 mm thick) | seat for exactly that lens; plain 34 mm round lenses also fit |
| Inter-lens distance | 64 mm (63.9 in the profile), fixed; Google advises against an IPD adjustment | 64 mm |
| Tab face to screen | 39.07 mm | 39.07 mm |
| Lens plate back to screen | 37.3 mm (+2 / −0.5) | 37.32 mm |
| Eye relief | 18 mm | lens board ~19 mm from the pupil plane |
| Eyebox | 15 mm | — |

## Face fit
The face edge is a curved surface: it is closest at the brow (9 mm in front of the eyes) and sweeps back to the
temples (13 mm behind) and a little back at the cheeks. The nose arch is 18 mm wide at the top and 46 mm at the
bottom, cut through the shroud, the lens board and the front of the tunnel (a nose reaches about 30 mm in front of
the eyes). For comfort, stick a 12–15 mm wide self-adhesive foam strip along the face edge.

## Print a test first (~30 min)
`test-pocket-slice.stl` (the screen ledge, phone pocket and back rim, 13.5 mm tall) and `test-lens-seat.stl` (one
lens seat). Check that the iPhone slides in, the screen sits flat on the ledge, and a lens plus ring seats. Then print
the rest. If the phone is tight or loose, change `CLR` and re-run `build.py`.

## Print (PLA or PETG, 0.2 mm layers, 3 walls, 15 % infill, no supports)
| file | qty | on the bed |
|---|---|---|
| `shroud.stl` | 1 | as exported (flat board side down, curved face edge up) |
| `lensboard.stl` | 1 | flat |
| `body.stl` | 1 | as exported (back rim down) |
| `endcap.stl` | 1 | as exported |
| `ring.stl` (40.45 mm) and `ring-40.6.stl` | 2 of each | flat. Use whichever size presses in; glue is the backup |

Size: 159 × 83 × 90 mm, or 181 mm wide over the strap ears.

Print tolerances (FDM, 0.4 mm nozzle; from the review on #120):
- phone pocket 0.7 mm clearance per side (`CLR`); no room for a case
- 2.5 mm screen ledge: covers the bezel and prints as a short overhang without drooping
- M3 holes 3.4 mm (they print about 3.2), self-tap pilots 2.7 mm
- end cap 0.4 mm over the body
- 0.4 mm elephant's-foot relief on the bed-side edges of the back window and the pocket mouth

## Buy
- **2 × Google Cardboard v2 / 2.0 replacement lenses, 34 mm aspheric** (sold as "Cardboard 2.0 lenses 34 mm").
  The v1-style 25 mm / 45 mm lenses do **not** fit this design.
- 4 × M3 × 20–25 mm self-tapping screws (or glue)
- ~60 cm of 25 mm elastic strap. Google advises hand-held use for Cardboard; we need a strap because the hands
  are tracked, so keep head turns gentle.
- 12–15 mm wide self-adhesive foam strip for the face edge

## Assemble
1. Put each lens into the lens board from the **tunnel side**: its rim rests on the 32 mm ledge, and its tabs sit
   in the 40.6 mm recess. Press a ring in on top, with a drop of glue if loose.
2. Stack body → lens board → shroud, then screw through the four corner holes from the face side.
3. Slide the iPhone in from the open end, **screen toward the lenses**, and push the end cap on.
4. Thread the strap through the ear slots and stick the foam on the face edge.

## Not tested yet
Nothing has been printed. If the phone is tight or loose, change `CLR`; if the picture is soft, adjust the
lens-to-screen distance (`39.07` in `Z_SCREEN`) by ±1 mm; if the face fit is off, tune `BROW`, `TEMPLE`, `CHEEK`.
