# Paints every 2D asset of Age of Elemental Wars that isn't a unit rig, a tree or a 3D model, in the
# game's simple pixel-art style: small sprites with flat colours, a dark outline and one highlight and
# one shadow shade, scaled up with nearest-neighbour so each art pixel is a crisp block.
#   ui/       buttons, parchment and wood panels (9-slice), ribbons and crossed swords per team
#             colour, resource icons
#   terrain/  arrow, gold and stone fallbacks
#   fx/       dust, fire and explosion strips
#   <colour>/ building sprites (placement preview and fallback while a model loads)
# File names, frame sizes and sheet sizes match what Core/GameAssets.cs and UI/Skin.cs expect.
# Run from the repo root: python3 unity/Tools/gen-art.py
import math
import os
import random
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'Assets', 'Resources', 'assets')

# Team colours (shared/constants.js FACTIONS)
FACTIONS = {
    'blue': 0x6c9bd6, 'red': 0xd9776d, 'yellow': 0xe2bf5c, 'purple': 0xa489c8, 'black': 0x7e8794,
    'green': 0x7dbd6c, 'orange': 0xe8975a, 'teal': 0x5cbcb8, 'pink': 0xe08ab8, 'brown': 0xa8835e,
}
INK = (29, 22, 30, 255)          # outline
CLEAR = (0, 0, 0, 0)


def rgb(h, a=255):
    return ((h >> 16) & 255, (h >> 8) & 255, h & 255, a)


def shade(c, f):
    """f < 1 darkens, f > 1 lightens toward white."""
    if f <= 1:
        return (int(c[0] * f), int(c[1] * f), int(c[2] * f), c[3])
    t = f - 1
    return (int(c[0] + (255 - c[0]) * t), int(c[1] + (255 - c[1]) * t), int(c[2] + (255 - c[2]) * t), c[3])


def sat(c, k):
    """Push a colour's saturation by k around its grey."""
    g = (c[0] + c[1] + c[2]) / 3
    return tuple(max(0, min(255, int(g + (v - g) * k))) for v in c[:3]) + (c[3],)


