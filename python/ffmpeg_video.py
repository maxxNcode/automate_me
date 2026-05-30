"""
FFmpeg Video Assembler
Combines audio, images, and effects into a finished video.
Handles the entire video assembly pipeline.
"""

import sys
import json
import os
import subprocess
import tempfile
import re
import traceback
import shutil
import datetime
from pathlib import Path

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

# Try to import ffmpeg-python
try:
    import ffmpeg
    FFMPEG_PYTHON_AVAILABLE = True
except ImportError:
    FFMPEG_PYTHON_AVAILABLE = False

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "output", "assets", "videos")
ERROR_LOG = os.path.join(os.path.dirname(__file__), "..", "output", "assets", "scene_assembly_errors.log")


def _log_error(msg: str):
    """Write error to both stderr and the error log file."""
    print(msg, file=sys.stderr)
    try:
        os.makedirs(os.path.dirname(ERROR_LOG), exist_ok=True)
        with open(ERROR_LOG, 'a', encoding='utf-8') as f:
            f.write(f"[{datetime.datetime.now()}] {msg}\n")
    except Exception:
        pass


def _get_ffmpeg_path() -> str:
    """Find ffmpeg executable path (checks local bin first, then system PATH)."""
    # Check local project ffmpeg_bin first
    script_dir = os.path.dirname(os.path.abspath(__file__))
    local_ffmpeg = os.path.join(script_dir, '..', 'ffmpeg_bin', 'ffmpeg.exe')
    if os.path.exists(local_ffmpeg):
        return local_ffmpeg
    # Fallback to PATH
    return 'ffmpeg'


