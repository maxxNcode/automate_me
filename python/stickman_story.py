#!/usr/bin/env python3
"""
Stickman Story Video Generator (AI-Powered Scene Backgrounds)
==============================================================
For each scene:
  1. Generate a beautiful AI background image using local Stable Diffusion (segmind/tiny-sd)
     — the background is the SCENE (without people)
  2. Composite a stickman character into the scene as the STORY PROTAGONIST
     — the stickman is IN the story, not a narrator
  3. Render captions matching the narration
  4. Assemble slideshow video with audio via ffmpeg

This produces a high-quality illustrated story where the stickman character
lives through the events being described.

Input via stdin JSON:
{
  "action": "stickman_story",
  "scenes": [{"text": "...", "searchTerms": ["keyword1", "keyword2"]}],
  "audio_path": "path/to/audio.wav",
  "output_filename": "story_1234.mp4",
  "resolution": "1080x1920",
  "caption_position": "bottom",
  "caption_background_color": "black"
}
"""

import sys
import json
import os
import subprocess
import math
import random
import tempfile
import shutil
import re
import gc
import time
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# ── AI Image Generation (segmind/tiny-sd, local, free, fits in 1GB VRAM) ──
try:
    import torch
    from diffusers import StableDiffusionPipeline
    DIFFUSION_AVAILABLE = True
except ImportError:
    DIFFUSION_AVAILABLE = False

# ──────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────

DEFAULT_RESOLUTION = (1080, 1920)  # 9:16 portrait
TARGET_WORDS_PER_SECOND = 2.8      # narration speed estimate

# AI generation settings (segmind/tiny-sd: 1GB VRAM, fits RTX 3060 6GB easily)
AI_IMAGE_SIZE = 512                 # tiny-sd trained at 512x512
AI_INFERENCE_STEPS = 15             # good quality + speed tradeoff
AI_GUIDANCE_SCALE = 7.5             # standard CFG for SD 1.5 / tiny-sd
AI_MODEL = "segmind/tiny-sd"

# Stickman sizing (relative to frame height)
STICKMAN_HEIGHT_RATIO = 0.25        # stickman fills ~25% of frame height
STICKMAN_X_RATIO = 0.5              # horizontal position (0.5 = center)
STICKMAN_Y_RATIO = 0.82             # feet position (of frame height)
STICKMAN_LINE_WIDTH = 4

# Colors
STICKMAN_BODY_COLOR = (30, 30, 40)
STICKMAN_HEAD_COLOR = (245, 200, 170)  # skin tone
STICKMAN_ACCESSORY_COLOR = (200, 80, 60)  # hat/shirt accent

# ──────────────────────────────────────────────
# Global AI Pipeline (loaded once)
# ──────────────────────────────────────────────

_pipe = None
_pipe_lock = False


def _get_pipeline():
    """Get or create the shared segmind/tiny-sd pipeline."""
    global _pipe, _pipe_lock
    if _pipe is not None:
        return _pipe
    if _pipe_lock:
        return None  # another thread is loading, skip for now
    _pipe_lock = True

    if not DIFFUSION_AVAILABLE:
        _pipe_lock = False
        return None

    try:
        print("[stickman_story] Loading segmind/tiny-sd pipeline...", file=sys.stderr)
        t0 = time.time()

        _pipe = StableDiffusionPipeline.from_pretrained(
            AI_MODEL,
            torch_dtype=torch.float16,
            safety_checker=None,
            requires_safety_checker=False,
        )

        # Memory optimizations — tiny-sd is only ~1GB so we don't need CPU offload
        _pipe.enable_attention_slicing()
        _pipe = _pipe.to("cuda")

        elapsed = time.time() - t0
        print(f"[stickman_story] segmind/tiny-sd loaded in {elapsed:.1f}s", file=sys.stderr)
        _pipe_lock = False
        return _pipe
    except Exception as e:
        print(f"[stickman_story] Failed to load segmind/tiny-sd: {e}", file=sys.stderr)
        _pipe_lock = False
        return None


