"""
Generate synthetic stickman training images matching the reference style.
"""
import os, random, math, json
from PIL import Image, ImageDraw

OUTPUT_DIR = r'C:\Users\Admin\Desktop\youtubeauto\python\training_data'
os.makedirs(OUTPUT_DIR, exist_ok=True)

SKY_BLUE = (205, 234, 241)
GROUND_TAN = (226, 181, 107)
SKIN = (252, 191, 141)
OUTLINE = (0, 0, 0)
WHITE = (255, 255, 255)
GREEN = (180, 210, 140)
BROWN = (160, 120, 80)
GRAY = (180, 175, 165)
ORANGE = (255, 180, 50)
RED = (220, 80, 40)
DARK_GREEN = (140, 190, 100)
WATER = (150, 195, 215)
YELLOW = (255, 220, 80)
MOON = (240, 240, 200)
NIGHT_SKY = (20, 20, 50)
NIGHT_GROUND = (60, 50, 40)

W, H = 768, 432
random.seed(42)

def draw_stickman(draw, cx, cy, s=1.0, arm_a=0, leg_a=0):
    hr = int(15 * s)
    bl = int(35 * s)
    al = int(25 * s)
    ll = int(30 * s)
    top = cy - bl//2
    bot = cy + bl//2
    hy = top - hr

    draw.ellipse([cx-hr, hy-hr, cx+hr, hy+hr], fill=SKIN, outline=OUTLINE, width=max(2,int(2*s)))
    eo = int(5 * s)
    er = max(2, int(2.5 * s))
    draw.ellipse([cx-eo-er, hy-er, cx-eo+er, hy+er], fill=OUTLINE)
    draw.ellipse([cx+eo-er, hy-er, cx+eo+er, hy+er], fill=OUTLINE)

    draw.line([cx, hy+hr, cx, bot], fill=OUTLINE, width=max(2, int(2*s)))
    rad = math.radians(arm_a)
    ax1 = cx - int(al * math.cos(rad))
    ay1 = top + int(al*0.4) - int(al*0.4 * math.sin(rad))
    ax2 = cx + int(al * math.cos(rad))
    ay2 = top + int(al*0.4) - int(al*0.4 * math.sin(rad))
    draw.line([cx, top+int(al*0.3), ax1, ay1], fill=OUTLINE, width=max(2,int(2*s)))
    draw.line([cx, top+int(al*0.3), ax2, ay2], fill=OUTLINE, width=max(2,int(2*s)))

    lrad = math.radians(leg_a)
    lx1 = cx - int(ll*0.4) - int(ll*0.3 * math.sin(lrad))
    ly1 = bot + int(ll*0.4) + int(ll*0.3 * math.cos(lrad))
    lx2 = cx + int(ll*0.4) + int(ll*0.3 * math.sin(lrad))
    ly2 = bot + int(ll*0.4) + int(ll*0.3 * math.cos(lrad))
    draw.line([cx, bot, lx1, ly1], fill=OUTLINE, width=max(2,int(2*s)))
    draw.line([cx, bot, lx2, ly2], fill=OUTLINE, width=max(2,int(2*s)))