def _get_ffprobe_path() -> str:
    """Find ffprobe executable path."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    local_ffprobe = os.path.join(script_dir, '..', 'ffmpeg_bin', 'ffprobe.exe')
    if os.path.exists(local_ffprobe):
        return local_ffprobe
    return 'ffprobe'


def check_ffmpeg_installed() -> bool:
    """Check if FFmpeg is installed on the system."""
    try:
        subprocess.run([_get_ffmpeg_path(), "-version"], capture_output=True, check=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def create_video_from_assets(
    script: str,
    audio_path: str,
    thumbnail_path: str = None,
    background_images: list = None,
    output_filename: str = "final_video.mp4",
    video_title: str = "YouTube Video",
    add_subtitles: bool = False,
    background_music_path: str = None,
    resolution: str = '1920x1080'
) -> dict:
    """Assemble a complete video from generated assets.
    
    Args:
        script: The video script text (for subtitle generation)
        audio_path: Path to voiceover audio file
        thumbnail_path: Path to thumbnail image (used as video background)
        background_images: List of image paths for background slideshow
        output_filename: Output video filename
        video_title: Title for metadata
        add_subtitles: Whether to burn subtitles into video
        background_music_path: Optional background music track
        resolution: Target resolution (widthxheight)
    
    Returns:
        dict with result info
    """
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    output_path = os.path.join(OUTPUT_DIR, output_filename)
    
    if not check_ffmpeg_installed():
        return _fallback_video(audio_path, output_path, output_filename, resolution)
    
    try:
        # Determine audio duration
        audio_duration = _get_media_duration(audio_path)
        if audio_duration <= 0:
            audio_duration = 60  # default fallback
        
        # Select background image(s)
        images = []
        if background_images and len(background_images) > 0:
            images = background_images
        elif thumbnail_path and os.path.exists(thumbnail_path):
            images = [thumbnail_path]
        else:
            # Create a solid color background
            temp_bg = os.path.join(tempfile.gettempdir(), "youtube_bg.png")
            _create_background_image(temp_bg, video_title, resolution)
            images = [temp_bg]
        
        # Build the FFmpeg command
        if len(images) == 1:
            cmd = _build_single_image_command(images[0], audio_path, output_path, audio_duration, resolution)
        else:
            cmd = _build_slideshow_command(images, audio_path, output_path, audio_duration, resolution)
        
        # Run FFmpeg
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        
        if result.returncode != 0:
            print(f"FFmpeg error: {result.stderr}", file=sys.stderr)
            return _fallback_video(audio_path, output_path, output_filename, resolution)
        
        # Add subtitles if requested
        if add_subtitles:
            sub_video_path = output_path.replace('.mp4', '_subtitled.mp4')
            _add_subtitles(script, output_path, sub_video_path)
            output_path = sub_video_path
        
        file_size = os.path.getsize(output_path) if os.path.exists(output_path) else 0

        _cleanup_temp_files()

        return {
            "success": True,
            "file_path": output_path,
            "filename": output_filename,
            "duration_seconds": audio_duration,
            "file_size_bytes": file_size,
            "resolution": resolution,
            "fps": 30,
            "subtitles": add_subtitles,
            "fallback": False
        }
    except Exception as e:
        print(f"Video creation error: {e}, using fallback", file=sys.stderr)
        _cleanup_temp_files()
        return _fallback_video(audio_path, output_path, output_filename, resolution)


def _build_single_image_command(image_path: str, audio_path: str,
                                 output_path: str, duration: float,
                                 resolution: str = '1920x1080') -> list:
    """Build FFmpeg command for single image with ken burns effect."""
    ffmpeg_path = _get_ffmpeg_path()
    w, h = resolution.split('x')
    return [
        ffmpeg_path, "-y",
        "-loop", "1",
        "-i", image_path,
        "-i", audio_path,
        "-c:v", "libx264",
        "-c:a", "aac",
        "-t", str(duration),
        "-pix_fmt", "yuv420p",
        "-vf", f"scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,"
               f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,"
               f"zoompan=z='if(lte(zoom,1.0),1.05,zoom+0.0025)':d=25*4:s={w}x{h}",
        "-r", "30",
        "-shortest",
        "-movflags", "+faststart",
        output_path
    ]


def _build_slideshow_command(images: list, audio_path: str,
                              output_path: str, duration: float,
                              resolution: str = '1920x1080') -> list:
    """Build FFmpeg command for image slideshow."""
    # Create concat file for images
    concat_file = os.path.join(tempfile.gettempdir(), "images_concat.txt")
    seg_duration = duration / len(images)
    
    with open(concat_file, 'w') as f:
        for img in images:
            if os.path.exists(img):
                fp = img.replace('\\', '/')
                f.write(f"file '{fp}'\n")
                f.write(f"duration {seg_duration}\n")
        last_fp = images[-1].replace('\\', '/')
        f.write(f"file '{last_fp}'\n")  # Last image needs extra entry
    
    w, h = resolution.split('x')
    ffmpeg_path = _get_ffmpeg_path()
    return [
        ffmpeg_path, "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concat_file,
        "-i", audio_path,
        "-c:v", "libx264",
        "-c:a", "aac",
        "-pix_fmt", "yuv420p",
        "-vf", f"scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,"
               f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,"
               f"fade=t=in:st=0:d=0.5,fade=t=out:st={duration - 0.5}:d=0.5",
        "-r", "30",
        "-shortest",
        "-movflags", "+faststart",
        output_path
    ]


def _add_subtitles(script: str, input_video: str, output_path: str):
    """Generate and burn subtitles into video."""
    try:
        # Create SRT subtitle file
        srt_path = input_video.replace('.mp4', '.srt')
        lines = [l.strip() for l in script.split('\n') if l.strip()]
        
        with open(srt_path, 'w') as f:
            idx = 1
            current_time = 0
            for line in lines:
                if line.startswith('[') and line.endswith(']'):
                    continue
                words = line.split()
                if len(words) < 3:
                    continue
                duration = len(words) / 2.5
                start_time = current_time
                end_time = current_time + duration
                
                f.write(f"{idx}\n")
                f.write(f"{_format_srt_time(start_time)} --> {_format_srt_time(end_time)}\n")
                f.write(f"{line}\n\n")
                idx += 1
                current_time = end_time + 0.5
        
        # Burn subtitles - escape Windows drive colon for filter syntax
        ffmpeg_path = _get_ffmpeg_path()
        sub_filter_path = srt_path.replace('\\', '/').replace(':', '\\:')
        subprocess.run([
            ffmpeg_path, "-y",
            "-i", input_video,
            "-vf", f"subtitles={sub_filter_path}",
            "-c:a", "copy",
            output_path
        ], capture_output=True, timeout=120)
    except Exception as e:
        print(f"Subtitle error: {e}", file=sys.stderr)


def _format_srt_time(seconds: float) -> str:
    """Format seconds to SRT time format (HH:MM:SS,mmm)."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _cleanup_temp_files():
    """Remove known temp files created during video assembly."""
    temp_dir = tempfile.gettempdir()
    patterns = ["youtube_bg.png", "images_concat.txt", "videos_concat.txt"]
    for pattern in patterns:
        try:
            p = os.path.join(temp_dir, pattern)
            if os.path.exists(p):
                os.remove(p)
        except Exception:
            pass
    for f in os.listdir(temp_dir):
        if f.startswith('scene_karaoke_') and f.endswith('.ass'):
            try: os.remove(os.path.join(temp_dir, f))
            except: pass
    for f in os.listdir(os.getcwd()):
        if f.startswith('scene_karaoke_') and f.endswith('.ass'):
            try: os.remove(f)
            except: pass

    # Also clean .srt and _subtitled.mp4 files in the output directory
    if os.path.exists(OUTPUT_DIR):
        for f in os.listdir(OUTPUT_DIR):
            if f.endswith(".srt") or f.endswith("_subtitled.mp4"):
                try:
                    os.remove(os.path.join(OUTPUT_DIR, f))
                except Exception:
                    pass


