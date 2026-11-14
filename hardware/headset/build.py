"""Walk-In phone VR headset v2 for iPhone 16 (147.6 x 71.6 x 7.8 mm). Units: mm.

Optics follow Google Cardboard (I/O 2015) Technical Specifications (cardboard_manufacturers_kit):
  34 mm aspheric PMMA lenses, 80 deg FOV, 3 tabs at 120 deg (40 mm over the tabs, tabs 1.65 mm)
  inter-lens distance 64 mm (fixed, Google: avoid mechanical IPD adjustment)
  tab-to-screen 39.07 mm, lens-plate back surface to screen 37.3 mm, eye relief 18 mm, eyebox 15 mm
Face side: curved contact edge (forehead closest, temples swept back, cheeks a little back) with a nose arch.

Axes: X across (left/right eye), Y up, Z depth: 0 = the user's pupil plane, + toward the phone.
Parts, each printed on its flat face with no supports:
  shroud.stl     curved face piece + strap ears (25 mm strap)
  lensboard.stl  4.5 mm board with two lens seats (34 mm lens + tab recess)
  body.stl       light tunnel, eye divider, phone pocket, open back (camera uncovered); phone slides in from +X
  endcap.stl     clip that closes the pocket end
  ring.stl x2    lens retainers (press-fit, a drop of glue if loose)
"""
import struct, sys, json
import numpy as np
from manifold3d import Manifold, CrossSection, JoinType

# ------------------------------------------------------------------ phone
PH_L, PH_W, PH_T = 147.6, 71.6, 7.8
CLR = 0.7                            # per side; FDM-friendly (review on #120). No room for a case.
POCKET_L, POCKET_W, POCKET_T = PH_L + 2 * CLR, PH_W + 2 * CLR, PH_T + 0.5
WALL = 5.0
OUT_W, OUT_H = POCKET_L + 2 * WALL, POCKET_W + 2 * WALL       # 158.6 x 82.6
SHELL = 2.4
# ------------------------------------------------------------------ optics (Cardboard I/O 2015)
IPD = 64.0
LENS_D, LENS_TAB_D, TAB_T = 34.0, 40.0, 1.65
BOARD_T = 4.5
LEDGE_D = 32.0                       # eye-side ledge the lens rim rests on
Z_BOARD = 19.0                       # eye-side face of the lens board
Z_LEDGE = Z_BOARD + 1.1              # lens rim sits here
Z_TAB = Z_LEDGE + TAB_T              # tab face toward the display
Z_BOARD_BACK = Z_BOARD + BOARD_T     # 23.5
Z_SCREEN = Z_TAB + 39.07             # 60.82 ; board back -> screen = 37.32 (spec 37.3 +2/-0.5)
Z_RIM = Z_SCREEN + POCKET_T
RIM_T = 2.2
Z_END = Z_RIM + RIM_T
RIM_LONG, RIM_END = 4.0, 3.0
LEDGE = 2.5                          # screen ledge: covers the bezel, short enough to print as an overhang
M3_HOLE = 3.4                        # prints ~3.2
CAP_GAP = 0.4                        # end cap over the body: two printed faces sliding
FOOT = 0.4                           # elephant's-foot chamfer on bed-side edges
# eye position: pupil plane Z = 0 ; eye-side lens vertex ~ Z_LEDGE - 3.5 ; eye relief 18 -> pupil ~ -1.4 (we use 0)
# ------------------------------------------------------------------ face contour (where the shroud meets skin)
BROW = 9.0       # brow ridge sits ~9 mm in front of the pupil
TEMPLE = 0.0035  # sweep-back per mm^2 across: at x = +/-79 the edge is ~22 mm behind the brow
CHEEK = 6.0      # cheekbones ~6 mm further back than the brow at the bottom edge
def face_z(x, y):
    return BROW - TEMPLE * x * x - CHEEK * np.clip(-y / (OUT_H / 2), 0, 1)

def box(x0, x1, y0, y1, z0, z1):
    return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])

def cyl(x, y, z0, z1, d, n=128):
    return Manifold.cylinder(z1 - z0, d / 2, d / 2, n).translate([x, y, z0])

def rbox(w, h, z0, z1, r):
    cs = CrossSection.square([w - 2 * r, h - 2 * r], center=True).offset(r, JoinType.Round)
    return Manifold.extrude(cs, z1 - z0).translate([0, 0, z0])

def nose(z0, z1):
    # arch-ish nose opening: 18 mm wide at the top (6 mm below the lens line), 46 mm at the bottom edge
    pts = [(-23, -OUT_H / 2 - 1), (23, -OUT_H / 2 - 1), (13, -14), (9, -8), (0, -6), (-9, -8), (-13, -14)]
    return Manifold.extrude(CrossSection([pts]), z1 - z0).translate([0, 0, z0])

