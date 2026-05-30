"""
YouTube Footage Downloader
Searches YouTube for videos matching scene search terms,
finds the most relevant timestamp via transcript keyword search,
and downloads that segment as a clip.

Dependencies: pip install yt-dlp youtube-transcript-api
"""

import sys
import json
import os
import re
import random
import subprocess
import tempfile
from pathlib import Path

# Try importing dependencies
try:
    import yt_dlp
    YT_DLP_AVAILABLE = True
except ImportError:
    YT_DLP_AVAILABLE = False

try:
    from youtube_transcript_api import YouTubeTranscriptApi
    TRANSCRIPT_API_AVAILABLE = True
except ImportError:
    TRANSCRIPT_API_AVAILABLE = False

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "output", "assets", "videos", "clips")


def sanitize_filename(text: str, max_length: int = 40) -> str:
    """Turn any text into a safe filename fragment."""
    safe = re.sub(r'[^a-zA-Z0-9_\- ]', '', text)
    safe = re.sub(r'\s+', '_', safe.strip())
    return safe[:max_length]


def search_youtube(query: str, max_results: int = 5) -> list[dict]:
    """
    Search YouTube using yt-dlp's extractor (no API key needed).
    Returns list of {id, title, url, duration, uploader}.
    """
    if not YT_DLP_AVAILABLE:
        return []

    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': True,
        'force_generic_extractor': False,
    }

    search_query = f"ytsearch{max_results}:{query}"

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(search_query, download=False)
            if not info or 'entries' not in info:
                return []

            results = []
            for entry in info['entries']:
                if not entry:
                    continue
                results.append({
                    'id': entry.get('id', ''),
                    'title': entry.get('title', ''),
                    'url': f"https://youtube.com/watch?v={entry.get('id', '')}",
                    'duration': entry.get('duration', 0),
                    'uploader': entry.get('uploader', ''),
                })
            return results
    except Exception as e:
        print(f"[youtube_footage] Search error: {e}", file=sys.stderr)
        return []


def fetch_transcript(video_id: str) -> list[dict] | None:
    """
    Fetch auto-generated transcript for a video using youtube-transcript-api.
    Returns list of {text, start, duration} or None.
    """
    if not TRANSCRIPT_API_AVAILABLE:
        return None

    try:
        transcript = YouTubeTranscriptApi.get_transcript(video_id, languages=['en'])
        return transcript
    except Exception as e:
        # Try without language filter
        try:
            transcript = YouTubeTranscriptApi.get_transcript(video_id)
            return transcript
        except Exception:
            return None


def extract_keywords(text: str, search_terms: list[str]) -> list[str]:
    """
    Extract meaningful keywords from scene text + search terms.
    Returns unique lowercase keywords sorted by relevance.
    """
    # Combine scene text with search terms
    combined = text + ' ' + ' '.join(search_terms)

    # Extract words (3+ chars, not common stop words)
    stop_words = {'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can',
                  'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been',
                  'this', 'that', 'with', 'from', 'they', 'what', 'when', 'where',
                  'who', 'how', 'why', 'will', 'your', 'some', 'them', 'than',
                  'then', 'also', 'just', 'like', 'more', 'much', 'over', 'such',
                  'very', 'way', 'well', 'which', 'about', 'into', 'their', 'other',
                  'could', 'would', 'should', 'these', 'those', 'after', 'still',
                  'because', 'before', 'being', 'doing', 'going', 'making',
                  'minecraft', 'game', 'games', 'gaming', 'gameplay', 'roblox',
                  'video', 'videos', 'play', 'playing', 'lets', 'let', 'look',
                  'going', 'come', 'back', 'here', 'there', 'know', 'think',
                  'make', 'take', 'get', 'got', 'see', 'say', 'tell', 'time',
                  'good', 'new', 'first', 'last', 'long', 'great', 'little',
                  'right', 'old', 'big', 'high', 'different', 'small', 'large'}

    words = re.findall(r'\b[a-zA-Z]{3,}\b', combined.lower())
    # Prioritize search terms, then longer/more specific words
    scored = {}
    for w in words:
        if w in stop_words or len(w) < 3:
            continue
        # Higher score for search terms and capitalized words (proper nouns)
        score = 1
        if w in [t.lower() for t in search_terms]:
            score += 3
        if w[0].isupper() and w in combined:
            score += 2  # Proper nouns, game names
        scored[w] = scored.get(w, 0) + score

    sorted_words = sorted(scored.items(), key=lambda x: -x[1])
    return [w for w, s in sorted_words[:15]]


