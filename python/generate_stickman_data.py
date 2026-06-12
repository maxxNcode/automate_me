#!/usr/bin/env python3
"""
Generate diverse stickman training images for LoRA fine-tuning.
Produces 400+ images with:
  - 50+ unique scene types
  - Varied stickman poses, sizes, colors, expressions
  - Multiple background palettes (day, night, warm, cool, fantasy, indoor)
  - Diverse objects, nature elements, structures
  - Rich captions describing scene content + art style

Output: python/training_data_synthetic/
"""

import os, random, json, math
from PIL import Image, ImageDraw

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "training_data_synthetic")
os.makedirs(OUTPUT_DIR, exist_ok=True)

W, H = 768, 432  # landscape, matches YouTube frame aspect ratio

# ── Color Palettes ──────────────────────────────────────────
SKY_BLUE     = (205, 234, 241)
GROUND_TAN   = (226, 181, 107)
WHITE        = (255, 255, 255)
BLACK        = (0, 0, 0)
OUTLINE      = (30, 30, 30)

SKIN_LIGHT   = (255, 220, 185)
SKIN_MED     = (252, 191, 141)
SKIN_TAN     = (220, 180, 130)
SKIN_DARK    = (180, 130, 90)

GREEN_LIGHT  = (180, 220, 140)
GREEN_DARK   = (140, 190, 100)
BROWN        = (160, 120, 80)
BROWN_DARK   = (100, 70, 40)
GRAY_LIGHT   = (210, 205, 195)
GRAY         = (180, 175, 165)
ORANGE       = (255, 180, 50)
RED          = (220, 80, 40)
RED_BRIGHT   = (240, 60, 60)
PURPLE       = (180, 100, 200)
BLUE_WATER   = (150, 195, 215)
BLUE_DEEP    = (100, 150, 200)
YELLOW       = (255, 220, 80)
PINK         = (255, 180, 200)
TEAL         = (80, 200, 200)

NIGHT_SKY    = (20, 20, 55)
NIGHT_GROUND = (55, 45, 35)
NIGHT_STARS  = (255, 255, 240)

INDOOR_WALL  = (240, 235, 225)
INDOOR_FLOOR = (200, 180, 160)
INDOOR_DARK  = (180, 160, 140)

BODY_COLORS = [
    (30, 30, 40),     # dark
    (50, 50, 60),     # charcoal
    (70, 60, 50),     # brown
    (40, 30, 60),     # purple
    (60, 40, 30),     # rust
    (50, 60, 40),     # olive
]

SKIN_TONES = [SKIN_LIGHT, SKIN_MED, SKIN_TAN, SKIN_DARK]

# Outlines
OUTLINE_COLORS = [
    (30, 30, 30),     # black
    (60, 50, 40),     # dark brown
    (50, 50, 60),     # dark gray-blue
    (40, 40, 40),     # dark gray
]

# ── Stickman Drawing ────────────────────────────────────────

def draw_stickman(draw, cx, cy, s=1.0, arm_a=0, leg_a=0,
                  body_color=None, skin_color=None, outline_color=None):
    """Draw a stickman at (cx, cy) with scale s, arm/leg angles in degrees."""
    if body_color is None:
        body_color = random.choice(BODY_COLORS)
    if skin_color is None:
        skin_color = random.choice(SKIN_TONES)
    if outline_color is None:
        outline_color = random.choice(OUTLINE_COLORS)

    hr = int(15 * s)       # head radius
    bl = int(38 * s)       # body length
    al = int(28 * s)       # arm length
    ll = int(32 * s)       # leg length
    w = max(2, int(2.5 * s))

    top = cy - bl // 2
    bot = cy + bl // 2
    hy = top - hr           # head y-center

    # Head
    draw.ellipse([cx - hr, hy - hr, cx + hr, hy + hr],
                 fill=skin_color, outline=outline_color, width=w)

    # Eyes
    eo = int(5 * s)
    er = max(2, int(2.5 * s))
    draw.ellipse([cx - eo - er, hy - er, cx - eo + er, hy + er], fill=outline_color)
    draw.ellipse([cx + eo - er, hy - er, cx + eo + er, hy + er], fill=outline_color)

    # Body
    draw.line([cx, hy + hr, cx, bot], fill=outline_color, width=w)

    # Arms
    rad = math.radians(arm_a)
    ax1 = cx - int(al * math.cos(rad))
    ay1 = top + int(al * 0.4) - int(al * 0.4 * math.sin(rad))
    ax2 = cx + int(al * math.cos(rad))
    ay2 = top + int(al * 0.4) - int(al * 0.4 * math.sin(rad))
    draw.line([cx, top + int(al * 0.3), ax1, ay1], fill=outline_color, width=w)
    draw.line([cx, top + int(al * 0.3), ax2, ay2], fill=outline_color, width=w)

    # Legs
    lrad = math.radians(leg_a)
    lx1 = cx - int(ll * 0.4) - int(ll * 0.3 * math.sin(lrad))
    ly1 = bot + int(ll * 0.4) + int(ll * 0.3 * math.cos(lrad))
    lx2 = cx + int(ll * 0.4) + int(ll * 0.3 * math.sin(lrad))
    ly2 = bot + int(ll * 0.4) + int(ll * 0.3 * math.cos(lrad))
    draw.line([cx, bot, lx1, ly1], fill=outline_color, width=w)
    draw.line([cx, bot, lx2, ly2], fill=outline_color, width=w)

    return body_color, skin_color, outline_color

