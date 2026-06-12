"""
Caption images using Florence-2-large for high-quality LoRA training data.
Far better than BLIP — produces detailed, descriptive captions with scene
understanding, object recognition, and compositional awareness.

Features:
    - Florence-2-large with FP16, fits on RTX 3060 6GB (~3-4GB VRAM)
    - Resume support: pick up where you left off if interrupted
    - Periodic checkpoint saves every N images
    - CUDA cache clearing every 50 images to prevent memory fragmentation
    - Outputs both captions.json (filename→caption) and metadata.json
      (array format for train_stickman_lora_v2.py)
    - Automatic trigger word prepending ("stmn")
    - Error handling per-image — one bad image won't ruin the batch

Usage:
    # Caption the synthetic training data (150 images)
    python florence2_caption.py --input python/training_data

    # Caption new frames extracted from video (2000+ images)
    python florence2_caption.py --input "FOR TRAINING" --output "FOR TRAINING"

    # Custom options
    python florence2_caption.py --input frames/ --output frames/ \\
        --batch_size 2 --model microsoft/Florence-2-base \\
        --prompt "<DETAILED_CAPTION>" --max_new_tokens 256

Dependencies (all already installed):
    pip install transformers torch pillow tqdm
"""

import argparse
import gc
import json
import os
import sys
import time
from pathlib import Path

import torch
from PIL import Image
from tqdm import tqdm
from transformers import AutoProcessor, AutoModelForCausalLM