def find_best_timestamp(transcript: list[dict], keywords: list[str]) -> dict | None:
    """
    Search transcript for keywords, find the best matching segment.
    Returns {start, end, text, score} or None.
    
    Strategy: Find the segment with the most keyword matches,
    preferring segments where multiple keywords appear close together.
    """
    if not transcript or not keywords:
        return None

    best_segment = None
    best_score = 0
    window_size = 3  # Look at N consecutive transcript entries as a window

    for i in range(len(transcript) - window_size + 1):
        window = transcript[i:i + window_size]
        window_text = ' '.join(seg['text'].lower() for seg in window)
        
        score = 0
        for kw in keywords:
            if kw.lower() in window_text:
                score += 1

        if score > best_score:
            best_score = score
            # Start a bit before the match, end after
            start = max(0, window[0]['start'] - 2)
            end = window[-1]['start'] + window[-1]['duration'] + 2
            best_segment = {
                'start': start,
                'end': end,
                'text': window_text[:100],
                'score': score,
            }

    if best_segment and best_score > 0:
        return best_segment
    return None


def _get_ffmpeg_path() -> str:
    """Find ffmpeg executable path (checks local bin first, then system PATH)."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    local_ffmpeg = os.path.join(script_dir, '..', 'ffmpeg_bin', 'ffmpeg.exe')
    if os.path.exists(local_ffmpeg):
        return local_ffmpeg
    return 'ffmpeg'


def _get_ffprobe_path() -> str:
    """Find ffprobe executable path."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    local_ffprobe = os.path.join(script_dir, '..', 'ffmpeg_bin', 'ffprobe.exe')
    if os.path.exists(local_ffprobe):
        return local_ffprobe
    return 'ffprobe'


def _download_segment(ffmpeg_path: str, stream_url: str, start_time: float,
                       end_time: float, output_path: str,
                       timeout: int = 120) -> subprocess.CompletedProcess:
    """Download a segment from a stream URL using ffmpeg input seeking.
    
    -ss before -i = input seeking — only downloads data from seek point onwards.
    -to = exact end time in source timeline.
    -c copy = stream copy (no re-encode).
    """
    cmd = [
        ffmpeg_path, '-y',
        '-ss', str(start_time),
        '-to', str(end_time),
        '-i', stream_url,
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        output_path
    ]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _merge_av(ffmpeg_path: str, video_path: str, audio_path: str,
              output_path: str) -> subprocess.CompletedProcess:
    """Merge separate video and audio streams into one file."""
    cmd = [
        ffmpeg_path, '-y',
        '-i', video_path,
        '-i', audio_path,
        '-c', 'copy',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-shortest',
        '-movflags', '+faststart',
        output_path
    ]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60)


