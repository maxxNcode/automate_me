"""
gTTS Voiceover Generator
Converts scripts to speech using Google Text-to-Speech (free, no model downloads).
Falls back to silent audio of correct duration if gTTS is unavailable.
"""

import sys
import json
import os
import re
import subprocess
import struct

try:
    from gtts import gTTS
    GTTS_AVAILABLE = True
except ImportError:
    GTTS_AVAILABLE = False

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
    return cleaned.strip()


def split_into_segments(script: str, max_chars: int = 500) -> list:
    cleaned = strip_visual_cues(script)
    paragraphs = re.split(r'\n\n+', cleaned)
    segments = []
    current = ""

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(current) + len(para) < max_chars:
            current += "\n\n" + para if current else para
        else:
            if current:
                segments.append(current)
            current = para

    if current:
        segments.append(current)

    return segments if segments else [cleaned]


def generate_voiceover(script: str, voice: str = "gtts",
                       output_filename: str = "voiceover.wav") -> dict:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    output_path = os.path.join(OUTPUT_DIR, output_filename)

    if GTTS_AVAILABLE:
        try:
            cleaned = strip_visual_cues(script)
            segments = split_into_segments(script)
            mp3_path = output_path.replace('.wav', '_gtts.mp3')

            tts = gTTS(text=cleaned, lang='en', slow=False)
            tts.save(mp3_path)

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
                        "segments": len(segments),
                        "voice_model": "gtts",
                        "fallback": False
                    }
        except Exception as e:
            print(f"gTTS error: {e}, using fallback", file=sys.stderr)

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
    return ["gtts (Google TTS, English)"]


if __name__ == "__main__":
    input_data = json.loads(sys.stdin.read())
    result = generate_voiceover(
        script=input_data.get("script", ""),
        voice=input_data.get("voice", "gtts"),
        output_filename=input_data.get("output_filename", "voiceover.wav")
    )
    print(json.dumps(result, indent=2))