def _generate_ai_background(prompt: str, resolution: tuple) -> Image.Image | None:
    """
    Generate a background image using segmind/tiny-sd.
    Returns a PIL Image at the target resolution, or None on failure.

    The prompt should describe the SCENE without people.
    """
    pipe = _get_pipeline()
    if pipe is None:
        return None

    target_w, target_h = resolution

    try:
        # Clear any leftover GPU memory
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        # Generate at AI_IMAGE_SIZE
        with torch.no_grad():
            result = pipe(
                prompt=prompt,
                negative_prompt=(
                    "people, person, human, man, woman, child, face, body, "
                    "text, watermark, signature, logo, low quality, blurry, distorted"
                ),
                num_inference_steps=AI_INFERENCE_STEPS,
                guidance_scale=AI_GUIDANCE_SCALE,
                width=AI_IMAGE_SIZE,
                height=AI_IMAGE_SIZE,
            ).images[0]

        # Upscale to fill target resolution (1100x1100 intermediate for better upscale)
        upscale_size = (max(target_w, target_h) + 200, max(target_w, target_h) + 200)
        result = result.resize(upscale_size, Image.LANCZOS)

        # Crop to target aspect ratio (9:16 portrait)
        img_w, img_h = result.size
        target_aspect = target_w / target_h
        img_aspect = img_w / img_h

        if img_aspect > target_aspect:
            # Image is wider — crop horizontally
            new_w = int(img_h * target_aspect)
            offset = (img_w - new_w) // 2
            result = result.crop((offset, 0, offset + new_w, img_h))
        else:
            # Image is taller — crop vertically
            new_h = int(img_w / target_aspect)
            offset = (img_h - new_h) // 2
            result = result.crop((0, offset, img_w, offset + new_h))

        # Final resize to exact target resolution
        result = result.resize(resolution, Image.LANCZOS)

        # Convert to RGBA for compositing
        if result.mode != 'RGBA':
            result = result.convert('RGBA')

        return result

    except Exception as e:
        print(f"[stickman_story] AI generation failed: {e}", file=sys.stderr)
        return None


# ──────────────────────────────────────────────
# Prompt Construction
# ──────────────────────────────────────────────

# Scene theme templates — each describes a BACKGROUND WITHOUT PEOPLE
SCENE_THEMES = {
    'space': 'outer space stars nebula cosmic scene, spaceship, planets, galaxy, starfield',
    'underwater': 'underwater ocean coral reef scene, deep sea, aquatic environment, marine',
    'forest': 'forest woods nature scene, tall trees, sunlight filtering through leaves, lush green',
    'city': 'modern city urban skyline scene, skyscrapers, cityscape, buildings downtown',
    'desert': 'desert sand dunes landscape, hot sun, golden sand, arid wilderness',
    'mountain': 'mountain range alpine landscape, snowy peaks, rocky terrain, valley below',
    'beach': 'tropical beach ocean coast scene, palm trees, turquoise water, white sand',
    'night': 'night sky starry scene, moonlight, dark blue sky, quiet atmospheric',
    'castle': 'medieval castle fortress scene, stone walls, towers, kingdom, fantasy',
    'ancient': 'ancient ruins historical site, old stone architecture, archaeological',
    'technology': 'futuristic technology lab scene, computers servers, holographic displays, digital',
    'military': 'military command center scene, tactical screens, equipment, war room',
    'sports': 'sports stadium arena scene, field court track, bleachers, competition',
    'classroom': 'classroom educational scene, desks chairs blackboard, school, learning',
    'office': 'modern office workspace scene, desk computer, corporate, professional',
    'factory': 'industrial factory warehouse scene, machinery, production line, manufacturing',
    'hospital': 'hospital medical room scene, equipment monitors, clean bright, healthcare',
    'farm': 'farm rural countryside scene, barn fields, animals, agricultural landscape',
    'street': 'street road city scene, sidewalk buildings, urban outdoor, neighborhood',
    'library': 'library bookshelves scene, books quiet reading, knowledge, study room',
    'laboratory': 'science laboratory scene, experiment equipment, beakers, research',
    'battlefield': 'war battlefield scene, smoke, destroyed landscape, dramatic sky, conflict',
    'jungle': 'dense jungle tropical rainforest scene, vines, exotic plants, lush vegetation, wild nature',
    'arctic': 'arctic frozen landscape scene, snow ice, polar environment, cold blue lighting',
    'volcano': 'volcanic landscape erupting scene, lava flow, dramatic red orange glow, smoke',
    'temple': 'ancient temple sacred place scene, columns statues, spiritual atmosphere, stone architecture',
}


def _detect_scene_theme(search_terms: list[str], scene_text: str) -> str:
    """Detect the visual theme for scene background from search terms + text."""
    combined = ' '.join(search_terms).lower() + ' ' + scene_text.lower()
    scores = {}
    for theme, _ in SCENE_THEMES.items():
        theme_keywords = set(theme.lower().split())
        for kw in theme_keywords:
            if kw in combined and len(kw) > 2:
                scores[theme] = scores.get(theme, 0) + 1
    if not scores:
        return 'city'
    return max(scores, key=scores.get)