def _create_background_image(path: str, text: str, resolution: str = '1920x1080'):
    """Create a simple gradient background image."""
    try:
        from PIL import Image, ImageDraw
        w, h = resolution.split('x')
        w, h = int(w), int(h)
        img = Image.new('RGB', (w, h), (20, 20, 35))
        draw = ImageDraw.Draw(img)
        for i in range(h):
            r = int(25 + (i / h) * 35)
            g = int(25 + (i / h) * 20)
            b = int(45 + (i / h) * 30)
            draw.line([(0, i), (w, i)], fill=(r, g, b))
        img.save(path)
    except Exception:
        pass


def _get_media_duration(file_path: str) -> float:
    """Get duration of a media file using FFprobe (with timeout)."""
    try:
        ffprobe_path = _get_ffprobe_path()
        result = subprocess.run([
            ffprobe_path, "-v", "quiet", "-print_format", "json",
            "-show_format", file_path
        ], capture_output=True, text=True, timeout=15)
        import json
        data = json.loads(result.stdout)
        return float(data.get("format", {}).get("duration", 0))
    except Exception:
        return 0.0


def _fallback_video(audio_path: str, output_path: str, filename: str, resolution: str = '1080x1920') -> dict:
    """Create a minimal video with solid color background."""
    duration = 30
    if os.path.exists(audio_path) and os.path.getsize(audio_path) > 100:
        duration = _get_media_duration(audio_path)
    if duration <= 0:
        duration = 30
    try:
        ffmpeg_path = _get_ffmpeg_path()
        has_audio = os.path.exists(audio_path) and os.path.getsize(audio_path) > 100
        audio_input = ["-i", audio_path] if has_audio else ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono"]
        subprocess.run([
            ffmpeg_path, "-y",
            "-f", "lavfi", "-i", f"color=c=#1a1a23:s={resolution}:d={duration}",
            *audio_input,
            "-c:v", "libx264", "-c:a", "aac",
            "-shortest", "-movflags", "+faststart",
            output_path
        ], capture_output=True, timeout=60)
    except Exception as e:
        return {"success": False, "error": str(e), "fallback": True}
    
    return {
        "success": True,
        "file_path": output_path,
        "filename": filename,
        "duration_seconds": _get_media_duration(output_path),
        "fallback": True
    }


