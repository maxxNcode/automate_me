"""
Batch Pre-generate All Kokoro Voice Previews
Generates all 19 American English voice previews in a single Python process
so the model only loads once. Previews are cached to disk for instant playback.
"""
import sys
import json
import os
import warnings
from importlib import import_module

# Suppress warnings during import
os.environ['HF_HUB_DISABLE_WARNINGS'] = '1'
warnings.filterwarnings('ignore')

# Import the kokoro generator
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kokoro_tts import generate_kokoro

# Output directory for cached previews
PREVIEW_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    '..', 'output', 'assets', 'voice_previews'
)

# All 19 American English voices
AMERICAN_ENGLISH_VOICES = [
    'af_heart', 'af_bella', 'af_sarah', 'af_nicole', 'af_sky',
    'af_river', 'af_nova', 'af_alloy', 'af_jessica', 'af_kore',
    'am_adam', 'am_michael', 'am_liam', 'am_echo', 'am_eric',
    'am_onyx', 'am_fenrir', 'am_puck', 'am_santa',
]

# A meaningful preview sentence that showcases each voice's character
PREVIEW_TEXT = (
    "Under the vast canopy of the night sky, a single star began to pulse "
    "with a light unseen for centuries. It carried a message from a world "
    "beyond our own — a whisper of hope across the endless void."
)

if __name__ == "__main__":
    os.makedirs(PREVIEW_DIR, exist_ok=True)

    results = {}
    for voice in AMERICAN_ENGLISH_VOICES:
        filename = f"preview_{voice}.wav"
        filepath = os.path.join(PREVIEW_DIR, filename)

        # Skip if already cached
        if os.path.exists(filepath) and os.path.getsize(filepath) > 1000:
            results[voice] = {
                "success": True,
                "cached": True,
                "file_path": filepath,
            }
            print(f"[PREVIEW] {voice} — already cached, skipping", file=sys.stderr)
            continue

        try:
            result = generate_kokoro(
                script=PREVIEW_TEXT,
                voice=voice,
                speed=1.0,
                output_filename=filename,
            )

            if result.get("success") and result.get("file_path"):
                # Copy/move to the previews directory if the file is elsewhere
                src = result["file_path"]
                if os.path.dirname(src) != PREVIEW_DIR:
                    import shutil
                    shutil.copy2(src, filepath)
                    # Clean up the original temp file
                    try:
                        os.remove(src)
                    except Exception:
                        pass

                results[voice] = {
                    "success": True,
                    "cached": False,
                    "file_path": filepath,
                    "duration": result.get("duration_seconds", 0),
                    "voice_model": result.get("voice_model", voice),
                }
                print(f"[PREVIEW] {voice} — generated ({result.get('duration_seconds', 0):.1f}s)", file=sys.stderr)
            else:
                results[voice] = {
                    "success": False,
                    "error": "Generation returned no file_path",
                }
                print(f"[PREVIEW] {voice} — FAILED", file=sys.stderr)

        except Exception as e:
            results[voice] = {
                "success": False,
                "error": str(e),
            }
            print(f"[PREVIEW] {voice} — ERROR: {e}", file=sys.stderr)

    # Print results as JSON to stdout for the server to parse
    print(json.dumps({
        "success": True,
        "total": len(AMERICAN_ENGLISH_VOICES),
        "generated": sum(1 for v in results.values() if v.get("success") and not v.get("cached")),
        "cached": sum(1 for v in results.values() if v.get("cached")),
        "failed": sum(1 for v in results.values() if not v.get("success")),
        "results": results,
    }, indent=2))