def _build_ai_prompt(scene_text: str, search_terms: list[str]) -> str:
    """
    Build a prompt for tiny-sd to generate a scene background.
    Describes the SCENE without people — the stickman character is composited later.
    """
    theme = _detect_scene_theme(search_terms, scene_text)
    base_prompt = SCENE_THEMES.get(theme, SCENE_THEMES['city'])

    # Extract key visual words from scene text
    text_lower = scene_text.lower()

    # Add descriptive modifiers based on scene text sentiment/context
    modifiers = []
    if any(w in text_lower for w in ['dark', 'night', 'shadow', 'midnight']):
        modifiers.append('dark atmospheric lighting')
    if any(w in text_lower for w in ['bright', 'sun', 'sunlight', 'golden']):
        modifiers.append('bright golden hour lighting')
    if any(w in text_lower for w in ['future', 'futuristic', 'advanced', 'high tech']):
        modifiers.append('futuristic cyberpunk style')
    if any(w in text_lower for w in ['ancient', 'old', 'historic', 'medieval']):
        modifiers.append('ancient historical atmosphere')
    if any(w in text_lower for w in ['happy', 'beautiful', 'wonderful', 'amazing']):
        modifiers.append('beautiful vibrant colors')
    if any(w in text_lower for w in ['sad', 'tragic', 'dark', 'gloomy']):
        modifiers.append('moody dramatic lighting')

    # Quality modifiers
    quality = 'cinematic, highly detailed, professional photography, 8k, sharp focus, stunning visuals'

    parts = [base_prompt] + modifiers + [quality]
    prompt = ', '.join(parts)

    return prompt


# ──────────────────────────────────────────────
# Font helpers
# ──────────────────────────────────────────────