class Art:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.im = Image.new('RGBA', (w, h), CLEAR)
        self.px = self.im.load()

    def set(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h and c is not None:
            self.px[x, y] = c

    def get(self, x, y):
        return self.px[x, y] if 0 <= x < self.w and 0 <= y < self.h else CLEAR

    def rect(self, x, y, w, h, c):
        for j in range(y, y + h):
            for i in range(x, x + w):
                self.set(i, j, c)

    def hline(self, x, y, w, c):
        self.rect(x, y, w, 1, c)

    def vline(self, x, y, h, c):
        self.rect(x, y, 1, h, c)

    def disc(self, cx, cy, r, c):
        for j in range(int(cy - r - 1), int(cy + r + 2)):
            for i in range(int(cx - r - 1), int(cx + r + 2)):
                if (i + 0.5 - cx) ** 2 + (j + 0.5 - cy) ** 2 <= r * r:
                    self.set(i, j, c)

    def outline(self, c=INK):
        """A 1 px outline around every opaque pixel (on transparent neighbours)."""
        src = self.im.copy().load()
        for y in range(self.h):
            for x in range(self.w):
                if src[x, y][3]:
                    continue
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < self.w and 0 <= ny < self.h and src[nx, ny][3] > 0 and src[nx, ny] != c:
                        self.px[x, y] = c
                        break

    def scaled(self, k):
        return self.im.resize((self.w * k, self.h * k), Image.NEAREST)


def save(im, path):
    full = os.path.join(OUT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    im.save(full)


def strip(frames, k):
    w, h = frames[0].w * k, frames[0].h * k
    sheet = Image.new('RGBA', (w * len(frames), h), CLEAR)
    for i, f in enumerate(frames):
        sheet.paste(f.scaled(k), (i * w, 0))
    return sheet


# ---------------------------------------------------------------- UI (9-slice, art px = texture px;
# UI/Skin.cs scales them up with nearest-neighbour by a whole factor)

def button(base, pressed):
    """16x16, slice 5: dark outline, rounded by one pixel, light top edge, a lip of shadow under it.
    Pressed: the lip is gone and the face sits one pixel lower, darker."""
    a = Art(16, 16)
    face = shade(base, 0.85) if pressed else base
    a.rect(1, 1, 14, 14, INK)
    a.rect(0, 2, 16, 12, INK)
    a.rect(2, 0, 12, 16, INK)
    top = 3 if pressed else 2
    bottom = 13
    a.rect(2, top, 12, bottom - top, face)
    a.rect(1, top + 1, 14, bottom - top - 2, face)
    if not pressed:
        a.rect(2, bottom, 12, 1, shade(base, 0.6))   # lip
        a.rect(1, bottom - 1, 1, 1, shade(base, 0.6))
        a.rect(14, bottom - 1, 1, 1, shade(base, 0.6))
        a.hline(3, top, 10, shade(base, 1.35))       # light top edge
        a.vline(2, top + 1, 2, shade(base, 1.2))
    else:
        a.hline(2, top, 12, shade(base, 0.6))        # inner shadow along the top
    a.hline(3, bottom - 1 - (0 if pressed else 1), 10, shade(face, 0.9))
    return a.im


def parchment():
    """24x24, slice 8: a parchment sheet in a carved wooden frame with brass corner studs."""
    a = Art(24, 24)
    wood, wood_l, wood_d = (138, 90, 51, 255), (176, 122, 72, 255), (92, 58, 33, 255)
    paper, paper_d = (241, 226, 191, 255), (222, 202, 160, 255)
    a.rect(1, 0, 22, 24, INK)
    a.rect(0, 1, 24, 22, INK)
    a.rect(1, 1, 22, 22, wood)
    a.hline(2, 1, 20, wood_l)
    a.vline(1, 2, 20, wood_l)
    a.hline(2, 22, 20, wood_d)
    a.vline(22, 2, 20, wood_d)
    a.rect(4, 4, 16, 16, wood_d)                    # inner groove
    a.rect(5, 5, 14, 14, paper)
    a.hline(5, 5, 14, paper_d)                      # the frame's shadow on the paper
    a.vline(5, 6, 13, paper_d)
    for x, y in ((2, 2), (20, 2), (2, 20), (20, 20)):
        a.rect(x, y, 2, 2, (228, 186, 92, 255))
        a.set(x, y, (255, 233, 160, 255))
        a.set(x + 1, y + 1, (150, 108, 40, 255))
    return a.im


def wood_panel():
    """24x24, slice 8: a dark wooden board in a lighter rim with iron corner bolts."""
    a = Art(24, 24)
    rim, rim_l, board, board_d = (120, 78, 44, 255), (164, 112, 64, 255), (88, 56, 34, 255), (70, 44, 27, 255)
    a.rect(1, 0, 22, 24, INK)
    a.rect(0, 1, 24, 22, INK)
    a.rect(1, 1, 22, 22, rim)
    a.hline(2, 1, 20, rim_l)
    a.vline(1, 2, 20, rim_l)
    a.rect(3, 3, 18, 18, INK)
    a.rect(4, 4, 16, 16, board)
    a.hline(4, 4, 16, board_d)                       # the rim's shadow on the board
    a.vline(4, 5, 15, board_d)
    for x, y in ((2, 2), (20, 2), (2, 20), (20, 20)):
        a.rect(x, y, 2, 2, (190, 190, 200, 255))
        a.set(x + 1, y + 1, (110, 110, 125, 255))
    return a.im


def ribbon(base):
    """40x12, ends 10: a banner across, its forked tails folded behind it at both ends."""
    a = Art(40, 12)
    tail, tail_d = shade(base, 0.62), shade(base, 0.45)
    # tails: rows 3..10, notched at the outer end
    for side in (0, 1):
        for y in range(3, 11):
            notch = 3 - min(y - 3, 10 - y)          # V cut into the end
            for x in range(max(0, notch), 8):
                xx = x if side == 0 else 39 - x
                a.set(xx, y, tail if y < 9 else tail_d)
        fold = 7 if side == 0 else 32                # the fold where the tail goes behind
        a.vline(fold, 3, 8, tail_d)
    # band
    a.rect(6, 1, 28, 9, base)
    a.hline(6, 1, 28, shade(base, 1.3))
    a.hline(6, 2, 28, shade(base, 1.12))
    a.hline(6, 8, 28, shade(base, 0.8))
    a.hline(6, 9, 28, shade(base, 0.66))
    a.outline()
    return a.im


def sword(base):
    """40x16: a sword lying left to right, the guard and pommel in the team colour."""
    a = Art(40, 16)
    steel, steel_l, steel_d = (205, 214, 226, 255), (245, 248, 252, 255), (128, 138, 156, 255)
    a.rect(13, 7, 24, 3, steel)
    a.hline(13, 7, 23, steel_l)
    a.hline(13, 9, 23, steel_d)
    a.set(37, 8, steel)
    a.set(38, 8, steel_l)
    a.hline(15, 8, 18, shade(steel, 0.88))           # fuller
    a.rect(10, 4, 3, 9, base)                         # cross guard
    a.vline(10, 4, 9, shade(base, 1.3))
    a.vline(12, 4, 9, shade(base, 0.7))
    a.rect(4, 7, 6, 3, (110, 70, 40, 255))           # grip
    for x in (5, 7):
        a.vline(x, 7, 3, (80, 50, 28, 255))
    a.rect(1, 6, 3, 5, base)                          # pommel
    a.set(1, 6, shade(base, 1.3))
    a.outline()
    return a.im


def icon_food():
    a = Art(16, 16)
    meat, meat_l, meat_d = (214, 84, 72, 255), (240, 140, 120, 255), (150, 50, 46, 255)
    bone = (244, 236, 214, 255)
    a.disc(7, 7.5, 5, meat)
    a.disc(6.5, 6.5, 3, meat_l)
    a.disc(8.5, 9.5, 2.5, meat_d)
    a.rect(10, 10, 3, 2, bone)
    a.rect(11, 11, 3, 2, bone)
    a.disc(13.5, 13, 1.6, bone)
    a.disc(14.2, 11.8, 1.3, bone)
    a.set(6, 5, (255, 200, 180, 255))
    a.outline()
    return a


def icon_wood():
    a = Art(16, 16)
    bark, bark_d, ring, ring_d = (140, 92, 52, 255), (98, 62, 34, 255), (222, 182, 120, 255), (176, 134, 82, 255)
    for i in range(10):                               # a log lying diagonally
        a.disc(3.5 + i * 0.9, 11 - i * 0.65, 3, bark)
    for i in range(10):
        a.set(int(3 + i * 0.9), int(13 - i * 0.65), bark_d)
    a.disc(12, 5, 3.2, ring)
    a.disc(12, 5, 1.8, ring_d)
    a.set(12, 5, ring)
    a.outline()
    return a


def icon_gold():
    a = Art(16, 16)
    g, gl, gd = (240, 196, 60, 255), (255, 240, 150, 255), (176, 124, 30, 255)
    for cx, cy, r in ((5.5, 10.5, 3.4), (10.5, 10, 3.6), (8, 6, 3.2)):
        a.disc(cx, cy, r, g)
        a.disc(cx + 1, cy + 1, r - 1.6, gd)
        a.disc(cx - 0.8, cy - 0.8, r - 2.1, gl)
    a.set(7, 5, (255, 255, 255, 255))
    a.outline()
    return a


# ---------------------------------------------------------------- terrain fallbacks

def arrow():
    a = Art(16, 16)
    shaft, head, fl = (150, 104, 60, 255), (200, 206, 214, 255), (236, 236, 236, 255)
    a.hline(3, 8, 9, shaft)
    a.rect(12, 7, 2, 3, head)
    a.set(14, 8, head)
    a.set(1, 7, fl); a.set(2, 7, fl); a.set(2, 9, fl); a.set(1, 9, fl); a.set(3, 7, fl); a.set(3, 9, fl)
    return a


def rock_pile(w, h, seed, body, light, dark, vein=None):
    rnd = random.Random(seed)
    a = Art(w, h)
    rocks = []
    for _ in range(4 if w <= 16 else 7):
        r = rnd.uniform(w * 0.14, w * 0.24)
        rocks.append((rnd.uniform(r + 1, w - r - 1), rnd.uniform(h * 0.45, h - r - 1), r))
    rocks.sort(key=lambda t: t[1])
    for cx, cy, r in rocks:
        a.disc(cx, cy, r, body)
        a.disc(cx - r * 0.3, cy - r * 0.35, r * 0.5, light)
        a.disc(cx + r * 0.35, cy + r * 0.35, r * 0.45, dark)
        if vein:
            for _ in range(3):
                a.set(int(cx + rnd.uniform(-r, r) * 0.6), int(cy + rnd.uniform(-r, r) * 0.6), vein)
    a.outline()
    return a


# ---------------------------------------------------------------- FX strips (16 px art, x4)

def dust_frames(n, color=(214, 196, 160)):
    frames = []
    rnd = random.Random(n)
    puffs = [(rnd.uniform(-1, 1), rnd.uniform(-0.6, 0.3), rnd.uniform(0.6, 1)) for _ in range(5)]
    for i in range(n):
        t = i / (n - 1)
        a = Art(16, 16)
        alpha = int(255 * (1 - t) ** 0.7)
        for dx, dy, s in puffs:
            r = (1.5 + 4 * t) * s
            cx, cy = 8 + dx * 5 * t ** 0.6, 10 + dy * 5 * t - 3 * t
            a.disc(cx, cy, r, color + (alpha,))
            a.disc(cx - r * 0.3, cy - r * 0.3, r * 0.5, shade(color + (alpha,), 1.2))
        frames.append(a)
    return frames


def fire_frames(n, seed):
    rnd = random.Random(seed)
    frames = []
    cols = [(255, 246, 180, 255), (255, 196, 70, 255), (238, 110, 40, 255), (170, 52, 32, 255)]
    for i in range(n):
        a = Art(16, 16)
        ph = i / n * math.tau
        for layer, (c, w, hgt) in enumerate(zip(reversed(cols), (4.5, 3.8, 2.6, 1.5), (9, 7.5, 5, 3))):
            for y in range(16):
                rise = (15 - y) / hgt
                if rise > 1:
                    continue
                half = w * (1 - rise ** 1.6) * (0.85 + 0.15 * math.sin(ph * 2 + y + layer))
                sway = math.sin(ph + y * 0.5 + seed) * rise * 1.6
                for x in range(16):
                    if abs(x + 0.5 - 8 - sway) <= half:
                        a.set(x, y, c)
        for _ in range(2):                              # a spark or two
            a.set(rnd.randrange(5, 11), rnd.randrange(0, 5), cols[1])
        frames.append(a)
    return frames


def explosion_frames(n):
    frames = []
    for i in range(n):
        t = i / (n - 1)
        a = Art(48, 48)
        cx, cy = 24, 30
        smoke = (90, 80, 84, int(255 * (1 - t) ** 0.8))
        for k in range(8):
            ang = k / 8 * math.tau
            d = 4 + 16 * t
            a.disc(cx + math.cos(ang) * d, cy + math.sin(ang) * d * 0.6 - 10 * t, 3 + 7 * t, smoke)
        if t < 0.75:
            core = 1 - t / 0.75
            alpha = 255 if core > 0.35 else int(255 * core / 0.35)
            a.disc(cx, cy - 6 * t, 6 + 12 * t, (226, 92, 36, alpha))
            a.disc(cx, cy - 6 * t, 4 + 9 * t * core + 2, (255, 170, 60, alpha))
            a.disc(cx, cy - 6 * t, 2 + 5 * core, (255, 246, 180, alpha))
        rnd = random.Random(i)
        for _ in range(int(10 * (1 - t))):
            ang = rnd.uniform(0, math.tau)
            d = 6 + 18 * t * rnd.uniform(0.6, 1.2)
            a.set(int(cx + math.cos(ang) * d), int(cy + math.sin(ang) * d * 0.7 - 8 * t), (255, 220, 120, 255))
        frames.append(a)
    return frames


# ---------------------------------------------------------------- buildings (x4 sprites)

STONE, STONE_L, STONE_D = (176, 172, 168, 255), (206, 202, 196, 255), (120, 116, 118, 255)
WOOD, WOOD_D = (150, 100, 58, 255), (104, 66, 38, 255)
PLASTER = (232, 220, 194, 255)


def wall_block(a, x, y, w, h, light=STONE_L, body=STONE, dark=STONE_D, bricks=True):
    a.rect(x, y, w, h, body)
    a.vline(x, y, h, light)
    a.vline(x + w - 1, y, h, dark)
    if bricks:
        for j in range(y + 3, y + h, 4):
            a.hline(x + 1, j, w - 2, dark)
            off = 2 if (j // 4) % 2 else 5
            for i in range(x + off, x + w - 1, 6):
                a.vline(i, j - 3, 3, dark)


def roof(a, x, y, w, h, team):
    """A gabled roof in the team colour, shaded on the right."""
    c, cl, cd = team, shade(team, 1.25), shade(team, 0.65)
    for j in range(h):
        half = (w / 2) * (j + 1) / h
        x0, x1 = int(x + w / 2 - half), int(x + w / 2 + half)
        a.hline(x0, y + j, x1 - x0, c)
        a.set(x0, y + j, cl)
        a.hline(int(x + w / 2), y + j, max(0, x1 - int(x + w / 2)), shade(team, 0.85))
    a.hline(x, y + h - 1, w, cd)


def flat_roof(a, x, y, w, team):
    a.rect(x, y, w, 3, team)
    a.hline(x, y, w, shade(team, 1.25))
    for i in range(x, x + w, 3):                     # crenels
        a.rect(i, y - 2, 2, 2, STONE)


def door(a, x, y, w, h):
    a.rect(x, y, w, h, WOOD_D)
    a.rect(x + 1, y + 1, w - 2, h - 1, WOOD)
    a.vline(x + w // 2, y + 1, h - 1, WOOD_D)


def window(a, x, y, lit=False):
    a.rect(x, y, 3, 4, INK)
    a.rect(x + 1, y + 1, 1, 2, (255, 214, 120, 255) if lit else (70, 90, 120, 255))


def flag(a, x, y, team):
    a.vline(x, y, 8, WOOD_D)
    a.rect(x + 1, y, 5, 3, team)
    a.set(x + 6, y + 1, team)


def building(name, team):
    team = sat(team, 1.15)
    if name == 'castle':
        a = Art(80, 64)
        wall_block(a, 10, 30, 60, 32)
        for tx in (4, 62):
            wall_block(a, tx, 18, 14, 44)
            flat_roof(a, tx, 16, 14, team)
            window(a, tx + 5, 26, True)
        wall_block(a, 28, 10, 24, 52)
        roof(a, 26, 0, 28, 12, team)
        flag(a, 40, 0, team)
        door(a, 34, 46, 12, 16)
        for wx in (20, 56):
            window(a, wx, 38, True)
        window(a, 38, 22, True)
    elif name == 'barracks':
        a = Art(48, 64)
        wall_block(a, 4, 30, 40, 32, bricks=False, body=WOOD, light=shade(WOOD, 1.2), dark=WOOD_D)
        for i in range(6, 44, 5):
            a.vline(i, 31, 30, WOOD_D)
        roof(a, 1, 14, 46, 18, team)
        door(a, 18, 44, 12, 18)
        a.rect(8, 38, 6, 6, INK); a.rect(34, 38, 6, 6, INK)            # shields on the walls
        a.rect(9, 39, 4, 4, team); a.rect(35, 39, 4, 4, team)
    elif name == 'monastery':
        a = Art(48, 80)
        wall_block(a, 6, 40, 36, 38, body=PLASTER, light=(250, 244, 228, 255), dark=(196, 182, 150, 255), bricks=False)
        roof(a, 2, 26, 44, 16, team)
        wall_block(a, 18, 8, 12, 34)
        roof(a, 16, 0, 16, 10, team)
        a.rect(22, 14, 4, 6, INK); a.rect(23, 15, 2, 4, (255, 214, 120, 255))   # bell window
        door(a, 19, 58, 10, 20)
        a.disc(24, 48, 3, INK); a.disc(24, 48, 2, team)                          # rose window
    elif name == 'tower':
        a = Art(32, 64)
        wall_block(a, 8, 14, 16, 48)
        flat_roof(a, 6, 12, 20, team)
        window(a, 14, 24, True)
        window(a, 14, 38)
        door(a, 12, 52, 8, 10)
        flag(a, 16, 2, team)
    else:  # houses
        a = Art(32, 48)
        v = int(name[-1])
        body = (PLASTER, (226, 206, 170, 255), WOOD)[v - 1]
        wall_block(a, 4, 24, 24, 22, body=body, light=shade(body, 1.15), dark=shade(body, 0.75), bricks=False)
        if v != 3:
            for i in (4, 15, 27):
                a.vline(i, 24, 22, WOOD_D)                                # timber frame
        roof(a, 1, 8 if v == 2 else 12, 30, 14 if v == 2 else 13, team)
        door(a, 13, 36, 6, 10)
        window(a, 7, 30, True)
        window(a, 22, 30)
        if v == 2:
            a.rect(22, 4, 3, 8, STONE_D)                                  # chimney
    a.outline()
    return a


def main():
    # UI
    blue, red = rgb(0x3f8fbf), rgb(0xc4523f)
    save(button(blue, False), 'ui/btn_blue_9.png')
    save(button(blue, True), 'ui/btn_blue_pressed_9.png')
    save(button(red, False), 'ui/btn_red_9.png')
    save(button(red, True), 'ui/btn_red_pressed_9.png')
    save(parchment(), 'ui/paper_9.png')
    save(wood_panel(), 'ui/woodtable_9.png')
    for name, c in FACTIONS.items():
        save(ribbon(sat(rgb(c), 1.2)), f'ui/ribbon_{name}.png')
        save(sword(sat(rgb(c), 1.2)).resize((320, 128), Image.NEAREST), f'ui/sword_{name}.png')
    save(icon_food().scaled(4), 'ui/food.png')
    save(icon_wood().scaled(4), 'ui/wood.png')
    save(icon_gold().scaled(4), 'ui/gold.png')
    # Terrain fallbacks
    save(arrow().scaled(4), 'terrain/arrow.png')
    for i in range(6):
        save(rock_pile(32, 32, 100 + i, (124, 112, 104, 255), (160, 148, 138, 255), (86, 76, 72, 255), (255, 214, 70, 255)).scaled(4), f'terrain/gold{i + 1}.png')
    for i in range(4):
        save(rock_pile(16, 16, 200 + i, STONE, STONE_L, STONE_D).scaled(4), f'terrain/stone{i + 1}.png')
    # FX
    save(strip(dust_frames(8), 4), 'fx/dust1.png')
    save(strip(dust_frames(10, (190, 176, 150)), 4), 'fx/dust2.png')
    for i, n in enumerate((8, 10, 12)):
        save(strip(fire_frames(n, i + 1), 4), f'fx/fire{i + 1}.png')
    save(strip(explosion_frames(8), 4), 'fx/explosion1.png')
    save(strip(explosion_frames(10), 4), 'fx/explosion2.png')
    # Buildings per team colour
    for name, c in FACTIONS.items():
        for b in ('castle', 'barracks', 'monastery', 'tower', 'house1', 'house2', 'house3'):
            save(building(b, rgb(c)).scaled(4), f'{name}/{b}.png')
    print('done')


if __name__ == '__main__':
    main()