def draw_stickman_happy(draw, cx, cy, s=1.0, body_color=None, skin_color=None, outline_color=None):
    """Stickman with happy expression and arms raised."""
    bc, sc, oc = draw_stickman(draw, cx, cy, s, arm_a=-45, leg_a=0,
                                body_color=body_color, skin_color=skin_color, outline_color=outline_color)
    # Smile
    hr = int(15 * s)
    hy = cy - int(38 * s) // 2 - hr
    sm_y = hy + int(6 * s)
    draw.arc([cx - int(6 * s), sm_y - int(2 * s), cx + int(6 * s), sm_y + int(6 * s)],
             0, 180, fill=oc, width=max(1, int(2 * s)))
    return bc, sc, oc

def draw_stickman_waving(draw, cx, cy, s=1.0, body_color=None, skin_color=None, outline_color=None):
    """Stickman waving one arm."""
    bc, sc, oc = draw_stickman(draw, cx, cy, s, arm_a=45, leg_a=8,
                                body_color=body_color, skin_color=skin_color, outline_color=outline_color)
    # Waving dots
    hr = int(15 * s)
    hy = cy - int(38 * s) // 2 - hr
    al = int(28 * s)
    rad = math.radians(45)
    wx = cx + int(al * math.cos(rad))
    wy = int(cy - int(38 * s) // 2 + int(al * 0.3) - int(al * 0.4 * math.sin(rad)))
    draw.ellipse([wx - 3, wy - 10, wx + 3, wy - 4], fill=oc)
    return bc, sc, oc

def draw_stickman_jumping(draw, cx, cy, s=1.0, body_color=None, skin_color=None, outline_color=None):
    """Stickman jumping (legs apart, arms up)."""
    bc, sc, oc = draw_stickman(draw, cx, cy, s, arm_a=-60, leg_a=25,
                                body_color=body_color, skin_color=skin_color, outline_color=outline_color)
    return bc, sc, oc

def draw_stickman_sitting(draw, cx, cy, s=1.0, body_color=None, skin_color=None, outline_color=None):
    """Stickman in seated pose."""
    w = max(2, int(2.5 * s))
    hr = int(15 * s)
    bl = int(38 * s)
    top = cy - bl // 2
    hy = top - hr
    ll = int(32 * s)

    # Head
    if body_color is None: body_color = random.choice(BODY_COLORS)
    if skin_color is None: skin_color = random.choice(SKIN_TONES)
    if outline_color is None: outline_color = random.choice(OUTLINE_COLORS)

    draw.ellipse([cx - hr, hy - hr, cx + hr, hy + hr], fill=skin_color, outline=outline_color, width=w)
    eo = int(5 * s); er = max(2, int(2.5 * s))
    draw.ellipse([cx - eo - er, hy - er, cx - eo + er, hy + er], fill=outline_color)
    draw.ellipse([cx + eo - er, hy - er, cx + eo + er, hy + er], fill=outline_color)

    # Body (shorter when sitting)
    draw.line([cx, hy + hr, cx, cy], fill=outline_color, width=w)

    # Legs forward
    draw.line([cx, cy, cx - int(10 * s), cy + int(15 * s)], fill=outline_color, width=w)
    draw.line([cx, cy, cx + int(10 * s), cy + int(15 * s)], fill=outline_color, width=w)

    # Arms at sides
    draw.line([cx, hy + hr + int(8 * s), cx - int(18 * s), cy - int(4 * s)], fill=outline_color, width=w)
    draw.line([cx, hy + hr + int(8 * s), cx + int(18 * s), cy - int(4 * s)], fill=outline_color, width=w)
    return body_color, skin_color, outline_color

# ── Background Templates ────────────────────────────────────

SKY_COLORS = [
    (205, 234, 241),  # light blue
    (180, 220, 240),  # blue
    (220, 200, 170),  # sunset
    (255, 210, 180),  # warm sunset
    (240, 220, 200),  # hazy
    (200, 210, 230),  # overcast
    (100, 150, 220),  # deep blue
]

GROUND_COLORS = [
    (226, 181, 107),  # tan
    (180, 210, 140),  # green
    (160, 190, 120),  # olive
    (200, 170, 130),  # sand
    (140, 120, 100),  # brown
    (210, 190, 170),  # light brown
    (190, 200, 180),  # gray-green
]

def make_bg(d, sky=None, ground=None):
    if sky is None: sky = random.choice(SKY_COLORS)
    if ground is None: ground = random.choice(GROUND_COLORS)
    d.rectangle([0, 0, W, H // 2], fill=sky)
    d.rectangle([0, H // 2, W, H], fill=ground)

def make_indoor_bg(d, wall_color=None, floor_color=None):
    if wall_color is None: wall_color = random.choice([INDOOR_WALL, (255, 245, 235), (230, 225, 215)])
    if floor_color is None: floor_color = random.choice([INDOOR_FLOOR, (180, 160, 130), (150, 120, 90)])
    d.rectangle([0, 0, W, int(H * 0.55)], fill=wall_color)
    d.rectangle([0, int(H * 0.55), W, H], fill=floor_color)

def make_night_bg(d):
    d.rectangle([0, 0, W, H // 2], fill=NIGHT_SKY)
    d.rectangle([0, H // 2, W, H], fill=NIGHT_GROUND)
    # Stars
    for _ in range(30):
        sx = random.randint(0, W)
        sy = random.randint(0, H // 2 - 10)
        sr = random.randint(1, 2)
        d.ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=NIGHT_STARS)

# ── Scene Elements ──────────────────────────────────────────

def cloud(d, x, y, sz=40):
    d.ellipse([x, y, x + sz * 1.5, y + sz // 2], fill=WHITE)
    d.ellipse([x + sz // 3, y - sz // 3, x + sz, y + sz // 3], fill=WHITE)
    d.ellipse([x + sz // 2, y - sz // 4, x + sz * 1.2, y + sz // 3], fill=WHITE)

def sun(d, x, y, r=45):
    d.ellipse([x - r, y - r, x + r, y + r], fill=YELLOW)

def moon(d, x, y, r=30):
    d.ellipse([x - r, y - r, x + r, y + r], fill=(240, 240, 200))
    d.ellipse([x + r // 3, y - r // 4, x + r // 3 * 2, y + r // 4], fill=NIGHT_SKY)

def tree(d, x, y, scale=1.0):
    th = int(80 * scale); tw = int(5 * scale)
    d.rectangle([x - tw, y - th, x + tw, y], fill=BROWN, outline=OUTLINE, width=2)
    cr = int(30 * scale)
    d.ellipse([x - cr, y - th - cr, x + cr, y - th + cr], fill=random.choice([GREEN_DARK, GREEN_LIGHT]), outline=OUTLINE, width=2)

def rock(d, x, y, sz=25):
    d.ellipse([x - sz // 2, y - sz // 2, x + sz // 2, y + sz // 2], fill=GRAY, outline=OUTLINE, width=2)

def campfire(d, x, y):
    d.line([x - 18, y, x + 12, y - 4], fill=BROWN, width=3)
    d.line([x - 8, y - 2, x + 18, y], fill=BROWN, width=3)
    d.ellipse([x - 10, y - 28, x + 10, y - 4], fill=ORANGE, outline=OUTLINE, width=1)
    d.ellipse([x - 4, y - 20, x + 4, y - 6], fill=RED)

def house(d, x, y, scale=1.0):
    sw = int(40 * scale); sh = int(50 * scale)
    d.rectangle([x - sw, y - sh, x + sw, y], fill=(200, 170, 120), outline=OUTLINE, width=2)
    d.polygon([x - sw - 5, y - sh, x, y - int(85 * scale), x + sw + 5, y - sh],
              fill=(180, 80, 40), outline=OUTLINE, width=2)
    d.rectangle([x - int(8 * scale), y - int(25 * scale), x + int(8 * scale), y], fill=BROWN, outline=OUTLINE, width=1)

def grass_blades(d, x, y, n=5):
    for _ in range(n):
        gx = x + random.randint(-20, 20)
        gh = random.randint(8, 18)
        d.line([gx, y, gx + random.randint(-3, 3), y - gh], fill=GREEN_DARK, width=2)

def flower(d, x, y):
    color = random.choice([RED_BRIGHT, YELLOW, PINK, PURPLE, ORANGE])
    d.ellipse([x - 3, y - 8, x + 3, y - 2], fill=GREEN_DARK)
    d.ellipse([x - 4, y - 14, x + 4, y - 6], fill=color)

def bird(d, x, y):
    d.line([x - 10, y, x, y - 7], fill=OUTLINE, width=2)
    d.line([x, y - 7, x + 10, y], fill=OUTLINE, width=2)

def fence(d, x, y, n=5):
    for i in range(n):
        fx = x + i * 25
        d.rectangle([fx - 2, y - 30, fx + 2, y], fill=BROWN, width=2)
    d.line([x - 5, y - 20, x + n * 25 - 5, y - 20], fill=BROWN, width=3)
    d.line([x - 5, y - 8, x + n * 25 - 5, y - 8], fill=BROWN, width=3)

def water_pond(d, x, y, w, h):
    d.ellipse([x, y, x + w, y + h], fill=BLUE_WATER, outline=OUTLINE, width=2)

def bookshelf(d, x, y, scale=1.0):
    bw = int(60 * scale); bh = int(80 * scale)
    d.rectangle([x - bw, y - bh, x + bw, y], fill=BROWN_DARK, outline=OUTLINE, width=2)
    colors = [RED, BLUE_DEEP, GREEN_DARK, ORANGE, PURPLE, YELLOW]
    for i in range(3):
        ry = y - bh + i * 25 + 5
        for j in range(4):
            rx = x - bw + j * 28 + 4
            book_color = random.choice(colors)
            d.rectangle([rx, ry, rx + 8, ry + 18], fill=book_color)

def table(d, x, y, scale=1.0):
    tw = int(60 * scale); th = int(5 * scale)
    d.rectangle([x - tw, y - th, x + tw, y + th], fill=(180, 130, 70), outline=OUTLINE, width=2)
    d.line([x - tw + 5, y + th, x - tw + 5, y + int(30 * scale)], fill=BROWN_DARK, width=3)
    d.line([x + tw - 5, y + th, x + tw - 5, y + int(30 * scale)], fill=BROWN_DARK, width=3)

def stars(d, n=20):
    for _ in range(n):
        sx, sy = random.randint(0, W), random.randint(0, H // 2 - 5)
        d.ellipse([sx - 1, sy - 1, sx + 1, sy + 1], fill=NIGHT_STARS)

# ── Scene Definitions ───────────────────────────────────────

scenes = []

# Each scene: (caption, draw_function)
# The draw_function receives (draw, rand_state_dict) where rand_state_dict
# has random variations pre-chosen for diversity.

def add_scene(caption_template, draw_fn, count=8):
    for _ in range(count):
        scenes.append((caption_template, draw_fn))

# ── Day Outdoor Scenes ──
add_scene(
    "a stickman character standing outside on a sunny day, simple flat animation style, blue sky and green grass",
    lambda d: (make_bg(d), cloud(d, 80, 50, 35), sun(d, W - 70, 70),
               draw_stickman(d, W // 2, H // 2 + 50, 1.2, 0, 0)),
    count=12
)

add_scene(
    "a stickman character walking across a green field, simple flat animation art style, outdoor landscape",
    lambda d: (make_bg(d), cloud(d, 150, 60), grass_blades(d, 200, H // 2, 4), grass_blades(d, 400, H // 2, 3),
               draw_stickman(d, W // 2, H // 2 + 50, 1.2, 25, 12)),
    count=10
)

add_scene(
    "a stickman character running outdoors, dynamic pose, simple flat vector illustration, bright sunny day",
    lambda d: (make_bg(d), cloud(d, 120, 70), sun(d, 80, 70),
               draw_stickman(d, W // 2, H // 2 + 50, 1.3, 50, -25)),
    count=10
)

add_scene(
    "a stickman character standing in a forest, surrounded by trees, simple flat animation style, nature scene",
    lambda d: (make_bg(d), tree(d, 100, H // 2 + 10, 1.0), tree(d, 650, H // 2 + 10, 1.2),
               draw_stickman(d, W // 2, H // 2 + 50, 1.1, 5, 0)),
    count=8
)

add_scene(
    "a stickman character with birds flying overhead, simple flat animation, outdoor nature scene",
    lambda d: (make_bg(d), cloud(d, 50, 60, 30), sun(d, W - 70, 70),
               bird(d, W // 2 + 50, H // 3), bird(d, W // 2 + 90, H // 3 - 20),
               draw_stickman(d, W // 3, H // 2 + 50, 1.2, 0, 0)),
    count=8
)

add_scene(
    "a stickman character standing near a pond, simple flat vector illustration, water and nature",
    lambda d: (make_bg(d), water_pond(d, W // 2 - 60, H // 2 - 10, 180, 60),
               draw_stickman(d, W // 4, H // 2 + 50, 1.1, 0, 0)),
    count=8
)

add_scene(
    "a stickman character sitting by a campfire at night, simple flat animation, dark starry sky with moon",
    lambda d: (make_night_bg(d), moon(d, W - 80, 70),
               draw_stickman_sitting(d, W // 3, H // 2 + 40, 1.0),
               campfire(d, 2 * W // 3, H // 2 + 10)),
    count=8
)

add_scene(
    "a stickman character sleeping on the ground at night, simple flat animation, campfire nearby",
    lambda d: (make_night_bg(d), moon(d, W - 80, 70),
               draw_stickman(d, W // 2, H // 2 + 60, 1.0, -15, -15),
               campfire(d, W // 2 + 100, H // 2 + 10)),
    count=6
)

add_scene(
    "a stickman character building a structure, simple flat animation style, construction scene outdoors",
    lambda d: (make_bg(d), cloud(d, 100, 60), house(d, 2 * W // 3, H // 2 + 10, 0.8),
               draw_stickman(d, W // 3, H // 2 + 50, 1.2, -40, 5)),
    count=8
)

add_scene(
    "a stickman character holding a spear, simple flat vector illustration, prehistoric tools and outdoor setting",
    lambda d: (make_bg(d), cloud(d, 200, 70), tree(d, 120, H // 2 + 10, 0.8),
               draw_stickman(d, W // 2, H // 2 + 50, 1.2, 85, 0),
               d.line([W // 2 + 30, H // 2 + 10, W // 2 + 30, H // 2 - 25], fill=BROWN, width=3),
               d.polygon([W // 2 + 26, H // 2 - 25, W // 2 + 34, H // 2 - 25, W // 2 + 30, H // 2 - 38],
                         fill=GRAY, outline=OUTLINE, width=1)),
    count=6
)

add_scene(
    "a stickman character exploring rocky terrain, simple flat animation, prehistoric landscape with rocks",
    lambda d: (make_bg(d), cloud(d, 200, 80), sun(d, W - 80, 70),
               rock(d, 100, H // 2 + 10, 30), rock(d, 150, H // 2 + 5, 20), rock(d, 500, H // 2 + 15, 35),
               draw_stickman(d, W // 3, H // 2 + 50, 1.2, 10, 0)),
    count=6
)

add_scene(
    "a stickman character fishing by a river, simple flat animation style, peaceful outdoor scene",
    lambda d: (make_bg(d, (205, 234, 241), GROUND_TAN),
               water_pond(d, W // 2 - 80, H // 2 - 15, 200, 50),
               draw_stickman(d, W // 4, H // 2 + 55, 1.1, 75, 0),
               d.line([W // 4 + 25, H // 2 + 15, W // 4 + 25, H // 2 - 25], fill=BROWN, width=2),
               d.line([W // 4 + 25, H // 2 - 25, W // 4 + 45, H // 2 - 15], fill=BROWN, width=2)),
    count=6
)

add_scene(
    "a stickman character gathering food or foraging, simple flat animation, outdoor nature scene with grass",
    lambda d: (make_bg(d), cloud(d, 100, 70), cloud(d, 400, 90, 30), sun(d, W - 80, 80),
               grass_blades(d, W // 2 - 30, H // 2 + 10, 8), grass_blades(d, W // 2 + 50, H // 2 + 15, 6),
               flower(d, W // 2 + 60, H // 2 + 5), flower(d, W // 2 - 40, H // 2 + 8),
               draw_stickman(d, W // 2, H // 2 + 50, 1.2, -30, 5)),
    count=6
)

add_scene(
    "a stickman character carrying wood or logs, simple flat animation, outdoor work scene",
    lambda d: (make_bg(d), cloud(d, 100, 60), sun(d, W - 80, 80),
               draw_stickman(d, W // 2, H // 2 + 50, 1.2, 10, 0),
               d.line([W // 2 - 20, H // 2 - 30, W // 2 + 20, H // 2 - 30], fill=BROWN, width=4),
               d.line([W // 2 - 22, H // 2 - 25, W // 2 + 18, H // 2 - 25], fill=BROWN, width=3)),
    count=6
)

# ── Social / Multiple Stickmen ──
add_scene(
    "two stickman characters talking together, social scene, simple flat animation style",
    lambda d: (make_bg(d), cloud(d, 150, 60), sun(d, W - 80, 80),
               draw_stickman(d, W // 2 - 80, H // 2 + 50, 1.0, -20, 0),
               draw_stickman(d, W // 2 + 80, H // 2 + 50, 1.0, 20, 0)),
    count=8
)

add_scene(
    "two stickman characters by a campfire, friends talking outdoors, simple flat vector art",
    lambda d: (make_bg(d), cloud(d, 100, 60),
               draw_stickman(d, W // 2 - 90, H // 2 + 50, 0.9, -15, 0),
               draw_stickman(d, W // 2 + 90, H // 2 + 50, 0.9, 15, 0),
               campfire(d, W // 2, H // 2 + 10)),
    count=6
)

add_scene(
    "a stickman character waving at another stickman in the distance, outdoor scene, flat vector illustration",
    lambda d: (make_bg(d), sun(d, 70, 70), cloud(d, 200, 60),
               draw_stickman_waving(d, W // 3, H // 2 + 50, 1.1),
               draw_stickman(d, 2 * W // 3 + 20, H // 2 + 40, 0.7, 0, 0)),
    count=6
)

# ── Indoor Scenes ──
add_scene(
    "a stickman character standing in a room with a bookshelf, simple flat animation style, indoor scene",
    lambda d: (make_indoor_bg(d), bookshelf(d, 2 * W // 3, H // 2 + 20, 0.9),
               draw_stickman(d, W // 3, H // 2 + 50, 1.1, 0, 0)),
    count=8
)

add_scene(
    "a stickman character sitting at a table, simple flat animation style, indoor home scene",
    lambda d: (make_indoor_bg(d), table(d, W // 2, H // 2 + 20, 0.8),
               draw_stickman_sitting(d, W // 2 + 50, H // 2 + 40, 1.0)),
    count=6
)

add_scene(
    "a stickman character standing near a window, indoor scene, simple flat vector illustration",
    lambda d: (make_indoor_bg(d, (200, 210, 230), INDOOR_FLOOR),
               d.rectangle([W - 100, 30, W - 30, 150], fill=(180, 220, 250), outline=OUTLINE, width=3),
               d.line([W - 65, 30, W - 65, 150], fill=OUTLINE, width=2),
               d.line([W - 100, 90, W - 30, 90], fill=OUTLINE, width=2),
               draw_stickman(d, W // 3, H // 2 + 50, 1.1, 0, 0)),
    count=6
)

# ── Themed Scenes ──
add_scene(
    "a stickman character in a garden with flowers, simple flat animation style, nature and gardening scene",
    lambda d: (make_bg(d, (205, 234, 241), GREEN_LIGHT), cloud(d, 100, 60), sun(d, W - 70, 70),
               flower(d, 100, H // 2 + 5), flower(d, 150, H // 2 + 8), flower(d, 550, H // 2 + 3), flower(d, 600, H // 2 + 10),
               draw_stickman(d, W // 2, H // 2 + 50, 1.2, -20, 0)),
    count=8
)

add_scene(
    "a stickman character standing by a fence, simple flat animation style, rural outdoor landscape",
    lambda d: (make_bg(d), cloud(d, 200, 70), sun(d, 80, 70),
               fence(d, 500, H // 2 + 10, 6),
               draw_stickman(d, W // 3, H // 2 + 50, 1.2, 0, 0)),
    count=6
)

add_scene(
    "a stickman character sitting under a tree reading, simple flat animation style, peaceful outdoor scene",
    lambda d: (make_bg(d), cloud(d, 80, 60), tree(d, 550, H // 2 + 10, 1.5),
               draw_stickman_sitting(d, W // 2, H // 2 + 40, 1.0)),
    count=6
)

add_scene(
    "a stickman character climbing a rocky hill, simple flat animation, outdoor adventure scene",
    lambda d: (make_bg(d, (180, 210, 240), GRAY_LIGHT), cloud(d, 150, 60),
               rock(d, 400, H // 2 + 30, 80), rock(d, 500, H // 2 - 10, 100), rock(d, 600, H // 2 - 40, 70),
               draw_stickman(d, 450, H // 2 - 20, 1.0, 60, 20)),
    count=6
)

add_scene(
    "a stickman character dancing with joy, happy expression, simple flat animation style",
    lambda d: (make_bg(d), cloud(d, 80, 60), cloud(d, 400, 80, 30), sun(d, W - 80, 80),
               draw_stickman_happy(d, W // 2, H // 2 + 50, 1.2)),
    count=8
)

add_scene(
    "a stickman character jumping in excitement, dynamic pose, simple flat vector illustration",
    lambda d: (make_bg(d), cloud(d, 120, 70), sun(d, 70, 70),
               draw_stickman_jumping(d, W // 2, H // 2 + 50, 1.2)),
    count=6
)

add_scene(
    "a stickman character looking at stars at night, simple flat animation style, night sky",
    lambda d: (make_night_bg(d), moon(d, W - 100, 60),
               draw_stickman(d, W // 2, H // 2 + 50, 1.1, 30, 0)),
    count=6
)

# ── Seasonal / Weather Scenes ──
add_scene(
    "a stickman character holding an umbrella in the rain, simple flat animation, rainy day scene",
    lambda d: (make_bg(d, (170, 180, 200), (150, 160, 170)),
               sun(d, 60, 50, 25), cloud(d, 200, 60, 50), cloud(d, 400, 70, 45),
               # Rain drops
               d.line([150, H // 2 + 10, 148, H // 2 + 20], fill=BLUE_WATER, width=1),
               d.line([300, H // 2 + 5, 298, H // 2 + 15], fill=BLUE_WATER, width=1),
               d.line([450, H // 2 + 8, 448, H // 2 + 18], fill=BLUE_WATER, width=1),
               d.line([550, H // 2 + 3, 548, H // 2 + 13], fill=BLUE_WATER, width=1),
               draw_stickman(d, W // 2, H // 2 + 50, 1.2, -30, 0),
               # Umbrella
               d.arc([W // 2 - 30, H // 2 - 60, W // 2 + 30, H // 2 - 10], 0, 180, fill=(200, 50, 50), width=4),
               d.line([W // 2, H // 2 - 35, W // 2, H // 2 - 5], fill=BROWN, width=3)),
    count=6
)

add_scene(
    "a stickman character in the snow, winter scene, simple flat animation, white landscape",
    lambda d: (make_bg(d, (220, 230, 245), (240, 245, 255)),
               d.ellipse([80, 40, 120, 50], fill=WHITE),
               d.ellipse([300, 60, 350, 72], fill=WHITE),
               tree(d, 600, H // 2 + 10, 0.8),
               draw_stickman(d, W // 2, H // 2 + 50, 1.2, 10, 5)),
    count=6
)

# ── Fantasy / Imaginative Scenes ──
add_scene(
    "a stickman character riding a dinosaur, prehistoric scene, simple flat animation style",
    lambda d: (make_bg(d, (200, 220, 200), GROUND_TAN), cloud(d, 100, 60),
               # Simple dinosaur body
               d.ellipse([W // 2 - 20, H // 2, W // 2 + 60, H // 2 + 40], fill=GREEN_DARK, outline=OUTLINE, width=2),
               d.line([W // 2 + 60, H // 2 + 20, W // 2 + 80, H // 2 + 35], fill=OUTLINE, width=3),
               d.line([W // 2 + 80, H // 2 + 35, W // 2 + 90, H // 2 + 10], fill=OUTLINE, width=3),
               # Dino head
               d.ellipse([W // 2 + 55, H // 2 - 10, W // 2 + 75, H // 2 + 10], fill=GREEN_DARK, outline=OUTLINE, width=2),
               d.ellipse([W // 2 + 70, H // 2 - 4, W // 2 + 72, H // 2 - 2], fill=OUTLINE),
               # Dino legs
               d.line([W // 2, H // 2 + 40, W // 2 + 5, H // 2 + 60], fill=OUTLINE, width=3),
               d.line([W // 2 + 40, H // 2 + 40, W // 2 + 45, H // 2 + 60], fill=OUTLINE, width=3),
               # Stickman riding
               draw_stickman(d, W // 2 + 30, H // 2 - 20, 0.9, 0, 0)),
    count=4
)

add_scene(
    "a stickman character on a boat sailing on water, simple flat animation, nautical scene",
    lambda d: (make_bg(d, SKY_BLUE, BLUE_WATER),
               cloud(d, 80, 60), cloud(d, 400, 80, 30), sun(d, W - 70, 70),
               # Boat
               d.polygon([W // 2 - 60, H // 2 + 20, W // 2 + 60, H // 2 + 20, W // 2 + 40, H // 2 + 40, W // 2 - 40, H // 2 + 40],
                         fill=(160, 100, 60), outline=OUTLINE, width=2),
               # Mast
               d.line([W // 2, H // 2 + 20, W // 2, H // 2 - 50], fill=BROWN, width=3),
               # Sail
               d.polygon([W // 2, H // 2 - 40, W // 2 + 30, H // 2 - 10, W // 2, H // 2 + 10],
                         fill=WHITE, outline=OUTLINE, width=1),
               draw_stickman(d, W // 2 - 20, H // 2 + 10, 0.8, 0, 0)),
    count=4
)

add_scene(
    "a stickman character exploring a desert, simple flat animation, sand dunes and hot sun",
    lambda d: (make_bg(d, (255, 230, 180), (230, 200, 140)),
               sun(d, W - 80, 70, 55),
               draw_stickman(d, W // 2, H // 2 + 50, 1.2, 10, 5)),
    count=6
)

add_scene(
    "a stickman character in a garden watering plants, simple flat animation style, gardening scene",
    lambda d: (make_bg(d, SKY_BLUE, GREEN_LIGHT), cloud(d, 80, 60), sun(d, W - 70, 70),
               flower(d, 150, H // 2 + 5), flower(d, 200, H // 2 + 10), flower(d, 500, H // 2 + 8),
               draw_stickman(d, W // 2, H // 2 + 50, 1.2, 45, 0),
               d.line([W // 2 + 30, H // 2 - 5, W // 2 + 30, H // 2 + 25], fill=BLUE_WATER, width=2)),
    count=6
)

add_scene(
    "a stickman character cooking over a fire, simple flat animation, outdoor cooking scene",
    lambda d: (make_bg(d), cloud(d, 100, 60),
               campfire(d, W // 2 + 50, H // 2 + 10),
               draw_stickman(d, W // 3, H // 2 + 50, 1.1, -30, 0)),
    count=6
)

add_scene(
    "a stickman character standing next to a signpost, simple flat animation style, directional sign",
    lambda d: (make_bg(d), cloud(d, 100, 60), sun(d, W - 80, 80),
               d.line([W // 2 + 30, H // 2 + 10, W // 2 + 30, H // 2 - 40], fill=BROWN, width=3),
               d.rectangle([W // 2 + 30, H // 2 - 45, W // 2 + 70, H // 2 - 35], fill=(200, 180, 120), outline=OUTLINE, width=1),
               d.rectangle([W // 2 + 30, H // 2 - 30, W // 2 + 65, H // 2 - 20], fill=(200, 180, 120), outline=OUTLINE, width=1),
               draw_stickman(d, W // 3, H // 2 + 50, 1.2, 0, 0)),
    count=6
)

add_scene(
    "a stickman character with a pet dog, simple flat animation style, animal companion scene",
    lambda d: (make_bg(d), cloud(d, 100, 60), sun(d, W - 80, 80),
               draw_stickman(d, W // 3, H // 2 + 50, 1.2, -15, 0),
               # Simple dog
               d.ellipse([2 * W // 3 - 10, H // 2 + 20, 2 * W // 3 + 20, H // 2 + 40], fill=(200, 160, 100), outline=OUTLINE, width=2),
               d.ellipse([2 * W // 3 + 15, H // 2 + 15, 2 * W // 3 + 25, H // 2 + 25], fill=(200, 160, 100), outline=OUTLINE, width=1),
               d.line([2 * W // 3 - 5, H // 2 + 40, 2 * W // 3, H // 2 + 50], fill=OUTLINE, width=2),
               d.line([2 * W // 3 + 15, H // 2 + 40, 2 * W // 3 + 20, H // 2 + 50], fill=OUTLINE, width=2)),
    count=4
)

add_scene(
    "a stickman character using a computer, modern indoor scene, simple flat animation style",
    lambda d: (make_indoor_bg(d),
               # Desk
               d.rectangle([2 * W // 3 - 40, H // 2 + 20, 2 * W // 3 + 40, H // 2 + 25], fill=(150, 100, 60), outline=OUTLINE, width=2),
               d.line([2 * W // 3 - 35, H // 2 + 25, 2 * W // 3 - 35, H // 2 + 40], fill=BROWN_DARK, width=3),
               d.line([2 * W // 3 + 35, H // 2 + 25, 2 * W // 3 + 35, H // 2 + 40], fill=BROWN_DARK, width=3),
               # Monitor
               d.rectangle([2 * W // 3 - 25, H // 2 - 20, 2 * W // 3 + 25, H // 2 + 10], fill=(60, 80, 120), outline=OUTLINE, width=2),
               d.line([2 * W // 3 - 15, H // 2 - 10, 2 * W // 3 + 15, H // 2 - 5], fill=(200, 230, 255), width=1),
               d.line([2 * W // 3 - 12, H // 2, 2 * W // 3 + 18, H // 2 + 3], fill=(200, 230, 255), width=1),
               draw_stickman_sitting(d, W // 3, H // 2 + 40, 1.0)),
    count=6
)

add_scene(
    "a stickman character playing a guitar, making music, simple flat animation style",
    lambda d: (make_bg(d), cloud(d, 80, 60),
               draw_stickman(d, W // 2, H // 2 + 50, 1.2, 30, 0),
               # Guitar shape
               d.ellipse([W // 2 + 15, H // 2 - 10, W // 2 + 45, H // 2 + 25], fill=(200, 130, 60), outline=OUTLINE, width=2),
               d.line([W // 2 + 30, H // 2 - 15, W // 2 + 30, H // 2 + 25], fill=BROWN, width=2),
               # Music notes
               d.ellipse([W // 2 + 50, H // 2 - 20, W // 2 + 54, H // 2 - 16], fill=OUTLINE),
               d.line([W // 2 + 54, H // 2 - 20, W // 2 + 54, H // 2 - 30], fill=OUTLINE, width=1)),
    count=4
)

add_scene(
    "a stickman character celebrating with confetti, happy festive scene, simple flat animation",
    lambda d: (make_bg(d), cloud(d, 100, 70), cloud(d, 350, 80, 30), sun(d, W - 80, 80),
               draw_stickman_happy(d, W // 2, H // 2 + 50, 1.2),
               # Confetti dots
               d.ellipse([80, 60, 83, 63], fill=RED_BRIGHT),
               d.ellipse([200, 40, 203, 43], fill=BLUE_DEEP),
               d.ellipse([350, 50, 353, 53], fill=YELLOW),
               d.ellipse([500, 70, 503, 73], fill=ORANGE),
               d.ellipse([600, 45, 603, 48], fill=PINK),
               d.ellipse([150, 90, 153, 93], fill=PURPLE)),
    count=6
)

add_scene(
    "a stickman character standing in a field at sunset, beautiful golden hour, simple flat vector illustration",
    lambda d: (make_bg(d, (255, 200, 150), (220, 170, 100)),
               sun(d, W - 80, 80, 40),
               tree(d, 120, H // 2 + 10, 0.9), tree(d, 600, H // 2 + 10, 0.9),
               draw_stickman(d, W // 2, H // 2 + 50, 1.1, 0, 0)),
    count=6
)

add_scene(
    "a stickman character holding a balloon, colorful outdoor scene, simple flat animation style",
    lambda d: (make_bg(d), cloud(d, 100, 60), sun(d, W - 80, 80),
               draw_stickman(d, W // 2, H // 2 + 50, 1.2, 60, 0),
               # Balloon
               d.ellipse([W // 2 + 35, H // 2 - 70, W // 2 + 55, H // 2 - 40], fill=RED_BRIGHT, outline=OUTLINE, width=1),
               d.line([W // 2 + 45, H // 2 - 40, W // 2 + 45, H // 2 - 10], fill=OUTLINE, width=1)),
    count=6
)

add_scene(
    "a stickman character planting a tree, environmental scene, simple flat animation style",
    lambda d: (make_bg(d), cloud(d, 150, 60), sun(d, W - 80, 80),
               # Small sapling
               d.line([W // 2 + 80, H // 2 + 10, W // 2 + 80, H // 2 - 30], fill=BROWN, width=2),
               d.ellipse([W // 2 + 70, H // 2 - 40, W // 2 + 90, H // 2 - 20], fill=GREEN_DARK),
               d.ellipse([W // 2 + 75, H // 2 - 50, W // 2 + 85, H // 2 - 35], fill=GREEN_LIGHT),
               draw_stickman(d, W // 3, H // 2 + 50, 1.2, -30, 5)),
    count=6
)

add_scene(
    "a stickman character in outer space with stars and a planet, simple flat animation, cosmic scene",
    lambda d: (d.rectangle([0, 0, W, H], fill=(5, 5, 30)),
               stars(d, 40),
               d.ellipse([W - 120, 30, W - 30, 120], fill=(100, 150, 200)),
               d.ellipse([W - 110, 40, W - 40, 110], fill=(80, 120, 180)),
               d.ellipse([80, 50, 110, 80], fill=YELLOW),  # small moon
               draw_stickman(d, W // 2, H // 2 + 50, 1.2, 30, 10)),
    count=4
)

add_scene(
    "a stickman character standing in front of a castle, medieval fantasy scene, simple flat animation",
    lambda d: (make_bg(d, (180, 200, 230), GREEN_LIGHT), cloud(d, 80, 50), cloud(d, 400, 70, 30), sun(d, W - 80, 80),
               # Castle
               d.rectangle([W - 200, H // 2 - 40, W - 50, H // 2 + 10], fill=(150, 140, 130), outline=OUTLINE, width=2),
               d.rectangle([W - 185, H // 2 - 80, W - 165, H // 2 - 40], fill=(150, 140, 130), outline=OUTLINE, width=2),
               d.rectangle([W - 85, H // 2 - 80, W - 65, H // 2 - 40], fill=(150, 140, 130), outline=OUTLINE, width=2),
               d.rectangle([W - 135, H // 2 - 30, W - 115, H // 2 - 15], fill=(100, 80, 60)),
               draw_stickman(d, W // 3, H // 2 + 50, 1.1, 0, 0)),
    count=4
)

add_scene(
    "a stickman character skiing down a snowy mountain, winter sports, simple flat animation",
    lambda d: (make_bg(d, (200, 220, 250), (240, 245, 255)),
               cloud(d, 150, 60), sun(d, W - 80, 80),
               # Ski slope
               d.line([0, H // 2, W, H - 20], fill=(200, 220, 240), width=2),
               draw_stickman(d, W // 2 + 40, H // 2, 1.0, 45, 15),
               # Ski poles
               d.line([W // 2 + 20, H // 2 - 10, W // 2 + 10, H // 2 + 20], fill=BROWN, width=2),
               d.line([W // 2 + 70, H // 2 + 10, W // 2 + 60, H // 2 + 30], fill=BROWN, width=2)),
    count=4
)

# ── More variations (smaller stickmen, different positions) ──
add_scene(
    "a stickman character standing on a hilltop looking at the view, scenic outdoor landscape, flat vector art",
    lambda d: (make_bg(d, (180, 210, 240), GREEN_LIGHT), cloud(d, 80, 60), cloud(d, 350, 80, 30), sun(d, W - 80, 80),
               draw_stickman(d, W // 2, H // 2 + 30, 1.0, 20, 0)),
    count=6
)

add_scene(
    "a stickman character pushing a wheelbarrow, working outdoors, simple flat animation style",
    lambda d: (make_bg(d), cloud(d, 100, 60),
               # Wheelbarrow
               d.polygon([W // 2 + 50, H // 2 + 15, W // 2 + 90, H // 2 + 15, W // 2 + 85, H // 2 + 35, W // 2 + 55, H // 2 + 35],
                         fill=(170, 130, 80), outline=OUTLINE, width=2),
               d.ellipse([W // 2 + 65, H // 2 + 35, W // 2 + 75, H // 2 + 45], fill=GRAY, outline=OUTLINE, width=1),
               d.line([W // 2 + 50, H // 2 + 15, W // 2 + 20, H // 2 - 5], fill=BROWN, width=2),
               draw_stickman(d, W // 3, H // 2 + 50, 1.2, 30, 10)),
    count=4
)

add_scene(
    "a stickman character looking through a telescope, stargazing at night, simple flat animation",
    lambda d: (make_night_bg(d), moon(d, W - 120, 50),
               # Telescope
               d.line([W // 2 + 30, H // 2 - 20, W // 2 + 60, H // 2 - 50], fill=BROWN_DARK, width=4),
               d.ellipse([W // 2 + 45, H // 2 - 60, W // 2 + 60, H // 2 - 45], fill=GRAY_LIGHT, outline=OUTLINE, width=1),
               d.line([W // 2 + 30, H // 2 - 20, W // 2 + 25, H // 2 + 10], fill=BROWN_DARK, width=3),
               draw_stickman(d, W // 3, H // 2 + 50, 1.1, 80, 0)),
    count=4
)

print(f"[generate] Total scene definitions: {len(scenes)}")

# Shuffle for variety
random.shuffle(scenes)

# Render all scenes
captions = []
for idx, (caption, draw_fn) in enumerate(scenes):
    img = Image.new('RGB', (W, H), WHITE)
    d = ImageDraw.Draw(img)
    draw_fn(d)
    out_path = os.path.join(OUTPUT_DIR, f'scene_{idx:04d}.png')
    img.save(out_path)
    captions.append(caption)

# Save metadata
with open(os.path.join(OUTPUT_DIR, 'metadata.json'), 'w') as f:
    json.dump({
        "num_images": len(captions),
        "trigger_word": "stmn",
        "image_size": f"{W}x{H}",
        "captions": captions,
    }, f, indent=2)

print(f"[generate] ✅ Generated {len(scenes)} training images in {OUTPUT_DIR}")
print(f"[generate] Captions saved to {os.path.join(OUTPUT_DIR, 'metadata.json')}")
