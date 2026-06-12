#!/usr/bin/env python3
"""Analyze video output."""
import subprocess, json, os

v = r"C:\Users\Admin\Desktop\youtubeauto\quick_test.mp4"
r = subprocess.run(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", v], capture_output=True, text=True, timeout=10)
info = json.loads(r.stdout)
for s in info["streams"]:
    if s["codec_type"] == "video":
        print(f"Video: {s['codec_name']}, {s['width']}x{s['height']}, {s.get('r_frame_rate','?')}fps")
    elif s["codec_type"] == "audio":
        print(f"Audio: {s['codec_name']}, {s.get('sample_rate','?')}Hz")

r2 = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=key_frame,pict_type", "-of", "csv=p=0", v], capture_output=True, text=True, timeout=10)
print(f"Keyframes: {r2.stdout.strip()[:200]}")
print(f"Size: {os.path.getsize(v)} bytes")