def download_clip(video_url: str, output_path: str, start_time: float = None,
                  duration: float = 15) -> dict:
    """
    Download a segment of a YouTube video.
    
    Uses yt-dlp to get stream URLs + ffmpeg to download ONLY the
    requested segment (seeks on the server side, no full download).
    
    Handles both combined formats (single stream with video+audio)
    and DASH formats (separate video and audio streams that need merging).
    
    If start_time is provided, downloads a segment around that time.
    If not, downloads a random middle segment.
    
    Returns dict with success status and file info.
    """
    if not YT_DLP_AVAILABLE:
        return {'success': False, 'error': 'yt-dlp not installed'}

    out_dir = os.path.dirname(output_path)
    os.makedirs(out_dir, exist_ok=True)

    ffmpeg_path = _get_ffmpeg_path()
    ffprobe_path = _get_ffprobe_path()

    # If no start time, pick a random segment starting 30s in (skip intros)
    if start_time is None:
        start_time = 30 + random.random() * 60  # Random between 30-90s

    end_time = start_time + duration
    temp_files = []

    try:
        # Step 1: Get video info and analyze available formats
        with yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True}) as ydl:
            info = ydl.extract_info(video_url, download=False)

        formats = info.get('formats', [])
        
        # Step 2: Try to find a combined format (video + audio in one stream)
        # Format 18 = 360p MP4, Format 22 = 720p MP4 — legacy formats
        combined_fmt = None
        for fmt in formats:
            fid = fmt.get('format_id', '')
            vcodec = fmt.get('vcodec', 'none')
            acodec = fmt.get('acodec', 'none')
            height = fmt.get('height', 0) or 0
            
            if vcodec == 'none' or acodec == 'none':
                continue
            if height <= 1080:
                combined_fmt = fmt
                if fid in ('22', '18'):
                    combined_fmt = fmt
                    break

        if combined_fmt and combined_fmt.get('url'):
            # Fast path: single stream with both audio and video
            result = _download_segment(
                ffmpeg_path, combined_fmt['url'], start_time, end_time, output_path
            )
            if result.returncode == 0 and os.path.exists(output_path):
                file_size = os.path.getsize(output_path)
                actual_dur = _get_actual_duration(ffprobe_path, output_path) or duration
                return _clip_success(output_path, file_size, actual_dur,
                                     duration, start_time, info.get('title', ''))

        # Step 3: Fallback — DASH format (separate video and audio streams)
        # Find best video-only stream (≤720p)
        video_fmt = None
        audio_fmt = None
        best_height = 0
        
        for fmt in formats:
            vcodec = fmt.get('vcodec', 'none')
            acodec = fmt.get('acodec', 'none')
            height = fmt.get('height', 0) or 0
            fmt_url = fmt.get('url')
            
            if not fmt_url:
                continue
            
            if vcodec != 'none' and acodec == 'none' and height <= 1080:
                # Video-only stream
                if height > best_height:
                    video_fmt = fmt
                    best_height = height
            elif vcodec == 'none' and acodec != 'none':
                # Audio-only stream — prefer highest bitrate
                if audio_fmt is None or (fmt.get('abr', 0) or 0) > (audio_fmt.get('abr', 0) or 0):
                    audio_fmt = fmt

        if not video_fmt or not audio_fmt:
            return {'success': False, 'error': 'No suitable format found (no combined or DASH streams)'}

        # Download video segment
        base = output_path.rsplit('.', 1)[0]
        temp_video = base + '_tmp_v.mp4'
        temp_audio = base + '_tmp_a.m4a'
        temp_files = [temp_video, temp_audio]

        v_result = _download_segment(
            ffmpeg_path, video_fmt['url'], start_time, end_time, temp_video
        )
        if v_result.returncode != 0 or not os.path.exists(temp_video):
            return {'success': False, 'error': f'Failed to download video stream: {v_result.stderr[:200]}'}

        a_result = _download_segment(
            ffmpeg_path, audio_fmt['url'], start_time, end_time, temp_audio
        )
        if a_result.returncode != 0 or not os.path.exists(temp_audio):
            return {'success': False, 'error': f'Failed to download audio stream: {a_result.stderr[:200]}'}

        # Merge video and audio
        merge_result = _merge_av(ffmpeg_path, temp_video, temp_audio, output_path)
        if merge_result.returncode != 0 or not os.path.exists(output_path):
            return {'success': False, 'error': f'Failed to merge streams: {merge_result.stderr[:200]}'}

        # Cleanup temp files
        for f in temp_files:
            try:
                if os.path.exists(f):
                    os.remove(f)
            except Exception:
                pass

        file_size = os.path.getsize(output_path)
        actual_dur = _get_actual_duration(ffprobe_path, output_path) or duration
        
        return _clip_success(output_path, file_size, actual_dur,
                             duration, start_time, info.get('title', ''))

    except subprocess.TimeoutExpired:
        _cleanup_temp_files(temp_files)
        return {'success': False, 'error': 'Download timed out (120s)'}
    except Exception as e:
        _cleanup_temp_files(temp_files)
        return {'success': False, 'error': str(e)}