def main():
    parser = argparse.ArgumentParser(
        description="Caption images with Florence-2 for LoRA training data"
    )
    parser.add_argument(
        "--input", default="python/training_data",
        help="Directory containing images to caption"
    )
    parser.add_argument(
        "--output", default=None,
        help="Output directory for caption files (defaults to input dir)"
    )
    parser.add_argument(
        "--model", default="microsoft/Florence-2-large",
        help="Florence-2 model variant (base or large)"
    )
    parser.add_argument(
        "--prompt", default="<MORE_DETAILED_CAPTION>",
        help=(
            "Task prompt: <CAPTION> (short), <DETAILED_CAPTION> (medium), "
            "or <MORE_DETAILED_CAPTION> (long, detailed)"
        )
    )
    parser.add_argument(
        "--batch_size", type=int, default=1,
        help="Batch size — keep at 1 for RTX 3060 6GB with -large"
    )
    parser.add_argument(
        "--max_new_tokens", type=int, default=512,
        help="Maximum tokens per generated caption"
    )
    parser.add_argument(
        "--num_beams", type=int, default=3,
        help="Beam search width (3 = good quality, 5 = better but slower)"
    )
    parser.add_argument(
        "--save_every", type=int, default=100,
        help="Save checkpoint every N images"
    )
    parser.add_argument(
        "--add_trigger", default="stmn",
        help=(
            "Trigger word to prepend to each caption (empty string = none). "
            "The training script expects 'stmn' prepended."
        )
    )
    args = parser.parse_args()

    input_dir = Path(args.input).resolve()
    output_dir = Path(args.output).resolve() if args.output else input_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    # ── Collect images ──
    image_paths = sorted([
        p for p in input_dir.iterdir()
        if p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp', '.bmp')
    ])
    if not image_paths:
        # Try rglob if no files directly in the directory
        image_paths = sorted([
            p for p in input_dir.rglob("*")
            if p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp', '.bmp')
        ])
    if not image_paths:
        print(f"❌ No image files found in {input_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"📸 Found {len(image_paths)} images in {input_dir}", file=sys.stderr)

    # ── GPU check ──
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type == "cuda":
        free_v, total_v = torch.cuda.mem_get_info()
        print(f"🖥️  GPU: {torch.cuda.get_device_name(0)}", file=sys.stderr)
        print(f"📊 VRAM: {free_v/1e9:.1f}GB free / {total_v/1e9:.1f}GB total", file=sys.stderr)
    else:
        print("⚠️  CUDA not available — running on CPU (extremely slow!)", file=sys.stderr)
        print("   Install PyTorch with CUDA: pip install torch --index-url https://download.pytorch.org/whl/cu124", file=sys.stderr)

    # ── Load model ──
    print(f"🔧 Loading {args.model}...", file=sys.stderr)
    try:
        model = AutoModelForCausalLM.from_pretrained(
            args.model,
            torch_dtype=torch.float16,
            trust_remote_code=True,
        ).to(device)
        processor = AutoProcessor.from_pretrained(
            args.model,
            trust_remote_code=True,
        )
    except Exception as e:
        print(f"❌ Failed to load model: {e}", file=sys.stderr)
        print("   Try: pip install transformers --upgrade", file=sys.stderr)
        sys.exit(1)

    model.eval()
    print(f"✅ Model loaded on {device}", file=sys.stderr)

    if device.type == "cuda":
        free_v, total_v = torch.cuda.mem_get_info()
        print(f"📊 After model load: {free_v/1e9:.1f}GB VRAM free", file=sys.stderr)

    # ── Resume: load existing captions ──
    captions_path = output_dir / "captions.json"
    existing_captions = {}
    if captions_path.exists():
        try:
            with open(captions_path, encoding="utf-8") as f:
                existing_captions = json.load(f)
            print(f"🔄 Resuming: {len(existing_captions)} images already captioned", file=sys.stderr)
        except (json.JSONDecodeError, Exception) as e:
            print(f"⚠️  Could not load existing captions.json: {e}", file=sys.stderr)
            print("   Starting fresh.", file=sys.stderr)

    # Filter out already-captioned images
    todo = []
    for p in image_paths:
        rel = _relative_name(input_dir, p)
        if rel in existing_captions and existing_captions[rel].strip():
            continue
        todo.append(p)

    print(
        f"🎯 {len(todo)} remaining to caption "
        f"({len(image_paths) - len(todo)} already done)",
        file=sys.stderr
    )
    if not todo:
        print("✅ All images already captioned!", file=sys.stderr)
        _save_outputs(output_dir, existing_captions, args.add_trigger, input_dir, image_paths)
        return

    # ── Generate captions ──
    captions = dict(existing_captions)
    task_prompt = args.prompt

    start_time = time.time()
    interrupted = False
    try:
        for idx, fp in enumerate(tqdm(todo, desc="Florence-2 captioning", file=sys.stderr)):
            rel = _relative_name(input_dir, fp)
            try:
                image = Image.open(fp).convert("RGB")

                inputs = processor(
                    text=task_prompt,
                    images=image,
                    return_tensors="pt",
                )
                # Move pixel_values to device with model dtype (fp16).
                # Keep input_ids as Long — embedding layer requires integer indices.
                for k, v in inputs.items():
                    if isinstance(v, torch.Tensor):
                        if k == "pixel_values":
                            inputs[k] = v.to(device, dtype=model.dtype)
                        else:
                            inputs[k] = v.to(device)

                with torch.no_grad():
                    generated_ids = model.generate(
                        **inputs,
                        max_new_tokens=args.max_new_tokens,
                        num_beams=args.num_beams,
                        do_sample=False,
                    )

                generated_text = processor.batch_decode(
                    generated_ids, skip_special_tokens=True
                )[0]

                # Florence-2 echoes the task prompt in the output — strip it
                caption = generated_text
                if caption.startswith(task_prompt):
                    caption = caption[len(task_prompt):].strip()
                # Also strip any trailing task prompt repetition
                if task_prompt in caption:
                    caption = caption.split(task_prompt)[0].strip()

                # Clean up whitespace
                caption = " ".join(caption.split())
                captions[rel] = caption

            except Exception as e:
                print(f"\n⚠️  Error captioning {rel}: {e}", file=sys.stderr)
                # Don't embed trigger word in fallback — _save_outputs prepends it
                fallback = "a simple stickman scene"
                captions[rel] = fallback

            # Periodic checkpoint save
            if (idx + 1) % args.save_every == 0:
                _save_checkpoint(captions, captions_path, idx + 1, len(todo), start_time)

            # Clear CUDA cache every 50 images to prevent fragmentation
            if (idx + 1) % 50 == 0 and device.type == "cuda":
                torch.cuda.empty_cache()
                gc.collect()

    except KeyboardInterrupt:
        print("\n⏹️  Interrupted by user — saving progress...", file=sys.stderr)
        interrupted = True
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}", file=sys.stderr)
        interrupted = True

    # ── Final save & summary ──
    done_count = len(captions) - len(existing_captions)
    _save_checkpoint(captions, captions_path, done_count, len(todo), start_time)
    _save_outputs(output_dir, captions, args.add_trigger, input_dir, image_paths)

    elapsed = time.time() - start_time
    rate = done_count / elapsed if elapsed > 0 and done_count > 0 else 0
    print(f"\n{'='*50}", file=sys.stderr)
    if interrupted:
        status = "⏹️  Interrupted"
    else:
        status = "✅ Complete"
    print(f"{status}: {len(captions)} total captions", file=sys.stderr)
    new_count = len(captions) - len(existing_captions)
    if new_count > 0:
        print(f"   {new_count} new, {len(existing_captions)} resumed", file=sys.stderr)
        print(f"   Time: {elapsed:.0f}s ({rate:.2f} img/s)", file=sys.stderr)
    print(f"📄 Output: {captions_path}", file=sys.stderr)
    print(f"📄 Output: {output_dir / 'metadata.json'}", file=sys.stderr)
    print(f"{'='*50}", file=sys.stderr)