def _find_font(size: int = 40) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Find a suitable TrueType font on the system, or fallback to default."""
    candidates = []
    win_fonts = [
        r'C:\Windows\Fonts\Arial.ttf',
        r'C:\Windows\Fonts\Segoe UI.ttf',
        r'C:\Windows\Fonts\Tahoma.ttf',
        r'C:\Windows\Fonts\Calibri.ttf',
    ]
    candidates.extend(win_fonts)
    candidates.extend([
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        '/System/Library/Fonts/Helvetica.ttc',
        '/Library/Fonts/Arial.ttf',
    ])
    for path in candidates:
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _find_bold_font(size: int = 46) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Find a bold TrueType font."""
    candidates = [
        r'C:\Windows\Fonts\Arialbd.ttf',
        r'C:\Windows\Fonts\Arial.ttf',
        r'C:\Windows\Fonts\segoeuib.ttf',
        r'C:\Windows\Fonts\Calibrib.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    ]
    for path in candidates:
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return _find_font(size)


def _get_text_width(font, text: str) -> int:
    """Get text width, compatible with Pillow 8.0+ and older versions."""
    if hasattr(font, 'getbbox'):
        try:
            bbox = font.getbbox(text)
            if bbox:
                return bbox[2] - bbox[0]
        except Exception:
            pass
    if hasattr(font, 'getsize'):
        try:
            return font.getsize(text)[0]
        except Exception:
            pass
    return len(text) * 20


def _draw_rounded_rect(draw, coords, radius=10, fill=None, outline=None, width=1):
    """Draw a rounded rectangle, compatible with Pillow 8.0+ and older versions."""
    try:
        draw.rounded_rectangle(coords, radius=radius, fill=fill, outline=outline, width=width)
    except AttributeError:
        x1, y1, x2, y2 = coords
        if fill:
            draw.rectangle([x1, y1, x2, y2], fill=fill)
        if outline:
            draw.rectangle([x1, y1, x2, y2], outline=outline, width=width)


# ──────────────────────────────────────────────
# Stickman Character Drawing
# ──────────────────────────────────────────────

def _draw_stickman_character(
    draw: ImageDraw,
    x: int, y: int,
    scale: float = 1.0,
    pose: str = 'standing',
    body_color: tuple = STICKMAN_BODY_COLOR,
    head_color: tuple = STICKMAN_HEAD_COLOR,
    accent_color: tuple = STICKMAN_ACCESSORY_COLOR,
):
    """
    Draw a stickman CHARACTER (the protagonist of the story).

    Unlike the old version which was a narrator stickman standing next to captions,
    THIS stickman is the PERSON IN THE STORY — drawn in different poses and
    placed inside the scene background.

    y = bottom of feet (ground position)

    Poses:
      'standing'  — neutral, hands at sides
      'pointing'  — pointing right (explaining/showing)
      'excited'   — arms raised in excitement
      'confident' — hands on hips
      'thinking'  — hand on chin
      'sad'       — drooped shoulders
    """
    s = scale
    head_r = int(16 * s)
    body_len = int(42 * s)
    arm_len = int(26 * s)
    leg_len = int(28 * s)
    shoulder_y = y - body_len - head_r * 2
    hip_y = y - leg_len
    line_w = max(2, int(STICKMAN_LINE_WIDTH * s * 0.7))

    # ── Legs ──
    if pose in ('standing', 'thinking', 'pointing'):
        draw.line([(x, hip_y), (x - int(6 * s), y)], fill=body_color, width=line_w)
        draw.line([(x, hip_y), (x + int(6 * s), y)], fill=body_color, width=line_w)
    elif pose == 'excited':
        draw.line([(x, hip_y), (x - int(10 * s), y)], fill=body_color, width=line_w)
        draw.line([(x, hip_y), (x + int(10 * s), y)], fill=body_color, width=line_w)
    elif pose == 'confident':
        draw.line([(x, hip_y), (x - int(8 * s), y)], fill=body_color, width=line_w)
        draw.line([(x, hip_y), (x + int(4 * s), y)], fill=body_color, width=line_w)
    elif pose == 'sad':
        draw.line([(x, hip_y), (x - int(4 * s), y + int(4 * s))], fill=body_color, width=line_w)
        draw.line([(x, hip_y), (x + int(4 * s), y + int(4 * s))], fill=body_color, width=line_w)

    # ── Body ──
    draw.line([(x, shoulder_y), (x, hip_y)], fill=body_color, width=line_w)

    # ── Arms ──
    arm_mid_y = shoulder_y + body_len // 3

    if pose == 'standing':
        draw.line([(x, shoulder_y + int(6 * s)), (x - int(14 * s), arm_mid_y + int(6 * s))], fill=body_color, width=line_w)
        draw.line([(x, shoulder_y + int(6 * s)), (x + int(14 * s), arm_mid_y + int(6 * s))], fill=body_color, width=line_w)
    elif pose == 'pointing':
        draw.line([(x, shoulder_y + int(6 * s)), (x - int(12 * s), arm_mid_y + int(8 * s))], fill=body_color, width=line_w)
        draw.line([(x, shoulder_y + int(6 * s)), (x + int(22 * s), arm_mid_y - int(4 * s))], fill=body_color, width=line_w)
    elif pose == 'excited':
        draw.line([(x, shoulder_y + int(6 * s)), (x - int(16 * s), arm_mid_y - int(16 * s))], fill=body_color, width=line_w)
        draw.line([(x, shoulder_y + int(6 * s)), (x + int(16 * s), arm_mid_y - int(16 * s))], fill=body_color, width=line_w)
    elif pose == 'confident':
        draw.line([(x, shoulder_y + int(6 * s)), (x - int(14 * s), hip_y - int(4 * s))], fill=body_color, width=line_w)
        draw.line([(x, shoulder_y + int(6 * s)), (x + int(14 * s), hip_y - int(4 * s))], fill=body_color, width=line_w)
    elif pose == 'thinking':
        draw.line([(x, shoulder_y + int(6 * s)), (x - int(10 * s), arm_mid_y + int(8 * s))], fill=body_color, width=line_w)
        chin_y = shoulder_y + head_r
        draw.line([(x, shoulder_y + int(6 * s)), (x + int(14 * s), chin_y - int(4 * s))], fill=body_color, width=line_w)
    elif pose == 'sad':
        draw.line([(x, shoulder_y + int(6 * s)), (x - int(8 * s), arm_mid_y + int(14 * s))], fill=body_color, width=line_w)
        draw.line([(x, shoulder_y + int(6 * s)), (x + int(8 * s), arm_mid_y + int(14 * s))], fill=body_color, width=line_w)

    # ── Head ──
    head_y = shoulder_y - head_r
    draw.ellipse([x - head_r, head_y - head_r, x + head_r, head_y + head_r],
                 fill=head_color, outline=body_color, width=max(1, int(2 * s)))

    # ── Face ──
    eye_offset = int(5 * s)
    eye_y = head_y - int(2 * s)

    if pose == 'happy':
        draw.ellipse([x - eye_offset - int(2 * s), eye_y - int(2 * s), x - eye_offset + int(2 * s), eye_y + int(2 * s)], fill=body_color)
        draw.ellipse([x + eye_offset - int(2 * s), eye_y - int(2 * s), x + eye_offset + int(2 * s), eye_y + int(2 * s)], fill=body_color)
        mouth_y = head_y + int(5 * s)
        draw.arc([x - int(6 * s), mouth_y - int(3 * s), x + int(6 * s), mouth_y + int(5 * s)], 0, 180, fill=body_color, width=2)
    elif pose == 'sad':
        draw.ellipse([x - eye_offset - int(2 * s), eye_y - int(1 * s), x - eye_offset + int(2 * s), eye_y + int(3 * s)], fill=body_color)
        draw.ellipse([x + eye_offset - int(2 * s), eye_y - int(1 * s), x + eye_offset + int(2 * s), eye_y + int(3 * s)], fill=body_color)
        mouth_y = head_y + int(6 * s)
        draw.arc([x - int(5 * s), mouth_y, x + int(5 * s), mouth_y + int(5 * s)], 180, 360, fill=body_color, width=2)
    elif pose == 'excited':
        draw.ellipse([x - eye_offset - int(3 * s), eye_y - int(2 * s), x - eye_offset + int(3 * s), eye_y + int(3 * s)], fill=body_color)
        draw.ellipse([x + eye_offset - int(3 * s), eye_y - int(2 * s), x + eye_offset + int(3 * s), eye_y + int(3 * s)], fill=body_color)
        mouth_y = head_y + int(5 * s)
        draw.ellipse([x - int(5 * s), mouth_y, x + int(5 * s), mouth_y + int(5 * s)], fill=body_color)
    elif pose == 'thinking':
        draw.ellipse([x - eye_offset - int(2 * s), eye_y - int(2 * s), x - eye_offset + int(2 * s), eye_y + int(2 * s)], fill=body_color)
        draw.ellipse([x + eye_offset - int(2 * s), eye_y - int(2 * s), x + eye_offset + int(2 * s), eye_y + int(2 * s)], fill=body_color)
        mouth_y = head_y + int(4 * s)
        draw.arc([x - int(4 * s), mouth_y, x + int(4 * s), mouth_y + int(4 * s)], 0, 180, fill=body_color, width=2)
    else:
        # Neutral / confident / pointing — standard face
        draw.ellipse([x - eye_offset - int(2 * s), eye_y - int(2 * s), x - eye_offset + int(2 * s), eye_y + int(2 * s)], fill=body_color)
        draw.ellipse([x + eye_offset - int(2 * s), eye_y - int(2 * s), x + eye_offset + int(2 * s), eye_y + int(2 * s)], fill=body_color)
        mouth_y = head_y + int(5 * s)
        draw.line([(x - int(4 * s), mouth_y), (x + int(4 * s), mouth_y)], fill=body_color, width=2)

    # ── Accessory / Theme Indicator ──
    if pose in ('confident', 'pointing', 'happy'):
        hat_y = head_y - head_r - int(2 * s)
        draw.arc([x - int(10 * s), hat_y, x + int(10 * s), hat_y + int(6 * s)], 0, 180, fill=accent_color, width=3)
        draw.rectangle([x - int(12 * s), hat_y - int(4 * s), x + int(12 * s), hat_y], fill=accent_color)


def _choose_pose(scene_text: str) -> str:
    """Choose a pose for the stickman based on the scene text's emotional context."""
    text_lower = scene_text.lower()
    if any(w in text_lower for w in ['happy', 'great', 'amazing', 'love', 'wonderful', 'excited', 'awesome', 'fantastic', 'celebrate', 'win']):
        return 'excited'
    if any(w in text_lower for w in ['sad', 'sorry', 'unfortunately', 'bad', 'terrible', 'fail', 'tragic', 'loss']):
        return 'sad'
    if any(w in text_lower for w in ['think', 'wonder', 'imagine', 'consider', 'maybe', 'perhaps', 'curious']):
        return 'thinking'
    if any(w in text_lower for w in ['here how', 'let me show', 'check this', 'look at', 'see how', 'try this']):
        return 'pointing'
    if any(w in text_lower for w in ['confident', 'best', 'number one', 'guaranteed', 'proven', 'powerful', 'strong']):
        return 'confident'
    return 'standing'


# ──────────────────────────────────────────────
# Caption Drawing
# ──────────────────────────────────────────────

def _draw_caption(draw: ImageDraw, width: int, height: int, text: str,
                  caption_position: str = 'bottom', bg_color: str = 'black'):
    """Draw a styled caption box with text at the specified position."""
    font = _find_font(int(36))
    bold_font = _find_bold_font(int(38))

    box_height = int(height * 0.14)
    if caption_position == 'top':
        box_y = 20
    elif caption_position == 'center':
        box_y = height // 2 - box_height // 2
    else:
        box_y = height - box_height - 30

    # Parse background color
    if isinstance(bg_color, str) and bg_color.startswith('#'):
        try:
            hex_color = bg_color.lstrip('#')
            bg_rgb = tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))
        except ValueError:
            bg_rgb = (0, 0, 0)
    elif bg_color == 'black':
        bg_rgb = (0, 0, 0)
    elif bg_color == 'white':
        bg_rgb = (255, 255, 255)
    elif bg_color == 'transparent':
        bg_rgb = None
    else:
        bg_rgb = (0, 0, 0)

    # Draw background box
    pad_x = 30
    if bg_rgb:
        _draw_rounded_rect(draw, [pad_x, box_y, width - pad_x, box_y + box_height],
                           radius=16, fill=(*bg_rgb, 180), outline=None)

    # Wrap text to fit inside box
    max_text_width = width - pad_x * 2 - 40
    words = text.split()
    lines = []
    current_line = ''
    for word in words:
        test_line = f'{current_line} {word}'.strip()
        tw = _get_text_width(font, test_line)
        if tw > max_text_width and current_line:
            lines.append(current_line)
            current_line = word
        else:
            current_line = test_line
    if current_line:
        lines.append(current_line)

    # Max 3 lines
    if len(lines) > 3:
        lines = lines[:2]
        lines.append(lines[-1][:min(len(lines[-1]), 20)] + '...')

    # Draw text centered in box
    line_height = int(42)
    total_text_height = len(lines) * line_height
    text_start_y = box_y + (box_height - total_text_height) // 2
    text_color = (255, 255, 255) if (bg_rgb and sum(bg_rgb[:3]) < 400) else (0, 0, 0)

    for i, line in enumerate(lines):
        tw = _get_text_width(font, line)
        tx = (width - tw) // 2
        ty = text_start_y + i * line_height
        # Text shadow
        draw.text((tx + 1, ty + 1), line, fill=(0, 0, 0, 140), font=font)
        draw.text((tx, ty), line, fill=text_color, font=bold_font)