def _clip_success(file_path: str, file_size: int, actual_duration: float,
                  target_duration: float, start_time: float,
                  source_title: str) -> dict:
    """Build a success response dict for a downloaded clip."""
    return {
        'success': True,
        'file_path': file_path,
        'file_size_bytes': file_size,
        'actual_duration': actual_duration if actual_duration > 0 else target_duration,
        'target_duration': target_duration,
        'start_time': start_time,
        'source_title': source_title,
    }


def _get_actual_duration(ffprobe_path: str, file_path: str) -> float | None:
    """Get actual duration of a media file using ffprobe."""
    try:
        probe = subprocess.run(
            [ffprobe_path, '-v', 'quiet', '-print_format', 'json',
             '-show_format', file_path],
            capture_output=True, text=True, timeout=10
        )
        data = json.loads(probe.stdout)
        return float(data.get('format', {}).get('duration', 0))
    except Exception:
        return None


def _cleanup_temp_files(files: list[str]):
    """Safely remove temporary files."""
    for f in files:
        try:
            if os.path.exists(f):
                os.remove(f)
        except Exception:
            pass


def get_clip_duration(file_path: str) -> float:
    """Get actual duration of a downloaded clip using ffprobe."""
    ffprobe_path = _get_ffprobe_path()
    try:
        result = subprocess.run([
            ffprobe_path, '-v', 'quiet', '-print_format', 'json',
            '-show_format', file_path
        ], capture_output=True, text=True, timeout=10)
        data = json.loads(result.stdout)
        return float(data.get('format', {}).get('duration', 0))
    except Exception:
        return 0.0


