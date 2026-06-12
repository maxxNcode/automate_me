"""
Kokoro TTS Voiceover Generator
Uses Kokoro-82M for natural speech. Falls back to edge-tts if unavailable.
"""

# Must be set before importing huggingface_hub to suppress repo_id warnings
import os
os.environ['HF_HUB_DISABLE_WARNINGS'] = '1'

import sys
import json
import re
import subprocess
import struct
import asyncio
import logging
import numpy as np

# Suppress HuggingFace/Hub warnings that would leak into stdout JSON output
logging.getLogger('huggingface_hub').setLevel(logging.ERROR)
logging.getLogger('kokoro').setLevel(logging.ERROR)
logging.getLogger('transformers').setLevel(logging.ERROR)

import warnings
# Catch-all: suppress Python warnings.warn() calls (PyTorch deprecations, etc.)
warnings.filterwarnings('ignore')

try:
    from kokoro import KPipeline
    import soundfile as sf
    import torch
    KOKORO_AVAILABLE = True
except ImportError:
    KOKORO_AVAILABLE = False

try:
    import edge_tts
    EDGE_TTS_AVAILABLE = True
except ImportError:
    EDGE_TTS_AVAILABLE = False

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "output", "assets", "audio")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def _get_ffmpeg_path() -> str:
    local_ffmpeg = os.path.join(SCRIPT_DIR, '..', 'ffmpeg_bin', 'ffmpeg.exe')
    if os.path.exists(local_ffmpeg):
        return local_ffmpeg
    return 'ffmpeg'


def _get_ffprobe_path() -> str:
    local_ffprobe = os.path.join(SCRIPT_DIR, '..', 'ffmpeg_bin', 'ffprobe.exe')
    if os.path.exists(local_ffprobe):
        return local_ffprobe
    return 'ffprobe'


def strip_visual_cues(script: str) -> str:
    cleaned = re.sub(r'\[VISUAL:[^\]]*\]', '', script)
    cleaned = re.sub(r'\[TIMESTAMP:[^\]]*\]', '', cleaned)
    cleaned = re.sub(r'\*\*', '', cleaned)
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    cleaned = re.sub(r'https?://\S+', '', cleaned)
    cleaned = re.sub(r'www\.\S+', '', cleaned)
    cleaned = re.sub(r'\b\w+:[/\\]\S+', '', cleaned)
    cleaned = re.sub(r'[/\\]{2,}', '/', cleaned)
    return cleaned.strip()


def generate_fallback_voiceover(script: str, output_path: str, filename: str) -> dict:
    """Fallback to edge-tts or silent audio."""
    if EDGE_TTS_AVAILABLE:
        try:
            cleaned = strip_visual_cues(script)
            mp3_path = output_path.replace('.wav', '_edge.mp3')

            async def _do_tts():
                communicate = edge_tts.Communicate(cleaned, "en-US-AriaNeural", rate="-5%", pitch="+5Hz")
                await communicate.save(mp3_path)

            asyncio.run(_do_tts())

            if os.path.exists(mp3_path):
                subprocess.run([
                    _get_ffmpeg_path(), "-y", "-i", mp3_path,
                    "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "1",
                    output_path
                ], capture_output=True, timeout=30)
                try:
                    os.remove(mp3_path)
                except Exception:
                    pass

                if os.path.exists(output_path):
                    duration = _get_audio_duration(output_path)
                    return {
                        "success": True,
                        "file_path": output_path,
                        "filename": filename,
                        "duration_seconds": duration,
                        "segments": 0,
                        "voice_model": "edge-tts:en-US-AriaNeural",
                        "fallback": True
                    }
        except Exception as e:
            print(f"Edge TTS fallback error: {e}", file=sys.stderr)
    
    # Silent fallback
    duration_seconds = max(len(script.split()) / 2.5, 5.0)
    try:
        ffmpeg = _get_ffmpeg_path()
        subprocess.run([
            ffmpeg, "-y", "-f", "lavfi", "-i",
            f"anullsrc=r=44100:cl=mono", "-t", str(duration_seconds),
            "-acodec", "pcm_s16le", output_path
        ], capture_output=True, timeout=30)
        if os.path.exists(output_path) and os.path.getsize(output_path) > 100:
            return {
                "success": True,
                "file_path": output_path,
                "filename": filename,
                "duration_seconds": duration_seconds,
                "segments": 1,
                "voice_model": "kokoro-fallback-silent",
                "fallback": True
            }
    except Exception:
        pass

    # Manual WAV generation as last resort
    try:
        sample_rate = 44100
        bytes_per_sample = 2
        num_samples = int(sample_rate * duration_seconds)
        data_size = num_samples * bytes_per_sample
        with open(output_path, 'wb') as f:
            f.write(b'RIFF')
            f.write(struct.pack('<I', 36 + data_size))
            f.write(b'WAVE')
            f.write(b'fmt ')
            f.write(struct.pack('<I', 16))
            f.write(struct.pack('<H', 1))
            f.write(struct.pack('<H', 1))
            f.write(struct.pack('<I', sample_rate))
            f.write(struct.pack('<I', sample_rate * bytes_per_sample))
            f.write(struct.pack('<H', bytes_per_sample))
            f.write(struct.pack('<H', 16))
            f.write(b'data')
            f.write(struct.pack('<I', data_size))
            f.write(b'\x00\x00' * num_samples)
    except Exception:
        pass

    return {
        "success": True,
        "file_path": output_path,
        "filename": filename,
        "duration_seconds": duration_seconds,
        "segments": 1,
        "voice_model": "kokoro-fallback-silent",
        "fallback": True
    }