def face_cutter():
    """Everything in front of the face contour (z < face_z). A refined box whose top face is bent onto the contour."""
    m = box(-OUT_W / 2 - 20, OUT_W / 2 + 20, -OUT_H / 2 - 20, OUT_H / 2 + 20, -80, 0).refine_to_length(3.0)
    def bend(v):
        v = np.array(v, dtype=float)
        top = v[:, 2] > -1e-6
        v[top, 2] = face_z(v[top, 0], v[top, 1])
        return v
    return m.warp_batch(bend)

pins = [(sx * (OUT_W / 2 - 5.5), sy * (OUT_H / 2 - 5.5)) for sx in (-1, 1) for sy in (-1, 1)]

# ------------------------------------------------------------------ shroud (curved face piece)
def shroud():
    z0 = float(face_z(OUT_W / 2 + 12, -OUT_H / 2)) - 2
    outer = rbox(OUT_W, OUT_H, z0, Z_BOARD, 4)
    m = outer - box(-OUT_W / 2 + SHELL, OUT_W / 2 - SHELL, -OUT_H / 2 + SHELL, OUT_H / 2 - SHELL, z0 - 1, Z_BOARD + 1)
    for x, y in pins:                                   # corner bosses, 8 mm deep, screw access from the face side
        boss = (cyl(x, y, Z_BOARD - 8, Z_BOARD, 9.0) ^ outer)
        m = m + boss
        m = m - cyl(x, y, Z_BOARD - 9, Z_BOARD + 1, M3_HOLE) - cyl(x, y, Z_BOARD - 30, Z_BOARD - 5.5, 6.2)
    for sx in (-1, 1):                                  # strap ears with 26 mm slots, on the sides near the temples
        xo = OUT_W / 2 if sx > 0 else -OUT_W / 2
        ear = box(min(xo, xo + sx * 11), max(xo, xo + sx * 11), -17, 17, Z_BOARD - 22, Z_BOARD)
        slot = box(min(xo + sx * 4, xo + sx * 8), max(xo + sx * 4, xo + sx * 8), -13.5, 13.5, Z_BOARD - 40, Z_BOARD + 1)
        m = m + (ear - slot)
    m = m - nose(z0 - 1, Z_BOARD + 1)
    m = m - face_cutter()                               # the curved face edge
    return m

# ------------------------------------------------------------------ lens board
def lensboard():
    m = rbox(OUT_W, OUT_H, Z_BOARD, Z_BOARD_BACK, 4)
    for sx in (-1, 1):
        x = sx * IPD / 2
        m = m - cyl(x, 0, Z_BOARD - 1, Z_BOARD_BACK + 1, LEDGE_D)          # eye-side opening (lens rim rests on it)
        m = m - cyl(x, 0, Z_LEDGE, Z_BOARD_BACK + 1, LENS_TAB_D + 0.6)    # lens + tabs + retainer ring recess
    m = m - nose(Z_BOARD - 1, Z_BOARD_BACK + 1)
    for x, y in pins:
        m = m - cyl(x, y, Z_BOARD - 1, Z_BOARD_BACK + 1, M3_HOLE)
    return m

def ring(od=LENS_TAB_D + 0.45):   # sits on the lens rim/tabs, press-fit into the 40.6 mm recess (print both sizes)
    return cyl(0, 0, 0, Z_BOARD_BACK - Z_TAB, od) - cyl(0, 0, -1, 5, 32.6)

# ------------------------------------------------------------------ body
def body():
    outer = rbox(OUT_W, OUT_H, Z_BOARD_BACK, Z_END, 4)
    m = outer - box(-OUT_W / 2 + SHELL, OUT_W / 2 - SHELL, -OUT_H / 2 + SHELL, OUT_H / 2 - SHELL, Z_BOARD_BACK - 1, Z_SCREEN - 2.5)
    win_w, win_h = POCKET_L - 2 * LEDGE, POCKET_W - 2 * LEDGE
    for i in range(5):                                   # 45 deg step down to the screen window
        t = i / 4
        w = (OUT_W - 2 * SHELL) * (1 - t) + win_w * t
        h = (OUT_H - 2 * SHELL) * (1 - t) + win_h * t
        z = Z_SCREEN - 3.1 + 2.5 * t      # stair ends where the window box starts (review #120)
        m = m - box(-w / 2, w / 2, -h / 2, h / 2, z - 0.01, z + 0.65)
    m = m - box(-win_w / 2, win_w / 2, -win_h / 2, win_h / 2, Z_SCREEN - 3, Z_SCREEN + 0.1)
    m = m - box(-POCKET_L / 2, OUT_W / 2 + 1, -POCKET_W / 2, POCKET_W / 2, Z_SCREEN, Z_RIM)       # pocket, open at +X
    m = m - box(-POCKET_L / 2 + RIM_END, OUT_W / 2 + 1, -POCKET_W / 2 + RIM_LONG, POCKET_W / 2 - RIM_LONG, Z_RIM - 0.1, Z_END + 1)
    # elephant's foot: 0.4 mm relief on the bed-side (back) edges of the window and the pocket mouth
    m = m - box(-POCKET_L / 2 + RIM_END - FOOT, OUT_W / 2 + 1, -POCKET_W / 2 + RIM_LONG - FOOT, POCKET_W / 2 - RIM_LONG + FOOT, Z_END - FOOT, Z_END + 1)
    m = m - box(OUT_W / 2 - FOOT, OUT_W / 2 + 1, -POCKET_W / 2 - FOOT, POCKET_W / 2 + FOOT, Z_SCREEN, Z_END + 1)
    m = m + (box(-1.0, 1.0, -OUT_H / 2 + SHELL, OUT_H / 2 - SHELL, Z_BOARD_BACK, Z_SCREEN - 4) - nose(Z_BOARD_BACK - 1, 34))
    m = m - nose(Z_BOARD_BACK - 1, 31)                   # nose tip reaches ~30 mm in front of the pupil
    for x, y in pins:
        m = m + (cyl(x, y, Z_BOARD_BACK, Z_BOARD_BACK + 14, 9.0) ^ outer)
        m = m - cyl(x, y, Z_BOARD_BACK - 1, Z_BOARD_BACK + 12, 2.7)
    return m