# ──────────────────────────────────────────────
# Scene Image Generation
# ──────────────────────────────────────────────

def _generate_scene_image(
    scene_text: str,
    search_terms: list[str],
    resolution: tuple,
    caption_position: str,
    caption_bg_color: str,
    scene_index: int,
) -> Image.Image:
    """
    Generate ONE static scene image for a scene.

    1. Generate AI background from scene description
    2. Composite stickman character into the scene
    3. Render caption text

    Returns a PIL Image (RGBA) at target resolution.
    """
    width, height = resolution

    # ── Step 1: Generate AI background ──
    prompt = _build_ai_prompt(scene_text, search_terms)
    print(f"[Scene {scene_index}] AI prompt: {prompt[:100]}...", file=sys.stderr)

    bg_img = _generate_ai_background(prompt, resolution)

    if bg_img is None:
        # Fallback: gradient background
        print(f"[Scene {scene_index}] AI generation failed, using gradient fallback", file=sys.stderr)
        bg_img = Image.new('RGBA', resolution, (20, 25, 45, 255))
        draw_bg = ImageDraw.Draw(bg_img)
        for y in range(height):
            ratio = y / height
            r = int(20 + ratio * 40)
            g = int(25 + ratio * 30)
            b = int(45 + ratio * 35)
            draw_bg.line([(0, y), (width, y)], fill=(r, g, b, 255))
    else:
        # Darken the background slightly so the stickman pops
        dark_overlay = Image.new('RGBA', resolution, (0, 0, 0, 50))
        bg_img = Image.alpha_composite(bg_img, dark_overlay)

    # ── Step 2: Composite stickman character ──
    stickman_x = int(width * STICKMAN_X_RATIO)
    stickman_y = int(height * STICKMAN_Y_RATIO)
    stickman_scale = (height * STICKMAN_HEIGHT_RATIO) / 85.0

    pose = _choose_pose(scene_text)

    # Draw the stickman on a separate layer for compositing
    stickman_layer = Image.new('RGBA', resolution, (0, 0, 0, 0))
    draw_stickman = ImageDraw.Draw(stickman_layer)

    # Accent color based on theme
    theme = _detect_scene_theme(search_terms, scene_text)
    theme_accents = {
        'space': (100, 150, 255),
        'underwater': (0, 180, 200),
        'forest': (60, 160, 60),
        'city': (200, 100, 80),
        'desert': (220, 180, 80),
        'mountain': (120, 140, 180),
        'beach': (255, 180, 80),
        'night': (150, 120, 200),
        'castle': (200, 80, 60),
    }
    accent = theme_accents.get(theme, STICKMAN_ACCESSORY_COLOR)

    _draw_stickman_character(
        draw_stickman,
        stickman_x, stickman_y,
        scale=stickman_scale,
        pose=pose,
        accent_color=accent,
    )

    # Composite stickman onto background
    final_img = Image.alpha_composite(bg_img, stickman_layer)

    # ── Step 3: Draw caption ──
    draw_cap = ImageDraw.Draw(final_img)
    _draw_caption(draw_cap, width, height, scene_text, caption_position, caption_bg_color)

    return final_img


