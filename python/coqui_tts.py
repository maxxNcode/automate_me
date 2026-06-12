"""
Edge TTS Voiceover Generator
Converts scripts to speech using Microsoft Edge's free TTS (no API key needed).
Falls back to silent audio if edge-tts is unavailable.
"""

import sys
import json
import os
import re
import subprocess
import struct
import asyncio

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
    # Strip URLs that TTS would read aloud (http, https, www, file paths)
    cleaned = re.sub(r'https?://\S+', '', cleaned)
    cleaned = re.sub(r'www\.\S+', '', cleaned)
    # Strip isolated symbols, file paths, and excessive punctuation the AI might hallucinate
    cleaned = re.sub(r'\b\w+:[/\\]\S+', '', cleaned)  # paths like "thing:/path"
    cleaned = re.sub(r'[/\\]{2,}', '/', cleaned)  # collapse multiple slashes
    return cleaned.strip()


def _format_story_paragraphs(text: str) -> str:
    """Format story text for natural TTS: preserve paragraph breaks with ellipsis pauses."""
    paragraphs = re.split(r'\n\n+', text.strip())
    paragraphs = [p.strip() for p in paragraphs if p.strip()]
    if len(paragraphs) <= 1:
        return text.strip()
    # Join paragraphs with ellipsis — TTS naturally pauses on these
    return ' ... '.join(paragraphs)


def generate_voiceover(script: str, voice: str = "en-US-AriaNeural",
                       output_filename: str = "voiceover.wav",
                       use_ssml: bool = True) -> dict:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    output_path = os.path.join(OUTPUT_DIR, output_filename)

    if EDGE_TTS_AVAILABLE:
        for attempt in range(2):
            try:
                if use_ssml and attempt == 0:
                    tts_text = _format_story_paragraphs(strip_visual_cues(script))
                    # Slower rate + warmer pitch for storytelling (no SSML — edge-tts reads it raw)
                    rate = "-5%"
                    pitch_val = "+5Hz"
                else:
                    tts_text = strip_visual_cues(script)
                    rate = "+0%"
                    pitch_val = "+0Hz"
                    if attempt == 1:
                        print("[tts] SSML format fallback retry with plain text", file=sys.stderr)

                mp3_path = output_path.replace('.wav', '_edge.mp3')

                async def _do_tts():
                    communicate = edge_tts.Communicate(tts_text, voice, rate=rate, pitch=pitch_val)
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
                            "filename": output_filename,
                            "duration_seconds": duration,
                            "segments": 0,
                            "voice_model": f"edge-tts:{voice}",
                            "fallback": False
                        }
                break
            except Exception as e:
                print(f"[tts] Attempt {attempt} failed: {e}", file=sys.stderr)
                if attempt == 1:
                    raise

    return _generate_fallback_voiceover(script, output_path, output_filename)


def _generate_fallback_voiceover(script: str, output_path: str, filename: str) -> dict:
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
                "voice_model": "fallback-silent-ffmpeg",
                "fallback": True
            }
    except Exception:
        pass

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
        "voice_model": "fallback-silent",
        "fallback": True
    }


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


def list_available_voices() -> list:
    if EDGE_TTS_AVAILABLE:
        try:
            voices = asyncio.run(edge_tts.list_voices())
            return [f"{v['ShortName']} ({v['Locale']} - {v['Gender']})" for v in voices[:20]]
        except Exception:
            return ["en-US-JennyNeural"]
    return ["gtts (Google TTS, English)"]


if __name__ == "__main__":
    input_data = json.loads(sys.stdin.read())
    result = generate_voiceover(
        script=input_data.get("script", ""),
        voice=input_data.get("voice", "en-US-AriaNeural"),
        output_filename=input_data.get("output_filename", "voiceover.wav"),
        use_ssml=input_data.get("use_ssml", True)
    )
    print(json.dumps(result, indent=2))