def endcap():
    t, reach, x_in = 2.4, 8.0, OUT_W / 2
    m = (box(x_in, x_in + t, -OUT_H / 2 - t, OUT_H / 2 + t, Z_SCREEN - 2, Z_END)
         + box(x_in - reach, x_in + t, OUT_H / 2 + CAP_GAP, OUT_H / 2 + CAP_GAP + t, Z_SCREEN - 2, Z_END)
         + box(x_in - reach, x_in + t, -OUT_H / 2 - CAP_GAP - t, -OUT_H / 2 - CAP_GAP, Z_SCREEN - 2, Z_END))
    return m - box(x_in - 1, x_in + t + 1, -6, 6, Z_SCREEN + 1, Z_RIM - 1)

# ------------------------------------------------------------------ output
def write_stl(m, path):
    me = m.to_mesh(); v = np.asarray(me.vert_properties)[:, :3]; f = np.asarray(me.tri_verts); tri = v[f]
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]); n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
    with open(path, 'wb') as fh:
        fh.write(b'Walk-In iPhone 16 headset v2'.ljust(80, b' ')); fh.write(struct.pack('<I', len(f)))
        for i in range(len(f)): fh.write(struct.pack('<12fH', *n[i], *tri[i].ravel(), 0))

def on_bed(m, flip=False):
    if flip: m = m.rotate([180, 0, 0])
    b = m.bounding_box(); return m.translate([-(b[0] + b[3]) / 2, -(b[1] + b[4]) / 2, -b[2]])

def parts():
    return {'shroud': shroud(), 'lensboard': lensboard(), 'body': body(), 'endcap': endcap(), 'ring': ring()}

if __name__ == '__main__':
    out = sys.argv[1]; P = parts()
    rep = {k: {'cm3': round(m.volume() / 1000, 1), 'genus': m.genus(), 'ok': str(m.status()), 'bbox': [round(x, 1) for x in m.bounding_box()]} for k, m in P.items()}
    write_stl(on_bed(P['shroud'], flip=True), f'{out}/shroud.stl')     # board face down, curved edge up
    write_stl(on_bed(P['lensboard']), f'{out}/lensboard.stl')
    write_stl(on_bed(P['body'], flip=True), f'{out}/body.stl')         # back rim down
    write_stl(on_bed(P['endcap'].rotate([0, -90, 0])), f'{out}/endcap.stl')
    write_stl(on_bed(P['ring']), f'{out}/ring.stl')
    write_stl(on_bed(ring(LENS_TAB_D + 0.6)), f'{out}/ring-40.6.stl')       # second size: use whichever presses in
    # test print first (~30 min): a 13.5 mm slice through the ledge, pocket and rim, and one lens seat
    test_pocket = P["body"] ^ box(-OUT_W, OUT_W, -OUT_H, OUT_H, Z_SCREEN - 3, Z_END + 1)   # ledge + pocket + rim, ~13.5 mm
    write_stl(on_bed(test_pocket, flip=True), f'{out}/test-pocket-slice.stl')
    test_seat = P['lensboard'] ^ box(IPD / 2 - 25, IPD / 2 + 25, -25, 25, Z_BOARD - 1, Z_BOARD_BACK + 1)
    write_stl(on_bed(test_seat), f'{out}/test-lens-seat.stl')
    print(json.dumps(rep))
    print('board back -> screen', round(Z_SCREEN - Z_BOARD_BACK, 2), '| tab -> screen', round(Z_SCREEN - Z_TAB, 2),
          '| face edge: brow', BROW, 'temples', round(float(face_z(OUT_W / 2, 0)), 1), 'cheeks', round(float(face_z(40, -OUT_H / 2)), 1))