# ──────────────────────────────────────────────
# FFMpeg helpers
# ──────────────────────────────────────────────

def _find_ffmpeg() -> str:
    """Locate ffmpeg executable."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    win_candidates = [
        os.path.join(project_root, 'ffmpeg_bin', 'ffmpeg.exe'),
        os.path.join(project_root, 'ffmpeg.exe'),
        os.path.join(project_root, 'bin', 'ffmpeg.exe'),
        os.path.join(project_root, 'FFmpeg', 'bin', 'ffmpeg.exe'),
        r'C:\ffmpeg\bin\ffmpeg.exe',
        r'C:\bin\ffmpeg.exe',
    ]
    for path in win_candidates:
        if os.path.isfile(path):
            return path
    try:
        if sys.platform == 'win32':
            result = subprocess.run(['where', 'ffmpeg'], capture_output=True, text=True, timeout=5)
        else:
            result = subprocess.run(['which', 'ffmpeg'], capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            return result.stdout.strip().split('\n')[0]
    except Exception:
        pass
    return 'ffmpeg'


def _get_media_duration(file_path: str) -> float:
    """Get duration of a media file in seconds using ffmpeg (no ffprobe needed)."""
    if not file_path or not os.path.isfile(file_path):
        return 0.0
    try:
        ffmpeg_path = _find_ffmpeg()
        result = subprocess.run(
            [ffmpeg_path, '-i', file_path, '-f', 'null', '-'],
            capture_output=True, text=True, timeout=30
        )
        # Parse Duration line from stderr: "  Duration: 00:00:47.71, start: ..."
        for line in result.stderr.split('\n'):
            if 'Duration' in line and 'N/A' not in line:
                # Extract time portion: HH:MM:SS.mm
                dur_str = line.split('Duration:')[1].split(',')[0].strip()
                parts = dur_str.split(':')
                if len(parts) == 3:
                    hours = float(parts[0])
                    minutes = float(parts[1])
                    seconds = float(parts[2])
                    return hours * 3600 + minutes * 60 + seconds
        return 0.0
    except Exception:
        return 0.0


# ──────────────────────────────────────────────
# Main Generation Pipeline
# ──────────────────────────────────────────────

def generate_stickman_story(params: dict) -> dict:
    """
    Generate a stickman story video from scene descriptions.

    Each scene becomes ONE static image with:
      - AI-generated scene background (segmind/tiny-sd)
      - Stickman character composited in as the protagonist
      - Caption text

    All scene images are assembled into a video with audio using ffmpeg.
    """
    scenes = params.get('scenes', [])
    audio_path = params.get('audio_path', '')
    output_filename = params.get('output_filename', 'stickman_story.mp4')
    resolution_str = params.get('resolution', '1080x1920')
    caption_position = params.get('caption_position', 'bottom')
    caption_bg_color = params.get('caption_background_color', 'black')

    # Parse resolution
    try:
        res_parts = resolution_str.split('x')
        resolution = (int(res_parts[0]), int(res_parts[1]))
    except (ValueError, IndexError):
        resolution = DEFAULT_RESOLUTION

    if not scenes:
        return {
            'success': False,
            'error': 'No scenes provided for stickman story',
            'fallback': True,
        }

    # Get audio duration
    audio_duration = _get_media_duration(audio_path)
    if audio_duration <= 0:
        print('[stickman_story] No valid audio, estimating from word count', file=sys.stderr)
        total_words = sum(len(s.get('text', '').split()) for s in scenes)
        audio_duration = total_words / TARGET_WORDS_PER_SECOND
        if audio_duration <= 0:
            audio_duration = 15  # minimum fallback

    print(f'[stickman_story] Generating {len(scenes)} scenes, audio_duration={audio_duration:.1f}s', file=sys.stderr)

    # Calculate per-scene durations from word count proportion
    scene_texts = [s.get('text', '') for s in scenes]
    total_words = max(len(' '.join(scene_texts).split()), 1)

    # Create temp directory for scene images
    scene_dir = tempfile.mkdtemp(prefix='stickman_scenes_')

    try:
        scene_image_paths = []

        for i, scene in enumerate(scenes):
            text = scene.get('text', '')
            search_terms = scene.get('searchTerms', scene.get('search_terms', []))
            if isinstance(search_terms, str):
                search_terms = [search_terms]

            scene_word_count = max(len(text.split()), 1)
            scene_duration = (scene_word_count / total_words) * audio_duration

            print(f'[stickman_story] Scene {i+1}: generating scene image...', file=sys.stderr)

            # Generate ONE static scene image (AI background + stickman + caption)
            scene_img = _generate_scene_image(
                scene_text=text,
                search_terms=search_terms,
                resolution=resolution,
                caption_position=caption_position,
                caption_bg_color=caption_bg_color,
                scene_index=i + 1,
            )

            # Save as PNG
            scene_image_path = os.path.join(scene_dir, f'scene_{i+1:03d}.png')
            # Convert to RGB for video compatibility
            if scene_img.mode == 'RGBA':
                scene_img = scene_img.convert('RGB')
            scene_img.save(scene_image_path, 'PNG')
            scene_image_paths.append(scene_image_path)

            print(f'[stickman_story] Scene {i+1}: saved to {scene_image_path} '
                  f'({scene_duration:.1f}s, {os.path.getsize(scene_image_path) / 1024:.0f}KB)',
                  file=sys.stderr)

        if len(scene_image_paths) == 0:
            return {
                'success': False,
                'error': 'No scene images were generated',
                'fallback': True,
            }

        print(f'[stickman_story] Generated {len(scene_image_paths)} scene images', file=sys.stderr)

        # ── Assemble video using ffmpeg concat demuxer ──
        output_dir = os.path.dirname(output_filename) if os.path.sep in output_filename else os.getcwd()
        os.makedirs(output_dir, exist_ok=True)

        output_path = output_filename
        if not os.path.isabs(output_path):
            output_path = os.path.join(os.getcwd(), output_path)

        ffmpeg_path = _find_ffmpeg()

        # Create concat file: each scene displayed for its calculated duration
        # IMPORTANT: On Windows, use forward slashes in concat file paths!
        concat_lines = ['ffconcat version 1.0']
        for i, scene in enumerate(scenes):
            text = scene.get('text', '')
            scene_word_count = max(len(text.split()), 1)
            scene_duration = (scene_word_count / total_words) * audio_duration
            scene_duration = max(scene_duration, 2.0)  # minimum 2 seconds per scene

            # Use forward slashes for cross-platform compatibility
            img_path = scene_image_paths[i].replace('\\', '/')
            concat_lines.append(f"file '{img_path}'")
            concat_lines.append(f"duration {scene_duration:.3f}")

        # For the last frame, ffmpeg concat requires the last image to appear twice
        # (once with duration, once without, to avoid dropping the last frame)
        last_img = scene_image_paths[-1].replace('\\', '/')
        concat_lines.append(f"file '{last_img}'")

        concat_file = os.path.join(scene_dir, 'concat.txt')
        with open(concat_file, 'w', encoding='utf-8') as f:
            f.write('\n'.join(concat_lines))

        print(f'[stickman_story] Assembling video with ffmpeg...', file=sys.stderr)
        sys.stderr.flush()

        # Build ffmpeg command — use image2 pipe approach for reliability on Windows
        # Instead of concat demuxer (which has path escaping issues on Windows),
        # build the video frame-by-frame using the image2 muxer with per-frame duration
        has_audio = audio_path and os.path.isfile(audio_path)

        # Generate a video from PNG images using the concat demuxer with proper paths
        cmd = [
            ffmpeg_path, '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', concat_file,
        ]

        if has_audio:
            cmd.extend(['-i', audio_path])
            cmd.extend(['-c:a', 'aac', '-copyts'])
        else:
            cmd.extend(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-c:a', 'aac', '-copyts'])

        cmd.extend([
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-preset', 'medium',
            '-crf', '23',
            '-r', '30',
            '-movflags', '+faststart',
            '-shortest',
            output_path,
        ])

        print(f'[stickman_story] Running ffmpeg...', file=sys.stderr)
        sys.stderr.flush()

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            if result.returncode != 0:
                print(f'[stickman_story] ffmpeg error (will retry): {result.stderr[:400]}', file=sys.stderr)
                sys.stderr.flush()
                # Retry with image2 approach as fallback
                print(f'[stickman_story] Retrying with image2 pipe...', file=sys.stderr)
                sys.stderr.flush()
                cmd_v2 = [
                    ffmpeg_path, '-y',
                    '-f', 'image2',
                    '-framerate', '30',
                    '-pattern_type', 'sequence',
                    '-i', os.path.join(scene_dir, 'scene_%03d.png').replace('\\', '/'),
                ]
                if has_audio:
                    cmd_v2.extend(['-i', audio_path])
                    cmd_v2.extend(['-c:a', 'aac'])
                else:
                    cmd_v2.extend(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-c:a', 'aac'])
                cmd_v2.extend([
                    '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p',
                    '-preset', 'medium',
                    '-crf', '23',
                    '-r', '30',
                    '-movflags', '+faststart',
                    '-shortest',
                    output_path,
                ])
                result = subprocess.run(cmd_v2, capture_output=True, text=True, timeout=600)
                if result.returncode != 0:
                    print(f'[stickman_story] image2 fallback also failed: {result.stderr[:300]}', file=sys.stderr)
                    sys.stderr.flush()
                    return {
                        'success': False,
                        'error': f'Video assembly failed: {result.stderr[:300]}',
                        'fallback': True,
                    }
        except subprocess.TimeoutExpired:
            return {
                'success': False,
                'error': 'Video assembly timed out (600s)',
                'fallback': True,
            }

        if not os.path.exists(output_path):
            return {
                'success': False,
                'error': 'ffmpeg did not produce output file',
                'fallback': True,
            }

        actual_duration = _get_media_duration(output_path)
        file_size = os.path.getsize(output_path)

        print(f'[stickman_story] Video complete: {output_path} '
              f'({file_size / 1024:.0f}KB, {actual_duration:.1f}s)',
              file=sys.stderr)

        return {
            'success': True,
            'file_path': output_path,
            'filename': os.path.basename(output_path),
            'duration_seconds': actual_duration,
            'file_size_bytes': file_size,
            'resolution': resolution_str,
            'fps': 30,
            'subtitles': True,
            'fallback': False,
        }

    finally:
        # Clean up scene directory
        try:
            shutil.rmtree(scene_dir)
        except Exception:
            pass


# ──────────────────────────────────────────────
# Entry Point
# ──────────────────────────────────────────────

def main():
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, IndexError):
        print(json.dumps({'success': False, 'error': 'Invalid JSON input'}))
        return

    action = input_data.get('action', 'stickman_story')

    if action == 'stickman_story':
        result = generate_stickman_story(input_data)
        print(json.dumps(result))
    elif action == 'status':
        ai_status = DIFFUSION_AVAILABLE
        if ai_status:
            pipe = _get_pipeline()
            ai_status = pipe is not None
        print(json.dumps({
            'available': True,
            'description': 'AI stickman story generator (segmind/tiny-sd + Pillow + ffmpeg)',
            'dependencies': {
                'Pillow': True,
                'torch': True,
                'diffusers': DIFFUSION_AVAILABLE,
                'tiny_sd': ai_status,
                'ffmpeg': os.path.exists(_find_ffmpeg()) if _find_ffmpeg() != 'ffmpeg' else True,
            },
        }))
    else:
        print(json.dumps({'success': False, 'error': f'Unknown action: {action}'}))


if __name__ == '__main__':
    main()