def cloud(d, x, y, sz=40):
    d.ellipse([x, y, x+sz*1.5, y+sz//2], fill=WHITE)
    d.ellipse([x+sz//3, y-sz//3, x+sz, y+sz//3], fill=WHITE)
    d.ellipse([x+sz//2, y-sz//4, x+sz*1.2, y+sz//3], fill=WHITE)

def sun(d, x, y, r=50):
    d.ellipse([x-r, y-r, x+r, y+r], fill=YELLOW)

def tree(d, x, y):
    d.rectangle([x-5, y-80, x+5, y], fill=BROWN, outline=OUTLINE, width=2)
    d.ellipse([x-30, y-120, x+30, y-60], fill=DARK_GREEN, outline=OUTLINE, width=2)

def rock(d, x, y, sz=25):
    d.ellipse([x-sz//2, y-sz//2, x+sz//2, y+sz//2], fill=GRAY, outline=OUTLINE, width=2)

def campfire(d, x, y):
    d.line([x-20, y, x+15, y-5], fill=BROWN, width=4)
    d.line([x-10, y-3, x+20, y], fill=BROWN, width=4)
    d.ellipse([x-12, y-30, x+12, y-5], fill=ORANGE, outline=OUTLINE, width=1)
    d.ellipse([x-6, y-22, x+6, y-8], fill=RED)

def house(d, x, y):
    d.rectangle([x-40, y-50, x+40, y], fill=(200,170,120), outline=OUTLINE, width=2)
    d.polygon([x-45, y-50, x, y-85, x+45, y-50], fill=(180,80,40), outline=OUTLINE, width=2)
    d.rectangle([x-8, y-25, x+8, y], fill=BROWN, outline=OUTLINE, width=1)

def moon_obj(d, x, y, r=35):
    d.ellipse([x-r, y-r, x+r, y+r], fill=MOON, outline=OUTLINE, width=2)

def grass(d, x, y, n=5):
    for _ in range(n):
        gx = x + random.randint(-20, 20)
        gh = random.randint(8, 18)
        d.line([gx, y, gx+random.randint(-3,3), y-gh], fill=GREEN, width=2)

def spear(d, x, y, h=35):
    d.line([x, y, x, y-h], fill=BROWN, width=3)
    d.polygon([x-5, y-h, x+5, y-h, x, y-h-12], fill=GRAY, outline=OUTLINE, width=1)

def water(d, y, h=40):
    d.rectangle([0, y, W, y+h], fill=WATER)

def make_bg(d, sky=SKY_BLUE, ground=GROUND_TAN):
    d.rectangle([0, 0, W, H//2], fill=sky)
    d.rectangle([0, H//2, W, H], fill=ground)

def bird(d, x, y):
    d.line([x-10, y, x, y-7], fill=OUTLINE, width=2)
    d.line([x, y-7, x+10, y], fill=OUTLINE, width=2)

# Scenes: list of (caption_template, draw_function)
scene_defs = []
for i in range(10):
    scene_defs.append(("a stickman character standing outside, simple flat animation style, blue sky, tan ground",
        lambda d: (make_bg(d), cloud(d,100,60), cloud(d,350,80,30), sun(d,W-80,80), draw_stickman(d,W//2,H//2+50,1.2,0,0))))
for i in range(10):
    scene_defs.append(("a stickman character walking across a field, simple flat animation art, tan ground and blue sky",
        lambda d: (make_bg(d), cloud(d,150,50), grass(d,200,H//2), grass(d,400,H//2), draw_stickman(d,W//2,H//2+50,1.2,30,15))))
for i in range(10):
    scene_defs.append(("a stickman character running, simple flat animation style, dynamic pose, blue sky",
        lambda d: (make_bg(d), cloud(d,300,50), tree(d,100,H//2+10), sun(d,W-80,80), draw_stickman(d,W//2,H//2+50,1.2,45,-20))))
for i in range(10):
    scene_defs.append(("a stickman character sitting by a campfire at night, simple flat animation, dark sky with moon",
        lambda d: (make_bg(d,NIGHT_SKY,NIGHT_GROUND), moon_obj(d,W-80,80), draw_stickman(d,W//3,H//2+50,1.2,-20,0), campfire(d,2*W//3,H//2+10))))
for i in range(10):
    scene_defs.append(("a stickman character building a house, simple flat animation style, blue sky, tan ground",
        lambda d: (make_bg(d), cloud(d,100,60), draw_stickman(d,W//3,H//2+50,1.2,-45,0), house(d,2*W//3,H//2+10))))
for i in range(10):
    scene_defs.append(("a stickman character holding a spear, simple flat animation style, prehistoric tools",
        lambda d: (make_bg(d), cloud(d,250,70), tree(d,120,H//2+10), sun(d,W-80,80), draw_stickman(d,W//2,H//2+50,1.2,90,0), spear(d,W//2+30,H//2+10))))
for i in range(10):
    scene_defs.append(("a stickman character standing near water, simple flat animation style, river scene",
        lambda d: (make_bg(d), cloud(d,80,50), cloud(d,350,80,30),
            d.rectangle([0, H//2, W, H], fill=GROUND_TAN), water(d,H//2-20,50),
            draw_stickman(d,W//2,H//2+60,1.2,0,0))))
for i in range(10):
    scene_defs.append(("a stickman character in nature with birds, simple flat animation, green grass and blue sky",
        lambda d: (d.rectangle([0,0,W,H//2],fill=SKY_BLUE), d.rectangle([0,H//2,W,H],fill=GREEN),
            cloud(d,50,60), sun(d,80,80), tree(d,W-80,H//2+10),
            draw_stickman(d,W//3,H//2+50,1.2,0,0), bird(d,2*W//3,H//3), bird(d,2*W//3+40,H//3-20))))
for i in range(10):
    scene_defs.append(("two stickman characters talking by a campfire, social scene, simple flat animation",
        lambda d: (make_bg(d), cloud(d,150,60), sun(d,W-80,80),
            draw_stickman(d,W//2-80,H//2+50,1.0,-20,0), draw_stickman(d,W//2+80,H//2+50,1.0,20,0),
            campfire(d,W//2,H//2+10))))
for i in range(10):
    scene_defs.append(("a stickman character exploring rocky terrain, simple flat animation, prehistoric landscape",
        lambda d: (make_bg(d), cloud(d,200,80), sun(d,W-80,70),
            draw_stickman(d,W//3,H//2+50,1.2,0,0),
            rock(d,100,H//2+10,30), rock(d,150,H//2+5,20), rock(d,500,H//2+15,35))))
for i in range(10):
    scene_defs.append(("a stickman character in a forest with trees, simple flat animation style, nature scene",
        lambda d: (d.rectangle([0,0,W,H//2],fill=SKY_BLUE), d.rectangle([0,H//2,W,H],fill=GREEN),
            cloud(d,50,60), sun(d,W-80,80), draw_stickman(d,W//2,H//2+50,1.2,0,0),
            tree(d,120,H//2+10), tree(d,650,H//2+10))))
for i in range(10):
    scene_defs.append(("a stickman character fishing by a river, simple flat animation style, prehistoric scene",
        lambda d: (d.rectangle([0,0,W,H//2],fill=SKY_BLUE), water(d,H//2-20,70),
            d.rectangle([0,H//2+5,W//3,H],fill=GROUND_TAN), d.rectangle([2*W//3,H//2+5,W,H],fill=GROUND_TAN),
            cloud(d,100,60), sun(d,W-80,80), draw_stickman(d,W//4,H//2+60,1.2,80,0),
            d.line([W//4+30,H//2+20,W//4+30,H//2-30],fill=BROWN,width=2),
            d.line([W//4+30,H//2-30,W//4+50,H//2-20],fill=BROWN,width=2))))
for i in range(10):
    scene_defs.append(("a stickman character sleeping on the ground at night, simple flat animation, dark scene",
        lambda d: (d.rectangle([0,0,W,H//2],fill=NIGHT_SKY), d.rectangle([0,H//2,W,H],fill=NIGHT_GROUND),
            moon_obj(d,W-80,80), draw_stickman(d,W//2,H//2+60,1.0,-10,-10), campfire(d,W//2+100,H//2+10))))
for i in range(10):
    scene_defs.append(("a stickman character gathering food or plants, simple flat animation, foraging scene",
        lambda d: (make_bg(d), cloud(d,100,70), cloud(d,400,90,30), sun(d,W-80,80),
            draw_stickman(d,W//2,H//2+50,1.2,-30,5), grass(d,W//2-30,H//2+10,8), grass(d,W//2+50,H//2+15,6))))
for i in range(10):
    scene_defs.append(("a stickman character carrying wood, simple flat animation style, daily work scene",
        lambda d: (make_bg(d), cloud(d,100,60), sun(d,W-80,80),
            draw_stickman(d,W//2,H//2+50,1.2,10,0),
            d.line([W//2-20,H//2-30,W//2+20,H//2-30],fill=BROWN,width=4),
            d.line([W//2-22,H//2-25,W//2+18,H//2-25],fill=BROWN,width=3))))

# Render all scenes
captions = []
random.shuffle(scene_defs)

for idx, (caption, draw_fn) in enumerate(scene_defs):
    img = Image.new('RGB', (W, H), WHITE)
    d = ImageDraw.Draw(img)
    draw_fn(d)
    path = os.path.join(OUTPUT_DIR, f'scene_{idx:04d}.png')
    img.save(path)
    captions.append(caption)

print(f"Generated {len(scene_defs)} training images in {OUTPUT_DIR}")
with open(os.path.join(OUTPUT_DIR, 'metadata.json'), 'w') as f:
    json.dump({"num_images": len(scene_defs), "trigger_word": "stmn", "captions": captions}, f, indent=2)