def process_scene(scene_text: str, search_terms: list[str],
                  output_dir: str, scene_index: int,
                  clip_duration: float = 12) -> dict:
    """
    Process a single scene: find and download a relevant gameplay clip.
    
    Steps:
    1. Search YouTube for videos matching search terms
    2. Try to fetch transcripts for found videos
    3. Search transcripts for keywords from scene text
    4. Download the best matching segment
    
    Returns dict with clip info or fallback.
    """
    # Build search query from search terms + scene keywords
    keywords = extract_keywords(scene_text, search_terms)
    query = ' '.join(search_terms[:3]) if search_terms else ' '.join(keywords[:3])

    if not query:
        query = 'gameplay'

    print(f"[Scene {scene_index}] Searching: '{query}'", file=sys.stderr)
    videos = search_youtube(query, max_results=5)

    if not videos:
        print(f"[Scene {scene_index}] No videos found for '{query}'", file=sys.stderr)
        return {'success': False, 'error': f'No videos found for: {query}'}

    # Shuffle to avoid always picking the same channels
    random.shuffle(videos)

    for video in videos[:3]:  # Try top 3 results
        vid_id = video['id']
        print(f"[Scene {scene_index}] Trying video: {video['title'][:60]}", file=sys.stderr)

        # Fetch transcript
        transcript = fetch_transcript(vid_id)
        best_match = None

        if transcript:
            # Search transcript for keywords
            best_match = find_best_timestamp(transcript, keywords)

        # Determine what to download
        output_path = os.path.join(
            output_dir,
            f"scene_{scene_index:03d}_{sanitize_filename(query)}_{vid_id}.mp4"
        )

        if best_match and best_match['score'] >= 1:
            # Found keyword match - download that segment
            seg_duration = min(clip_duration, best_match['end'] - best_match['start'])
            seg_duration = max(seg_duration, 5)  # At least 5 seconds
            print(f"[Scene {scene_index}] Found transcript match at {best_match['start']:.1f}s "
                  f"(score: {best_match['score']})", file=sys.stderr)

            result = download_clip(
                video['url'], output_path,
                start_time=best_match['start'],
                duration=seg_duration
            )
        else:
            # No transcript match - download a random segment
            if transcript:
                print(f"[Scene {scene_index}] No keyword match in transcript, using random segment",
                      file=sys.stderr)
            else:
                print(f"[Scene {scene_index}] No transcript available, using random segment",
                      file=sys.stderr)

            result = download_clip(
                video['url'], output_path,
                start_time=None,  # Random
                duration=clip_duration
            )

        if result.get('success'):
            actual_duration = get_clip_duration(result['file_path'])
            result['actual_duration'] = actual_duration if actual_duration > 0 else clip_duration
            result['scene_index'] = scene_index
            result['scene_text'] = scene_text
            result['source_title'] = video.get('title', '')
            result['keyword_match'] = best_match is not None
            return result

        print(f"[Scene {scene_index}] Download failed: {result.get('error')}", file=sys.stderr)

    return {'success': False, 'error': f'Failed to download clip for scene {scene_index}'}


def download_scene_clips(scenes: list[dict], output_dir: str = None,
                         clip_duration: float = 12) -> dict:
    """
    Download gameplay clips for each scene.
    
    Args:
        scenes: List of {text, searchTerms}
        output_dir: Directory to save clips
        clip_duration: Target duration per clip in seconds
    
    Returns:
        dict with list of clips
    """
    if not YT_DLP_AVAILABLE:
        return {
            'success': False,
            'error': 'yt-dlp is not installed. Install with: pip install yt-dlp',
            'clips': [],
            'fallback': True,
        }

    if not scenes:
        return {'success': False, 'error': 'No scenes provided', 'clips': []}

    if not output_dir:
        output_dir = OUTPUT_DIR

    os.makedirs(output_dir, exist_ok=True)

    clips = []
    has_failures = False

    for i, scene in enumerate(scenes):
        text = scene.get('text', '')
        search_terms = scene.get('searchTerms', scene.get('search_terms', []))

        print(f"\n[Scene {i + 1}/{len(scenes)}] {text[:60]}...", file=sys.stderr)
        print(f"  Search terms: {search_terms}", file=sys.stderr)

        result = process_scene(text, search_terms, output_dir, i + 1, clip_duration)
        clips.append(result)

        if not result.get('success'):
            has_failures = True
            print(f"  ✗ Failed: {result.get('error', 'Unknown error')}", file=sys.stderr)
        else:
            print(f"  ✓ Downloaded: {os.path.basename(result['file_path'])} "
                  f"({result.get('actual_duration', 0):.1f}s)", file=sys.stderr)

    successful = [c for c in clips if c.get('success')]

    return {
        'success': len(successful) > 0,
        'clips': clips,
        'successful_clips': successful,
        'total_scenes': len(scenes),
        'successful_count': len(successful),
        'failed_count': len(scenes) - len(successful),
        'has_failures': has_failures,
        'fallback': len(successful) == 0,
    }


if __name__ == '__main__':
    input_data = json.loads(sys.stdin.read())

    scenes = input_data.get('scenes', [])
    output_dir = input_data.get('output_dir')
    clip_duration = input_data.get('clip_duration', 12)

    result = download_scene_clips(scenes, output_dir, clip_duration)
    print(json.dumps(result, indent=2))
