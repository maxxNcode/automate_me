"""
Generate BLIP captions for all extracted frames.
Saves a captions.json mapping filename -> caption.
"""
import json, os, sys
from pathlib import Path
from PIL import Image
import torch
from tqdm import tqdm
from transformers import BlipProcessor, BlipForConditionalGeneration

FRAMES_DIR = "training_data/frames"
OUTPUT = "training_data/captions.json"

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"[blip] Loading BLIP model on {device}...", file=sys.stderr)

processor = BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-base")
model = BlipForConditionalGeneration.from_pretrained(
    "Salesforce/blip-image-captioning-base"
).to(device)

image_paths = sorted([
    p for p in Path(FRAMES_DIR).rglob("*")
    if p.suffix.lower() in ('.png', '.jpg', '.jpeg')
])
print(f"[blip] Captioning {len(image_paths)} images...", file=sys.stderr)

captions = {}
for fp in tqdm(image_paths, desc="BLIP captioning", file=sys.stderr):
    rel = str(fp.relative_to(FRAMES_DIR)).replace("\\", "/")
    try:
        image = Image.open(fp).convert("RGB")
        inputs = processor(image, return_tensors="pt").to(device)
        out = model.generate(**inputs, max_length=30)
        caption = processor.decode(out[0], skip_special_tokens=True)
        captions[rel] = caption
    except Exception as e:
        print(f"[blip] Error on {fp}: {e}", file=sys.stderr)
        captions[rel] = "a stick figure scene"
    torch.cuda.empty_cache()

os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
with open(OUTPUT, "w") as f:
    json.dump(captions, f, indent=2)

print(f"[blip] Saved {len(captions)} captions to {OUTPUT}", file=sys.stderr)
