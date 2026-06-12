#!/usr/bin/env python3
"""Check if ToonYou is available on HuggingFace."""
from huggingface_hub import model_info, snapshot_download, hf_hub_download
import os, sys

try:
    info = model_info("Yntec/ToonYou")
    print(f"ToonYou found: {info.id}")
    safetensors = [s.rfilename for s in info.siblings if s.rfilename.endswith(".safetensors")]
    for s in safetensors:
        print(f"  {s}")
except Exception as e:
    print(f"ToonYou not on HF: {e}")

# Check checkpoint_downloaded folder
ckpt_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "checkpoints")
os.makedirs(ckpt_dir, exist_ok=True)
existing = [f for f in os.listdir(ckpt_dir) if f.endswith(".safetensors")]
if existing:
    for f in existing:
        size = os.path.getsize(os.path.join(ckpt_dir, f))
        print(f"Local: {f} ({size/1e6:.0f}MB)")
else:
    print("No local checkpoints found")