def generate_kokoro(script: str, voice: str = "af_heart", speed: float = 1.0,
                    output_filename: str = "voiceover.wav") -> dict:
    """Generate voiceover using Kokoro-82M. Falls back to edge-tts / silent on failure."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    output_path = os.path.join(OUTPUT_DIR, output_filename)

    if KOKORO_AVAILABLE:
        try:
            cleaned = strip_visual_cues(script)
            # Pass voice directly — the UI dropdown only shows valid American English voices
            # Kokoro accepts: af_heart, af_bella, af_sarah, af_nicole, af_sky, af_river,
            # af_nova, af_alloy, af_jessica, af_kore, am_adam, am_michael, am_liam,
            # am_echo, am_eric, am_onyx, am_fenrir, am_puck, am_santa
            kokoro_voice = voice if voice and voice.startswith(('af_', 'am_')) else 'af_heart'
            
            pipeline = KPipeline(lang_code='a')
            all_audio = []
            for i, (gs, ps, audio) in enumerate(pipeline(cleaned, voice=kokoro_voice, speed=speed)):
                all_audio.append(audio)

            if all_audio:
                combined = np.concatenate(all_audio)
                # Kokoro outputs at 24000 Hz, save as temp then convert
                temp_path = output_path.replace('.wav', '_kokoro_temp.wav')
                sf.write(temp_path, combined, 24000)

                # Convert to 44100 Hz mono WAV for pipeline compatibility
                subprocess.run([
                    _get_ffmpeg_path(), "-y", "-i", temp_path,
                    "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "1",
                    output_path
                ], capture_output=True, timeout=30)
                try:
                    os.remove(temp_path)
                except Exception:
                    pass

                if os.path.exists(output_path):
                    duration = _get_audio_duration(output_path)
                    return {
                        "success": True,
                        "file_path": output_path,
                        "filename": output_filename,
                        "duration_seconds": duration,
                        "segments": 0,
                        "voice_model": f"kokoro:{kokoro_voice}",
                        "fallback": False
                    }
        except Exception as e:
            print(f"Kokoro TTS error: {e}, using fallback", file=sys.stderr)

    return generate_fallback_voiceover(script, output_path, output_filename)


def _get_audio_duration(file_path: str) -> float:
    try:
        result = subprocess.run([
            _get_ffprobe_path(), "-v", "quiet", "-print_format", "json",
            "-show_format", file_path
        ], capture_output=True, text=True, timeout=10)
        data = json.loads(result.stdout)
        return float(data.get("format", {}).get("duration", 0))
    except Exception:
        return 0.0


if __name__ == "__main__":
    input_data = json.loads(sys.stdin.read())
    
    # Redirect stdout to /dev/null during generation to suppress
    # HuggingFace/Kokoro warning print() calls that leak into output
    old_stdout = sys.stdout
    try:
        sys.stdout = open(os.devnull, 'w')
        result = generate_kokoro(
            script=input_data.get("script", ""),
            voice=input_data.get("voice", "af_heart"),
            speed=input_data.get("speed", 1.0),
            output_filename=input_data.get("output_filename", "voiceover.wav")
        )
    finally:
        sys.stdout.close()
        sys.stdout = old_stdout
    
    # Print only the clean JSON to stdout
    print(json.dumps(result, indent=2))
