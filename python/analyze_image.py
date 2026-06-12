#!/usr/bin/env python3
"""Analyze ToonYou images for quality and text artifacts."""
import os
from PIL import Image

test_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_outputs")
for fname in sorted(os.listdir(test_dir)):
    if not fname.endswith(".png"):
        continue
    if not fname.startswith("toonyou"):
        continue
    
    path = os.path.join(test_dir, fname)
    img = Image.open(path).convert("RGB")
    pixels = list(img.getdata())
    
    # Count unique colors
    unique_colors = len(set(pixels))
    
    # Count "dark outline" pixels (pure black or near-black)
    dark_threshold = 50
    dark_pixels = sum(1 for r, g, b in pixels if r < dark_threshold and g < dark_threshold and b < dark_threshold)
    dark_pct = dark_pixels / len(pixels) * 100
    
    # Count "pure white" background pixels
    white_pixels = sum(1 for r, g, b in pixels if r > 240 and g > 240 and b > 240)
    white_pct = white_pixels / len(pixels) * 100
    
    # Check for high-frequency texture (text-like artifacts)
    # Sample a region to check for small dark-on-light patterns
    w, h = img.size
    # Sample center region for text-like patterns
    center = img.crop((w//4, h//4, 3*w//4, 3*h//4))
    cpixels = list(center.getdata())
    # Count isolated dark pixels with light neighbors (characteristic of text)
    text_like = 0
    for i, (r, g, b) in enumerate(cpixels):
        if r < 100 and g < 100 and b < 100:  # dark pixel
            # Check if surrounded by light pixels
            if i > 0 and i < len(cpixels) - 1:
                nr, ng, nb = cpixels[i-1]
                if nr > 200 and ng > 200 and nb > 200:
                    text_like += 1
    
    print(f"{fname}:")
    print(f"  Size: {img.size}")
    print(f"  File size: {os.path.getsize(path)/1024:.0f}KB")
    print(f"  Unique colors: {unique_colors}")
    print(f"  Dark outline pixels: {dark_pct:.1f}%")
    print(f"  White/bg pixels: {white_pct:.1f}%")
    print(f"  Text-like patterns: {text_like} (in center crop)")
    print()

# Also check the Counterfeit comparison from earlier
print("=== Comparison ===")
print("  Counterfeit-V2.5: ~95K colors, ~22% dark outline")
print("  SD 1.5 base: ~23K colors, ~4% dark outline")
print("  ToonYou: (see above)")
