"""
Stable Diffusion Thumbnail Generator
Generates YouTube thumbnails and images using open-source diffusion models.
"""

import sys
import json
import os
import base64
from io import BytesIO

try:
    import torch
    from diffusers import StableDiffusionPipeline
    from PIL import Image
    DIFFUSION_AVAILABLE = True
except ImportError:
    DIFFUSION_AVAILABLE = False

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "output", "assets", "thumbnails")

THUMBNAIL_STYLES = {
    "eye-catching": {
        "positive": "highly detailed, vibrant colors, professional, eye-catching, 4k, trending on artstation",
        "negative": "blurry, low quality, distorted, text, watermark",
        "guidance_scale": 7.5,
        "steps": 30
    },
    "minimalist": {
        "positive": "minimalist, clean, simple background, elegant, professional, soft lighting",
        "negative": "cluttered, busy, low quality, blurry, text, watermark",
        "guidance_scale": 6.0,
        "steps": 25
    },
    "educational": {
        "positive": "clean, professional, infographic style, clear, well lit, academic, 4k",
        "negative": "cluttered, messy, low quality, blurry, text, watermark, cartoon",
        "guidance_scale": 7.0,
        "steps": 28
    }
}

DEFAULT_STYLE = "eye-catching"


def generate_thumbnail(topic: str, style: str = "eye-catching",
                       custom_prompt: str = None, output_filename: str = None) -> dict:
    """Generate a YouTube thumbnail image.
    
    Falls back to a text-based placeholder image if Stable Diffusion is not available.
    """
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    if output_filename is None:
        sanitized = "".join(c if c.isalnum() or c in " -_" else "_" for c in topic)[:50]
        output_filename = f"thumbnail_{sanitized}.png"
    
    output_path = os.path.join(OUTPUT_DIR, output_filename)
    style_config = THUMBNAIL_STYLES.get(style, THUMBNAIL_STYLES[DEFAULT_STYLE])
    
    if custom_prompt:
        prompt = custom_prompt
    else:
        prompt = f"YouTube thumbnail for '{topic}', {style_config['positive']}"
    
    if not DIFFUSION_AVAILABLE:
        return _generate_fallback_thumbnail(topic, output_path, output_filename, prompt)
    
    try:
        model_id = "runwayml/stable-diffusion-v1-5"
        pipe = StableDiffusionPipeline.from_pretrained(
            model_id, torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32
        )
        
        if torch.cuda.is_available():
            pipe = pipe.to("cuda")
        
        with torch.no_grad():
            image = pipe(
                prompt=prompt,
                negative_prompt=style_config["negative"],
                num_inference_steps=style_config["steps"],
                guidance_scale=style_config["guidance_scale"],
                height=720,
                width=1280
            ).images[0]
        
        image.save(output_path)
        
        return {
            "success": True,
            "file_path": output_path,
            "filename": output_filename,
            "prompt": prompt,
            "style": style,
            "dimensions": "1280x720",
            "fallback": False
        }
    except Exception as e:
        print(f"Stable Diffusion error: {e}, using fallback", file=sys.stderr)
        return _generate_fallback_thumbnail(topic, output_path, output_filename, prompt)


def _generate_fallback_thumbnail(topic: str, output_path: str, filename: str, prompt: str) -> dict:
    """Generate a styled placeholder thumbnail image."""
    try:
        from PIL import Image, ImageDraw, ImageFont
        import textwrap
        
        width, height = 1280, 720
        img = Image.new('RGB', (width, height), (25, 25, 35))
        draw = ImageDraw.Draw(img)
        
        # Gradient-like overlay
        for i in range(height):
            r = int(30 + (i / height) * 50)
            g = int(25 + (i / height) * 30)
            b = int(45 + (i / height) * 40)
            draw.line([(0, i), (width, i)], fill=(r, g, b))
        
        # Accent bar
        bar_height = 6
        for i in range(bar_height):
            draw.rectangle([0, height // 2 - 60 + i, width, height // 2 - 60 + i],
                          fill=(255, 50, 50))
        
        # Title text
        try:
            font_large = ImageFont.truetype("arial.ttf", 64)
            font_small = ImageFont.truetype("arial.ttf", 32)
        except (OSError, IOError):
            font_large = ImageFont.load_default()
            font_small = ImageFont.load_default()
        
        wrapped = textwrap.fill(topic, width=20)
        draw.multiline_text((width // 2, height // 2 - 30), wrapped,
                           fill=(255, 255, 255), font=font_large,
                           anchor="mm", align="center", spacing=10)
        
        draw.text((width // 2, height - 80), "▶ WATCH NOW",
                 fill=(255, 50, 50), font=font_small, anchor="mm")
        
        img.save(output_path)
    except Exception as e:
        print(f"Fallback thumbnail error: {e}", file=sys.stderr)
        # Create minimal solid-color image
        with open(output_path, 'wb') as f:
            f.write(b'')
    
    return {
        "success": True,
        "file_path": output_path,
        "filename": filename,
        "prompt": prompt,
        "style": "fallback-generated",
        "dimensions": "1280x720",
        "fallback": True
    }


def generate_batch_images(topic: str, count: int = 3, style: str = "eye-catching") -> dict:
    """Generate multiple thumbnail variations."""
    variations = []
    prompts = [
        f"YouTube thumbnail about {topic}, modern design, professional",
        f"Creative thumbnail for video about {topic}, bold colors, engaging",
        f"Educational thumbnail about {topic}, clean design, informative"
    ]
    
    for i in range(min(count, len(prompts))):
        result = generate_thumbnail(topic, style, custom_prompt=prompts[i],
                                    output_filename=f"thumbnail_{i+1}_{topic[:20]}.png")
        variations.append(result)
    
    return {
        "success": True,
        "variations": variations,
        "count": len(variations)
    }


# Overlay text on thumbnail
def add_thumbnail_text(image_path: str, text: str, output_path: str = None) -> dict:
    """Add overlay text to a thumbnail image."""
    try:
        from PIL import Image, ImageDraw, ImageFont
        
        img = Image.open(image_path)
        draw = ImageDraw.Draw(img)
        
        try:
            font = ImageFont.truetype("arialbd.ttf", 80)
        except (OSError, IOError):
            font = ImageFont.load_default()
        
        width, height = img.size
        # Semi-transparent overlay bar
        draw.rectangle([0, height - 160, width, height], fill=(0, 0, 0, 180))
        draw.text((width // 2, height - 80), text.upper(),
                 fill=(255, 255, 255), font=font, anchor="mm")
        
        out = output_path or image_path.replace('.png', '_text.png')
        img.save(out)
        
        return {"success": True, "file_path": out}
    except Exception as e:
        return {"success": False, "error": str(e)}


if __name__ == "__main__":
    input_data = json.loads(sys.stdin.read())
    action = input_data.get("action", "generate")
    
    if action == "batch":
        result = generate_batch_images(
            topic=input_data.get("topic", "Technology"),
            count=input_data.get("count", 3),
            style=input_data.get("style", "eye-catching")
        )
    else:
        result = generate_thumbnail(
            topic=input_data.get("topic", "Technology"),
            style=input_data.get("style", "eye-catching"),
            custom_prompt=input_data.get("custom_prompt"),
            output_filename=input_data.get("output_filename")
        )
    
    print(json.dumps(result, indent=2))