def _relative_name(input_dir: Path, fp: Path) -> str:
    """Get relative path for use as key in captions dict."""
    try:
        return str(fp.relative_to(input_dir)).replace("\\", "/")
    except ValueError:
        return fp.name


def _save_checkpoint(captions: dict, captions_path: Path, done: int, total: int, start: float):
    """Save intermediate checkpoint to disk."""
    with open(captions_path, "w", encoding="utf-8") as f:
        json.dump(captions, f, indent=2, ensure_ascii=False)
    elapsed = time.time() - start
    rate = done / elapsed if elapsed > 0 else 0
    remaining = total - done
    eta = remaining / rate if rate > 0 else 0
    print(
        f"\n💾 Checkpoint saved: {done}/{total} ({rate:.2f} img/s, "
        f"ETA: {eta:.0f}s ≈ {eta/60:.1f}min)",
        file=sys.stderr
    )


def _save_outputs(
    output_dir: Path,
    captions: dict,
    trigger_word: str,
    input_dir: Path,
    image_paths: list,
):
    """
    Save both captions.json (filename→caption mapping) and metadata.json
    (array format expected by train_stickman_lora_v2.py).
    """
    # ── captions.json: filename → caption ──
    captions_path = output_dir / "captions.json"
    # Sort by key for determinism
    sorted_captions = dict(sorted(captions.items()))
    with open(captions_path, "w", encoding="utf-8") as f:
        json.dump(sorted_captions, f, indent=2, ensure_ascii=False)
    print(f"📄 Wrote {captions_path} ({len(sorted_captions)} captions)", file=sys.stderr)

    # ── metadata.json: array format for training script ──
    # Must match sorted images by filename
    captions_list = []
    for p in image_paths:
        rel = _relative_name(input_dir, p)
        cap = captions.get(rel, "")
        if cap and trigger_word and not cap.lower().startswith(trigger_word.lower()):
            cap = f"{trigger_word} {cap}"
        elif not cap:
            cap = f"{trigger_word} a simple stickman scene" if trigger_word else "a simple stickman scene"
        captions_list.append(cap)

    metadata = {
        "num_images": len(image_paths),
        "trigger_word": trigger_word,
        "source": f"Florence-2-large ({len(captions)} captions)",
        "captions": captions_list,
    }
    meta_path = output_dir / "metadata.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)
    print(f"📄 Wrote {meta_path} ({len(captions_list)} captions in array format)", file=sys.stderr)


if __name__ == "__main__":
    main()