def _get_word_timestamps(audio_path: str) -> list:
    """Get word-level timestamps from audio using faster-whisper for perfect caption sync."""
    try:
        if not audio_path or not os.path.exists(audio_path):
            return []
        from faster_whisper import WhisperModel
        import gc
        gc.collect()
        model = WhisperModel("base", device="cuda", compute_type="float16")
        segments, info = model.transcribe(audio_path, beam_size=1, word_timestamps=True)
        print(f"[ffmpeg] whisper lang={info.language} prob={info.language_probability:.2f}", file=sys.stderr)
        words = []
        for seg in segments:
            for w in seg.words:
                word = w.word.strip()
                if word:
                    words.append({'word': word, 'start': w.start, 'end': w.end})
        print(f"[ffmpeg] whisper returned {len(words)} words, last at {words[-1]['end']:.1f}s" if words else "[ffmpeg] whisper returned 0 words", file=sys.stderr)
        del model
        gc.collect()
        return words
    except Exception as e:
        print(f"[ffmpeg] Word timing failed, falling back to uniform: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return []


def _build_scale_filter(w: int | str, h: int | str, crop_position: str = 'fit') -> str:
    """Build FFmpeg scale filter string based on crop position.

    All options fill the screen (zoom+crop, no black bars).
    crop_position: 'fit' (center-crop, fill screen),
                   'center' (zoom+crop from center),
                   'top' (zoom+crop from top edge),
                   'bottom' (zoom+crop from bottom edge),
                   'left' (zoom+crop from left edge),
                   'right' (zoom+crop from right edge)
    """
    if crop_position == 'fit':
        return (f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,"
                f"crop={w}:{h},setsar=1,format=yuv420p")
    elif crop_position == 'center':
        return (f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,"
                f"crop={w}:{h},setsar=1,format=yuv420p")
    elif crop_position == 'top':
        return (f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,"
                f"crop={w}:{h}:(iw-{w})/2:0,setsar=1,format=yuv420p")
    elif crop_position == 'bottom':
        return (f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,"
                f"crop={w}:{h}:(iw-{w})/2:ih-{h},setsar=1,format=yuv420p")
    elif crop_position == 'left':
        return (f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,"
                f"crop={w}:{h}:0:0,setsar=1,format=yuv420p")
    elif crop_position == 'right':
        return (f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,"
                f"crop={w}:{h}:iw-{w}:0,setsar=1,format=yuv420p")
    else:
        return (f"scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p")


def _generate_scene_srt(clips: list, cumulative_times: list, output_path: str):
    """Generate SRT subtitle file from scene clips with cumulative timing."""
    with open(output_path, 'w', encoding='utf-8') as f:
        idx = 1
        for i, clip in enumerate(clips):
            text = clip.get('text', '')
            if not text:
                continue
            clean_text = re.sub(r'\[(HOOK|VALUE|CTA)\]', '', text)
            clean_text = clean_text.strip()[:80]
            if not clean_text:
                continue

            start_time = cumulative_times[i]
            end_time = cumulative_times[i + 1]

            f.write(f"{idx}\n")
            f.write(f"{_format_srt_time(start_time)} --> {_format_srt_time(end_time)}\n")
            f.write(f"{clean_text}\n\n")
            idx += 1


def _generate_scene_ass(clips: list, audio_duration: float, output_path: str,
                        resolution: str = '1080x1920', words_per_batch: int = 2,
                        caption_position: str = 'bottom',
                        background_color: str = 'black',
                        word_timestamps: list = None):
    r"""Generate ASS caption with per-word solid background box (TikTok/Shorts style).

    Each word pops up with white text inside a solid colored box (BorderStyle=3).
    Box padding via Outline style field. Clean rectangle, no glow.
    """
    width, height = resolution.split('x') if 'x' in resolution else ('1080', '1920')
    font_size = max(48, int(int(height) * 0.065))
    half_w = int(int(width) * 0.08)
    margin_v = int(int(height) * 0.06)

    align_map = {'top': 8, 'center': 5, 'bottom': 2}
    alignment = align_map.get(caption_position, 2)

    # BackColour in BGRA format for BorderStyle=3 solid box
    BG_MAP = {
        'black':   '&H80000000',
        'blue':    '&H80800000',
        'purple':  '&H80800080',
        'red':     '&H800000FF',
        'green':   '&H80008000',
    }

    all_words = []
    total_words = 0
    for clip in clips:
        text = clip.get('text', '')
        if not text:
            continue
        clean_text = re.sub(r'\[(HOOK|VALUE|CTA)\]', '', text)
        clean_text = clean_text.strip()
        if not clean_text:
            continue
        words = clean_text.split()
        if words:
            all_words.append(words)
            total_words += len(words)
        else:
            all_words.append([])

    if total_words == 0:
        return

    use_real_timing = word_timestamps and len(word_timestamps) > 1
    if use_real_timing:
        def clean(w):
            return re.sub(r'[^\w\']', '', w).lower()
        flat_script = []
        for scene_words in all_words:
            for w in scene_words:
                flat_script.append(w)
        aligned = []
        match_count = 0
        wi = 0
        for idx, sw in enumerate(flat_script):
            sw_clean = clean(sw)
            t_fallback = audio_duration * idx / len(flat_script)
            if not sw_clean:
                aligned.append({'start': t_fallback, 'end': t_fallback + 0.3})
                continue
            found = False
            while wi < len(word_timestamps):
                ww_clean = clean(word_timestamps[wi]['word'])
                if sw_clean == ww_clean or (len(sw_clean) > 2 and (sw_clean in ww_clean or ww_clean in sw_clean)):
                    aligned.append(word_timestamps[wi])
                    wi += 1
                    match_count += 1
                    found = True
                    break
                wi += 1
            if not found:
                aligned.append({'start': t_fallback, 'end': t_fallback + 0.3})
        # If fewer than 50% of words matched, fall back to uniform timing
        if match_count < len(flat_script) * 0.5:
            print(f"[ffmpeg] Whisper alignment poor ({match_count}/{len(flat_script)} matched), using uniform timing", file=sys.stderr)
            use_real_timing = False
        else:
            word_timing = aligned
            print(f"[ffmpeg] Whisper alignment OK ({match_count}/{len(flat_script)} matched)", file=sys.stderr)
    if not use_real_timing:
        word_duration = audio_duration / total_words
        word_timing = [{'start': i * word_duration, 'end': (i + 1) * word_duration}
                       for i in range(total_words)]

    has_bg = bool(background_color and background_color != 'transparent')

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write("[Script Info]\n")
        f.write("ScriptType: v4.00+\n")
        f.write(f"PlayResX: {width}\n")
        f.write(f"PlayResY: {height}\n")
        f.write("ScaledBorderAndShadow: yes\n\n")

        f.write("[V4+ Styles]\n")
        f.write("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n")
        if has_bg:
            back_colour = BG_MAP.get(background_color, '&H80000000')
            border_style = 3
            outline = 10
        else:
            back_colour = '&H00000000'
            border_style = 1
            outline = 2
        f.write(f"Style: Caption,Arial Bold,{font_size},&H00FFFFFF,&H00FFFFFF,&H00000000,"
                f"{back_colour},-1,0,0,0,100,100,0,0,{border_style},{outline},0,"
                f"{alignment},{half_w},{half_w},{margin_v},1\n")

        f.write("[Events]\n")
        f.write("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")

        flat_idx = 0
        for scene_words in all_words:
            if not scene_words:
                continue
            batches = [scene_words[j:j + words_per_batch] for j in range(0, len(scene_words), words_per_batch)]
            for batch in batches:
                batch_end_idx = min(flat_idx + len(batch) - 1, len(word_timing) - 1)
                batch_start = word_timing[flat_idx]['start']
                batch_end = word_timing[batch_end_idx]['end']
                if batch_end <= batch_start:
                    batch_end = batch_start + 0.5

                parts = []
                for word in batch:
                    clean_word = word.replace('{', '\\{').replace('}', '\\}')
                    parts.append(clean_word)
                    flat_idx += 1

                text = ' '.join(parts)
                f.write(f"Dialogue: 0,{_format_ass_time(batch_start)},{_format_ass_time(batch_end)},"
                        f"Caption,,0,0,0,,{text}\n")


def _format_ass_time(seconds: float) -> str:
    """Format seconds to ASS time format (H:MM:SS.cc)."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    cs = int((seconds % 1) * 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def assemble_scene_video(
    clips: list,
    audio_path: str,
    output_filename: str = "scene_video.mp4",
    resolution: str = "1920x1080",
    crop_position: str = 'fit',
    caption_position: str = 'bottom',
    caption_background_color: str = 'black'
) -> dict:
    """
    Assemble a video from multiple scene clips with per-scene text overlays.
    
    Each clip plays for its scene, with the scene text overlaid as a caption.
    The voiceover audio is used as the main audio track.
    
    Args:
        clips: List of {file_path, text} dicts — one per scene
        audio_path: Path to the voiceover audio file
        output_filename: Output video filename
        resolution: Target resolution (widthxheight)
        crop_position: How to fit/crop clips ('fit', 'center', 'top', 'bottom', 'left', 'right')
        caption_position: Vertical caption placement ('top', 'center', 'bottom')
        caption_background_color: Caption background color or 'transparent'
    
    Returns:
        dict with result info
    """
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    output_path = os.path.join(OUTPUT_DIR, output_filename)

    if not check_ffmpeg_installed():
        return _fallback_video(audio_path, output_path, output_filename, resolution)

    if not clips or not audio_path or not os.path.exists(audio_path):
        return {"success": False, "error": "No clips or audio", "fallback": True}

    # Filter to only existing clip files
    valid_clips = [c for c in clips if c.get('file_path') and os.path.exists(c['file_path'])]
    if not valid_clips:
        print("[ffmpeg] No valid clips found, falling back to audio-only video", file=sys.stderr)
        return {"success": False, "error": "No valid clips found", "fallback": True}

    try:
        audio_duration = _get_media_duration(audio_path)
        if audio_duration <= 0:
            audio_duration = 60

        target_duration = audio_duration

        # Get actual duration of each clip and calculate timeline
        clip_durations = []
        cumulative_times = [0.0]
        total_clip_duration = 0.0

        for clip in valid_clips:
            dur = _get_media_duration(clip['file_path'])
            if dur <= 0:
                dur = 10  # fallback if ffprobe fails
            clip_durations.append(dur)
            total_clip_duration += dur
            cumulative_times.append(total_clip_duration)

        # If total clip duration is shorter than audio, extend last clip
        # by looping it (or just let -shortest handle it)
        # If clips are much longer, we'll trim them proportionally
        duration_scale = 1.0
        if total_clip_duration < target_duration * 0.5:
            # Clips are way too short — scale factor to stretch
            duration_scale = target_duration / total_clip_duration if total_clip_duration > 0 else 1.0

        # Concat all clips using the simple (proven working) approach
        ffmpeg_path = _get_ffmpeg_path()
        concat_output = output_path.replace('.mp4', '_noss.mp4')
        print(f"[ffmpeg] Running scene assembly with {len(valid_clips)} clips...", file=sys.stderr)
        cmd = _build_simple_concat_command(valid_clips, audio_path, concat_output, resolution, crop_position)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            print(f"[ffmpeg] Concat failed:\n{result.stderr[:2000]}", file=sys.stderr)
            return {"success": False, "error": f"Concat failed (rc={result.returncode})", "fallback": True}

        # Burn captions using ASS (per-word popup with background box)
        ass_name = f"scene_karaoke_{os.getpid()}.ass"
        ass_path = os.path.join(os.getcwd(), ass_name)
        try:
            print(f"[ffmpeg] Getting word timestamps...", file=sys.stderr)
            word_timestamps = _get_word_timestamps(audio_path)
            print(f"[ffmpeg] Got {len(word_timestamps)} word timestamps, generating ASS...", file=sys.stderr)
            _generate_scene_ass(valid_clips, audio_duration, ass_path, resolution,
                                words_per_batch=1, caption_position=caption_position,
                                background_color=caption_background_color,
                                word_timestamps=word_timestamps)
            ass_size = os.path.getsize(ass_path) if os.path.exists(ass_path) else 0
            print(f"[ffmpeg] ASS file size: {ass_size} bytes", file=sys.stderr)
            if ass_size > 50:
                print(f"[ffmpeg] Burning captions via ass={ass_name}...", file=sys.stderr)
                sub_process = subprocess.run([
                    ffmpeg_path, "-y",
                    "-i", concat_output,
                    "-vf", f"ass={ass_name}",
                    "-c:a", "copy",
                    output_path,
                ], capture_output=True, text=True, timeout=120)
                if sub_process.returncode != 0:
                    print(f"[ffmpeg] Caption burn failed:\n{sub_process.stderr[:500]}", file=sys.stderr)
                    if os.path.exists(concat_output):
                        shutil.copy2(concat_output, output_path)
                else:
                    print(f"[ffmpeg] Caption burn OK, removing concat temp", file=sys.stderr)
                    if os.path.exists(concat_output):
                        try: os.remove(concat_output)
                        except: pass
            else:
                print(f"[ffmpeg] ASS file too small ({ass_size}), skipping captions", file=sys.stderr)
                if os.path.exists(concat_output):
                    shutil.copy2(concat_output, output_path)
        except Exception as e:
            print(f"[ffmpeg] Caption burn exception: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            if os.path.exists(concat_output):
                shutil.copy2(concat_output, output_path)

        file_size = os.path.getsize(output_path) if os.path.exists(output_path) else 0
        actual_duration = _get_media_duration(output_path)

        # Clean up individual clip files after successful assembly
        for clip in valid_clips:
            try:
                if os.path.exists(clip['file_path']):
                    os.remove(clip['file_path'])
            except Exception:
                pass

        _cleanup_temp_files()
        if os.path.exists(ass_path):
            try: os.remove(ass_path)
            except: pass

        return {
            "success": True,
            "file_path": output_path,
            "filename": output_filename,
            "duration_seconds": actual_duration,
            "file_size_bytes": file_size,
            "resolution": resolution,
            "fps": 30,
            "subtitles": True,
            "clips_used": len(valid_clips),
            "fallback": result.returncode != 0,
        }
    except Exception as e:
        print(f"[ffmpeg] Scene assembly exception: {e}", file=sys.stderr)
        _cleanup_temp_files()
        return {"success": False, "error": str(e), "fallback": True}


def _build_simple_concat_command(clips: list, audio_path: str, output_path: str, resolution: str,
                                  crop_position: str = 'fit') -> list:
    """Build a simpler FFmpeg command without per-scene drawtext overlays.
    Scales clips to target resolution via filter_complex and maps voiceover audio explicitly.
    """
    ffmpeg_path = _get_ffmpeg_path()
    w, h = resolution.split('x')
    clip_inputs = []
    filter_parts = []
    clip_labels = []

    # Build timing cumulative times for SRT generation
    cumulative_times = [0.0]
    for i, clip in enumerate(clips):
        clip_inputs.extend(['-i', clip['file_path']])
        label = f"v{i}"
        clip_labels.append(label)
        scale_filter = _build_scale_filter(w, h, crop_position)
        filter_parts.append(f"[{i}:v]{scale_filter}[{label}]")
        dur = _get_media_duration(clip['file_path'])
        cumulative_times.append(cumulative_times[-1] + (dur if dur > 0 else 10))

    concat_input = ''.join(f'[{lbl}]' for lbl in clip_labels)
    filter_parts.append(f"{concat_input}concat=n={len(clip_labels)}:v=1:a=0[vid_out]")

    filter_complex = ";".join(filter_parts)

    cmd = [
        ffmpeg_path, "-y",
        *clip_inputs,
        "-i", audio_path,
        "-filter_complex", filter_complex,
        "-map", "[vid_out]",
        "-map", f"{len(clips)}:a",
        "-c:v", "libx264", "-c:a", "aac",
        "-pix_fmt", "yuv420p", "-r", "30",
        "-shortest", "-movflags", "+faststart",
        output_path,
    ]
    return cmd


def _find_font() -> str | None:
    """Find an available system font for drawtext.
    Returns path with forward slashes for FFmpeg filter compatibility.
    """
    possible_fonts = [
        # Windows
        "C:\\Windows\\Fonts\\arial.ttf",
        "C:\\Windows\\Fonts\\segoeui.ttf",
        "C:\\Windows\\Fonts\\tahoma.ttf",
        "C:\\Windows\\Fonts\\calibri.ttf",
        # Linux
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        # macOS
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ]
    for font in possible_fonts:
        if os.path.exists(font):
            path = font.replace('\\', '/')
            path = path.replace(':', '\\:')
            return path
    return None


def concatenate_videos(video_paths: list, output_filename: str = "compilation.mp4") -> dict:
    """Concatenate multiple video files."""
    output_path = os.path.join(OUTPUT_DIR, output_filename)
    
    if not check_ffmpeg_installed():
        return {"success": False, "error": "FFmpeg not installed"}
    
    try:
        concat_file = os.path.join(tempfile.gettempdir(), "videos_concat.txt")
        with open(concat_file, 'w') as f:
            for v in video_paths:
                if os.path.exists(v):
                    fp = v.replace('\\', '/')
                    f.write(f"file '{fp}'\n")
        
        ffmpeg_path = _get_ffmpeg_path()
        subprocess.run([
            ffmpeg_path, "-y", "-f", "concat", "-safe", "0",
            "-i", concat_file, "-c", "copy", output_path
        ], capture_output=True, check=True, timeout=300)

        _cleanup_temp_files()

        return {"success": True, "file_path": output_path}
    except Exception as e:
        return {"success": False, "error": str(e)}


if __name__ == "__main__":
    try:
        raw = sys.stdin.read()
        input_data = json.loads(raw)
    except Exception as e:
        print(json.dumps({"success": False, "error": f"stdin JSON parse: {e}", "fallback": True}))
        sys.exit(1)
    
    action = input_data.get("action", "assemble")
    
    try:
        if action == "concat":
            result = concatenate_videos(
                video_paths=input_data.get("video_paths", []),
                output_filename=input_data.get("output_filename", "compilation.mp4")
            )
        elif action == "scene_assembly":
            result = assemble_scene_video(
                clips=input_data.get("clips", []),
                audio_path=input_data.get("audio_path", ""),
                output_filename=input_data.get("output_filename", "scene_video.mp4"),
                resolution=input_data.get("resolution", "1920x1080"),
                crop_position=input_data.get("crop_position", "fit"),
                caption_position=input_data.get("caption_position", "bottom"),
                caption_background_color=input_data.get("caption_background_color", "black")
            )
        else:
            result = create_video_from_assets(
                script=input_data.get("script", ""),
                audio_path=input_data.get("audio_path", ""),
                thumbnail_path=input_data.get("thumbnail_path"),
                background_images=input_data.get("background_images"),
                output_filename=input_data.get("output_filename", "final_video.mp4"),
                video_title=input_data.get("video_title", "YouTube Video"),
                add_subtitles=input_data.get("add_subtitles", False),
                resolution=input_data.get("resolution", "1920x1080")
            )
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        result = {"success": False, "error": f"Unhandled: {e}", "fallback": True}
    
    print(json.dumps(result, indent=2))
    sys.stdout.flush()
