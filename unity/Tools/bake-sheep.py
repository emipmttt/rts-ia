# Bakes the sheep's animation sheet from its three painted parts (references/sheep_parts.png: the
# head in the top-left 3x3, one leg as a 1x3 stick top-right, the woolly body below) into
# Assets/Resources/assets/terrain/sheep_rig.png: one row per animation, 20x16 frames, facing right.
#   idle   breathing
#   graze  head down, chewing
#   walk   four legs stepping in diagonal pairs, the body bobbing
#   dead   on its back, legs up (sheep die when a villager starts butchering them)
# Run from the repo root: python3 unity/Tools/bake-sheep.py
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'references', 'sheep_parts.png')
OUT = os.path.join(HERE, '..', 'Assets', 'Resources', 'assets', 'terrain', 'sheep_rig.png')
FW, FH = 20, 16
ROWS = ['idle', 'graze', 'walk', 'dead']

parts = Image.open(SRC).convert('RGBA')
head = parts.crop((2, 1, 5, 4))
leg = parts.crop((13, 4, 14, 7))
body = parts.crop((0, 7, 12, 15))

BODY_X, BODY_Y = 3, 3          # body's top-left in a frame
LEGS = [5, 7, 11, 13]          # leg columns: two hind, two front
FEET = 13                      # row of the hooves


def frame(bob=0, head_dy=0, steps=(0, 0, 0, 0)):
    """A standing frame. steps: per leg, how far its hoof swings (-1 back, 1 forward)."""
    f = Image.new('RGBA', (FW, FH))
    for x, swing in zip(LEGS, steps):
        top = FEET - 2
        for k in range(3):
            # The hoof (and the shin a little) swings with the step
            dx = swing if k == 2 else (swing if k == 1 and swing else 0) * 0
            f.paste(leg.crop((0, k, 1, k + 1)), (x + dx, top + k))
    f.alpha_composite(body, (BODY_X, BODY_Y + bob))
    f.alpha_composite(head, (BODY_X + 11, BODY_Y + 1 + bob + head_dy))
    return f


def dead():
    f = Image.new('RGBA', (FW, FH))
    flipped = body.transpose(Image.FLIP_TOP_BOTTOM)
    for x in LEGS:
        f.paste(leg.transpose(Image.FLIP_TOP_BOTTOM), (x, FEET - 9))
    f.alpha_composite(flipped, (BODY_X, FEET - 7))
    f.alpha_composite(head, (BODY_X + 12, FEET - 2))
    return f


anims = {
    'idle': [frame(), frame(), frame(bob=1), frame(bob=1)],
    "graze": [frame(head_dy=4), frame(head_dy=5), frame(head_dy=4), frame(head_dy=5)],
    # Diagonal pairs: hind-left with front-right, then the other two
    'walk': [frame(steps=(1, -1, -1, 1)), frame(bob=-1), frame(steps=(-1, 1, 1, -1)), frame(bob=-1)],
    'dead': [dead()],
}
sheet = Image.new('RGBA', (FW * 4, FH * len(ROWS)))
for r, name in enumerate(ROWS):
    for i, f in enumerate(anims[name]):
        sheet.paste(f, (i * FW, r * FH))
sheet.save(OUT)
print('Baked', OUT, sheet.size)
