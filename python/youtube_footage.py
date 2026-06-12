"""
YouTube Footage Downloader
Searches YouTube for videos matching scene search terms,
finds the most relevant timestamp via transcript keyword search,
and downloads that segment as a clip.

Features:
- Multi-phase smart filtering (title → metadata → transcript)
- Text overlay detection on downloaded frames (OpenCV/Pillow)
- Copyright risk assessment (channel, duration, view count)
- Aggressive pattern filtering for low-quality content
- Intelligent fallback queries

Dependencies: pip install yt-dlp youtube-transcript-api
Optional: opencv-python (text overlay detection)
"""

import sys
import json
import os
import re
import random
import subprocess
import tempfile
import traceback
import time
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

# Try importing OpenCV for text-overlay detection (optional, degrades gracefully)
try:
    import cv2
    import numpy as np
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False

try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "output", "assets", "videos", "clips")

# ========================================
# Expanded Filtering Patterns
# ========================================

VIDEO_TITLE_BAD_PATTERNS = [
    # --- Combat / violence ---
    r'\bboxing\b', r'\bfight\b', r'\bknockout\b', r'\bmma\b', r'\bbrawl\b',
    r'\bwrestling\b', r'\bwar\b', r'\bweapon\b', r'\bgun\b', r'\bshooting\b',

    # --- Music / audio content ---
    r'\bncs\b', r'\bmusic\b', r'\bsong\b', r'\baudio\b', r'\bremix\b',
    r'\blyrics?\b', r'\bkaraoke\b', r'\bplaylist\b', r'\balbum\b',
    r'\bsoundtrack\b', r'\bcover\b', r'\bbeat\b', r'\binstrumental\b',

    # --- News / current events ---
    r'\bnews\b', r'\breport\b', r'\bbreaking\b', r'\bheadlines?\b',
    r'\bupdate\b', r'\binvestigation\b', r'\bcoverage\b',

    # --- Gaming (usually have text overlays/HUD) ---
    r'\bgameplay\b', r'\bminecraft\b', r'\bgaming\b', r'\blets play\b',
    r'\bgames?\b', r'\bgamer\b', r'\bwalkthrough\b', r'\bgamplay\b',

    # --- Compilation / highlight content (text-heavy) ---
    r'\bhighlights?\b', r'\bbest plays?\b', r'\btop \d+ plays?\b',
    r'\bfunny moments?\b', r'\bcompilation\b', r'\btwitch\b',

    # --- Sports (score overlays) ---
    r'\bsport\b', r'\bmatch\b', r'\btournament\b', r'\bchampionship\b',
    r'\bfootball\b', r'\bbasketball\b', r'\bsoccer\b', r'\bbaseball\b',
    r'\bscore\b', r'\bgoal\b', r'\btouchdown\b', r'\bhighlights\b',

    # --- Tutorial / screencast (text-heavy) ---
    r'\btutorial\b', r'\bguide\b', r'\bhow to\b',
    r'\bscreencast\b', r'\bslides?\b', r'\bpresentation\b',
    r'\bpowerpoint\b', r'\blecture\b', r'\bcourse\b', r'\blesson\b',

    # --- Trailers / teasers (logos, text overlays) ---
    r'\btrailer\b', r'\bteaser\b', r'\bft\.? \b', r'\bprod\.? \b',

    # --- Reaction / Vlog (face cam, text overlays) ---
    r'\breaction\b', r'\breview\b', r'\bvlog\b', r'\bchallenge\b',
    r'\bmukbang\b', r'\bprank\b', r'\bdrunk\b',

    # --- Promotional / ads ---
    r'\bpromo\b', r'\badvertisement\b', r'\bsponsor\b', r'\bsponsored\b',
    r'\bpromotion\b', r'\baffiliate\b',

    # --- Copyright indicators ---
    r'\bfull (movie|episode|video|album|documentary)\b',
    r'\b((all rights )?reserved|copyright|copywritten)\b',
    r'\bmovie clip\b', r'\bfilm clip\b', r'\bscene from\b',
    r'\btv (show|series|episode)\b', r'\bepisode \d+\b',

    # --- Meme / low-effort ---
    r'\bmontage\b', r'\bedit\b', r'\bmeme\b', r'\bfunny\b',
    r'\bstatus\b', r'\bshorts\b', r'\breels\b',
    r'\bparody\b', r'\bspoof\b',

    # --- Text overlay indicators ---
    r'\bsubtitle\b', r'\bcaptions?\b', r'\bcc\b',
    r'\btext (overlay|on screen)\b',
    r'\bpresentation\b', r'\bslideshow\b',
    r'\bamv\b', r'\bfan made\b',

    # --- Visual pollution ---
    r'[\U0001F300-\U0001F9FF]',  # Emoji in title
    r'★|☆|✓|✔|✗|✘|♪|♫|❤|♡',  # Special chars often indicate low quality
]

UPLOADER_BAD_PATTERNS = [
    # --- News / media orgs ---
    r'news\b', r'cnn\b', r'bbc\b', r'fox\b', r'nbc\b', r'abc\b', r'cbs\b',
    r'\bnews', r'msnbc\b', r'al jazeera', r'reuters\b', r'associated press',

    # --- Music / labels ---
    r'\bncs\b', r'no copyright', r'\bmusic\b', r'\brecords?\b',
    r'\blabel\b', r'channel\s+music', r'music\s+channel',

    # --- Gaming ---
    r'\bgames?\b', r'\bgaming\b', r'\bgamer\b', r'\bplays?\b',
    r'\besports?\b', r'\btwitch\b', r'\bstreamer\b',

    # --- Sports ---
    r'\bsports?\b', r'es[pP]n\b', r'\bathletic\b', r'\bfifa\b', r'\bnfl\b',
    r'\bnba\b', r'\bmlb\b', r'\bnhl\b', r'\buefa\b',

    # --- Media / studios (copyright risk) ---
    r'\bofficial\b',  # "Official" channels often have copyrighted content
    r'\btv\b', r'\bnetwork\b',
    r'\bstudios?\b', r'\bpictures\b',
    r'\bfilms?\b', r'\bmovies?\b', r'\bcinema\b',
    r'\bentertainment\b', r'\bproduction\b', r'\bproducer\b',

    # --- Channels reposting content ---
    r'\bclip\b', r'\bclips\b', r'\bcompilation\b',
    r'\breaction\b', r'\bfan[ -]?(made|page)?\b',
    r'\barchive\b', r'\bbest of\b',
    r'\bdaily\b',  # "Daily [topic]" channels often repost
    r'\bpodcast\b',

    # --- Government / educational (boring footage) ---
    r'\bgovernment\b', r'\bofficial\b', r'\bministry\b',
    r'\buniversity\b', r'\bcollege\b', r'\binstitute\b',
]


def sanitize_filename(text: str, max_length: int = 40) -> str:
    """Turn any text into a safe filename fragment."""
    safe = re.sub(r'[^a-zA-Z0-9_\- ]', '', text)
    safe = re.sub(r'\s+', '_', safe.strip())
    return safe[:max_length]


def _is_bad_video(title: str, uploader: str) -> bool:
    """Check if a video is likely unwanted (news, music, gaming, text-heavy, etc.)."""
    title_lower = title.lower()
    uploader_lower = uploader.lower()
    for pat in VIDEO_TITLE_BAD_PATTERNS:
        if re.search(pat, title_lower):
            return True
    for pat in UPLOADER_BAD_PATTERNS:
        if re.search(pat, uploader_lower):
            return True
    return False


# ========================================
# Copyright Risk Assessment
# ========================================

COPYRIGHT_CHANNEL_PATTERNS = [
    r'\bofficial\b', r'\bmusic\b', r'\brecords?\b', r'\blabel\b',
    r'\btv\b', r'\bnetwork\b', r'\bstudio\b', r'\bentertainment\b',
    r'\bfilms?\b', r'\bmovies?\b', r'\bpictures\b', r'\bproduction\b',
    r'\bproducer\b', r'\bcopyright\b', r'\bmedia\b',
    r'\bcompany\b', r'\bcorp\b', r'\binc\b',
]

COPYRIGHT_DESCRIPTION_PATTERNS = [
    r'\bcopyright\b', r'\b(all rights )?reserved\b',
    r'\bdo not (own|claim)\b', r'\bfair use\b',
    r'\bno (copyright )?infringement\b',
    r'\bowned by\b', r'\bproperty of\b',
    r'\blicensed to\b', r'\bexclusive\b',
    r'\bmusic (video|promo)\b', r'\bofficial (video|music)\b',
    r'\bwatch in (hd|4k|1080p)\b',
]


def _is_copyright_risk(video_info: dict) -> bool:
    """
    Assess copyright risk based on channel name, video duration, view count,
    and description content.
    Returns True if the video is high-risk.
    """
    uploader = (video_info.get('uploader') or '').lower()
    title = (video_info.get('title') or '').lower()
    description = (video_info.get('description') or '').lower()
    duration = video_info.get('duration', 0) or 0
    view_count = video_info.get('view_count', 0) or 0

    # Channel name patterns
    for pat in COPYRIGHT_CHANNEL_PATTERNS:
        if re.search(pat, uploader):
            print(f"  [copyright] Skipped by channel pattern '{pat}': {uploader}", file=sys.stderr)
            return True

    # Very long videos (> 30 min) are likely full episodes/movies
    if duration > 1800:
        print(f"  [copyright] Skipped by duration ({duration}s > 1800s)", file=sys.stderr)
        return True

    # Extremely short videos (< 20 seconds) are often clips with text overlays
    if 0 < duration < 20:
        print(f"  [copyright] Skipped by short duration ({duration}s < 20s)", file=sys.stderr)
        return True

    # Very high view count = more likely copyrighted content
    if view_count > 5_000_000:
        print(f"  [copyright] Skipped by high view count ({view_count})", file=sys.stderr)
        return True

    # Description patterns
    for pat in COPYRIGHT_DESCRIPTION_PATTERNS:
        if re.search(pat, description):
            print(f"  [copyright] Skipped by description pattern '{pat}'", file=sys.stderr)
            return True

    # Title patterns that indicate copyrighted content
    copyright_title_patterns = [
        r'\bfull (movie|episode|album|documentary|video)\b',
        r'\bmovie clip\b', r'\bscene from\b',
        r'\btv (show|series|episode)\b', r'\bepisode \d+\b',
        r'\bofficial (video|music|trailer)\b',
    ]
    for pat in copyright_title_patterns:
        if re.search(pat, title):
            print(f"  [copyright] Skipped by title pattern '{pat}': {title[:60]}", file=sys.stderr)
            return True

    return False


# ========================================
# Text Overlay Detection
# ========================================


def _detect_text_overlay_on_frames(frame_paths: list[str]) -> dict:
    """
    Analyze video frames for text overlay presence using lightweight heuristics.
    
    Uses OpenCV if available (edge detection + text region analysis).
    Falls back to Pillow-only analysis (simpler, less accurate).
    
    Returns:
        {'text_detected': bool, 'confidence': float, 'reason': str}
    """
    if not frame_paths:
        return {'text_detected': False, 'confidence': 0.0, 'reason': 'no frames'}

    if CV2_AVAILABLE:
        return _detect_text_opencv(frame_paths)
    elif PIL_AVAILABLE:
        return _detect_text_pil(frame_paths)
    else:
        return {'text_detected': False, 'confidence': 0.0, 'reason': 'no image library'}


def _detect_text_opencv(frame_paths: list[str]) -> dict:
    """
    Text overlay detection using OpenCV.
    
    Strategy:
    1. Convert to grayscale
    2. Apply Sobel edge detection
    3. Measure edge density in different regions
    4. Natural scenes: edges spread uniformly across frame
       Text overlays: concentrated edges in bottom/top regions
    
    Additionally checks:
    - Color saturation in text regions (text = low saturation)
    - Horizontal line patterns (subtitle bars)
    - Histogram of edges by row
    """
    try:
        import numpy as np
    except ImportError:
        return {'text_detected': False, 'confidence': 0.0, 'reason': 'numpy not available'}

    text_scores = []

    for fp in frame_paths:
        if not os.path.exists(fp):
            continue

        try:
            img = cv2.imread(fp)
            if img is None:
                continue

            h, w = img.shape[:2]
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

            # 1. Edge detection using Sobel
            sobel_x = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
            sobel_y = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
            edges = np.sqrt(sobel_x ** 2 + sobel_y ** 2)

            # 2. Divide frame into 4 horizontal bands
            bands = {
                'top': edges[0:h // 4, :],
                'upper_mid': edges[h // 4:h // 2, :],
                'lower_mid': edges[h // 2:3 * h // 4, :],
                'bottom': edges[3 * h // 4:h, :],
            }

            mean_edge = edges.mean()
            band_ratios = {}

            for name, band in bands.items():
                band_mean = band.mean()
                ratio = band_mean / max(mean_edge, 0.01)
                band_ratios[name] = ratio

            # 3. Check for text-heavy indicators:
            # - Bottom-heavy edges (subtitle text)
            # - Top-heavy edges (title text)
            # - High edge density overall (complex text overlay)
            bottom_ratio = band_ratios.get('bottom', 1.0)
            top_ratio = band_ratios.get('top', 1.0)

            # 4. Also check color saturation in bottom region
            bottom_region = img[3 * h // 4:h, :, :]
            hsv_bottom = cv2.cvtColor(bottom_region, cv2.COLOR_BGR2HSV)
            sat_bottom = hsv_bottom[:, :, 1].mean() / 255.0  # 0 = gray, 1 = vibrant
            sat_whole = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[:, :, 1].mean() / 255.0

            # 5. Check for horizontal line patterns (subtitle bars)
            # Sum edge responses horizontally to find continuous lines
            row_edges = np.sum(edges, axis=1)
            row_mean = row_edges.mean()
            # Count rows with significantly above-average edges
            hot_rows = np.sum(row_edges > row_mean * 2.5)

            # Scoring
            frame_score = 0.0

            # Bottom-heavy edges suggest subtitle text
            if bottom_ratio > 1.8:
                frame_score += 0.3
            elif bottom_ratio > 1.4:
                frame_score += 0.15

            # Top-heavy edges suggest title text
            if top_ratio > 1.8:
                frame_score += 0.2
            elif top_ratio > 1.4:
                frame_score += 0.1

            # Low saturation in bottom region suggests text on background
            if sat_bottom < 0.15 and sat_whole > 0.2:
                frame_score += 0.25
            elif sat_bottom < 0.1:
                frame_score += 0.35

            # Many hot rows = complex overlay
            if hot_rows > h * 0.4:  # > 40% of rows have text-like edges
                frame_score += 0.2
            elif hot_rows > h * 0.25:
                frame_score += 0.1

            # Clip score to [0, 1]
            frame_score = min(frame_score, 1.0)
            text_scores.append(frame_score)

        except Exception:
            continue

    if not text_scores:
        return {'text_detected': False, 'confidence': 0.0, 'reason': 'no frames processed'}

    avg_score = sum(text_scores) / len(text_scores)
    max_score = max(text_scores)

    # If ANY frame has a very high score, flag it
    if max_score > 0.7:
        return {
            'text_detected': True,
            'confidence': max_score,
            'reason': f'text overlay detected (max={max_score:.2f}, avg={avg_score:.2f})',
            'frame_scores': text_scores,
        }

    if avg_score > 0.45:
        return {
            'text_detected': True,
            'confidence': avg_score,
            'reason': f'text overlay suspected (avg={avg_score:.2f})',
            'frame_scores': text_scores,
        }

    return {
        'text_detected': False,
        'confidence': avg_score,
        'reason': f'no text overlay (avg={avg_score:.2f}, max={max_score:.2f})',
        'frame_scores': text_scores,
    }


def _detect_text_pil(frame_paths: list[str]) -> dict:
    """
    Text overlay detection using only Pillow (no OpenCV needed).
    
    Uses pixel-difference edge detection and region analysis.
    Less accurate than OpenCV version but still useful.
    """
    try:
        import numpy as np
    except ImportError:
        return {'text_detected': False, 'confidence': 0.0, 'reason': 'numpy not available'}

    text_scores = []

    for fp in frame_paths:
        if not os.path.exists(fp):
            continue

        try:
            img = Image.open(fp).convert('RGB')
            arr = np.array(img)
            h, w = arr.shape[:2]

            # Convert to grayscale
            gray = arr.mean(axis=2).astype(float)

            # Simple edge detection: gradient in x and y directions
            grad_x = np.abs(np.diff(gray, axis=1))
            grad_y = np.abs(np.diff(gray, axis=0))

            # Pad back to original size
            grad_x = np.pad(grad_x, ((0, 0), (0, 1)), 'constant')
            grad_y = np.pad(grad_y, ((0, 1), (0, 0)), 'constant')

            edges = np.sqrt(grad_x ** 2 + grad_y ** 2)
            mean_edge = edges.mean()

            # Analyze bottom quarter and top quarter
            bottom = edges[3 * h // 4:, :]
            top = edges[:h // 4, :]
            middle = edges[h // 4:3 * h // 4, :]

            bottom_mean = bottom.mean()
            top_mean = top.mean()
            middle_mean = middle.mean()

            # Text regions have higher edge density than natural regions
            bottom_ratio = bottom_mean / max(mean_edge, 0.01)
            top_ratio = top_mean / max(mean_edge, 0.01)

            # Also check color variance (text areas = low variance)
            var_bottom = arr[3 * h // 4:, :, :].std(axis=(0, 1)).mean()
            var_middle = arr[h // 4:3 * h // 4, :, :].std(axis=(0, 1)).mean()

            frame_score = 0.0

            if bottom_ratio > 2.0:
                frame_score += 0.3
            elif bottom_ratio > 1.5:
                frame_score += 0.15

            if top_ratio > 2.0:
                frame_score += 0.2

            # If bottom has less color variance than middle (text = uniform bg)
            if var_bottom < var_middle * 0.6 and middle_mean > 10:
                frame_score += 0.3
            elif var_bottom < var_middle * 0.8:
                frame_score += 0.15

            frame_score = min(frame_score, 1.0)
            text_scores.append(frame_score)

        except Exception:
            continue

    if not text_scores:
        return {'text_detected': False, 'confidence': 0.0, 'reason': 'no frames processed'}

    avg_score = sum(text_scores) / len(text_scores)
    max_score = max(text_scores)

    if max_score > 0.75:
        return {
            'text_detected': True,
            'confidence': max_score,
            'reason': f'text overlay detected via PIL (max={max_score:.2f})',
            'frame_scores': text_scores,
        }

    return {
        'text_detected': False,
        'confidence': avg_score,
        'reason': f'no text overlay via PIL (avg={avg_score:.2f})',
        'frame_scores': text_scores,
    }


def _extract_video_frames(video_path: str, num_frames: int = 3) -> list[str]:
    """
    Extract frames from a video file for text overlay analysis.
    Samples evenly spaced frames.
    
    Returns list of temporary frame file paths.
    """
    ffmpeg_path = _get_ffmpeg_path()
    ffprobe_path = _get_ffprobe_path()
    duration = _get_actual_duration(ffprobe_path, video_path)
    if not duration or duration <= 0:
        duration = 15

    frame_paths = []
    for i in range(num_frames):
        # Sample at 20%, 50%, 80% through the clip
        timestamp = duration * (0.2 + i * 0.3)
        frame_path = os.path.join(tempfile.gettempdir(),
                                  f"frame_{os.getpid()}_{i}_{os.path.basename(video_path)}.jpg")

        cmd = [
            ffmpeg_path, '-y',
            '-ss', str(timestamp),
            '-i', video_path,
            '-vframes', '1',
            '-q:v', '2',
            frame_path
        ]
        try:
            subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            if os.path.exists(frame_path) and os.path.getsize(frame_path) > 1000:
                frame_paths.append(frame_path)
        except Exception:
            pass

    return frame_paths


def _cleanup_frames(frame_paths: list[str]):
    """Clean up temporary frame files."""
    for fp in frame_paths:
        try:
            if os.path.exists(fp):
                os.remove(fp)
        except Exception:
            pass


# ========================================
# Video Metadata Fetching
# ========================================


def _fetch_video_full_info(video_id: str) -> dict | None:
    """
    Fetch full metadata for a specific video including description, view count, etc.
    Returns dict with full info or None on failure.
    """
    if not YT_DLP_AVAILABLE:
        return None

    try:
        url = f"https://youtube.com/watch?v={video_id}"
        with yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True}) as ydl:
            info = ydl.extract_info(url, download=False)
            return info
    except Exception as e:
        print(f"  [metadata] Failed to fetch full info for {video_id}: {e}", file=sys.stderr)
        return None


def _check_video_description(description: str) -> bool:
    """
    Check video description for indicators of text-heavy or low-quality content.
    Returns True if the video should be skipped.
    """
    if not description:
        return False

    desc_lower = description.lower()

    # Patterns that indicate text-heavy/slideshow content
    text_indicators = [
        r'\bchapter\b', r'\btimestamp\b', r'\bslide\b',
        r'\bdownload (link|pdf|slides)\b',
        r'\bcheck (description|below)\b', r'\blink in description\b',
    ]

    for pat in text_indicators:
        if re.search(pat, desc_lower):
            print(f"  [description] Skipped by pattern '{pat}'", file=sys.stderr)
            return True

    return False


# ========================================
# Main Search Function
# ========================================


def search_youtube(query: str, max_results: int = 8) -> list[dict]:
    """
    Search YouTube using yt-dlp's extractor (no API key needed).
    
    Two-phase filtering:
    1. Quick title/uploader pattern check on flat search results
    2. Deep metadata fetch + copyright/description check for top candidates
       (with graceful fallback when metadata fetch fails)
    
    Includes 1 retry on transient failures.
    
    Returns list of {id, title, url, duration, uploader, view_count}.
    """
    if not YT_DLP_AVAILABLE:
        return []

    def _do_search() -> list[dict]:
        """Inner search function with retry support."""
        # Phase 1: Broad flat search with title/uploader filtering
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'extract_flat': True,
            'force_generic_extractor': False,
        }

        # Fetch extra results so we can filter aggressively
        candidate_pool = max_results * 2 + 6
        search_query = f"ytsearch{candidate_pool}:{query}"

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(search_query, download=False)
            if not info or 'entries' not in info:
                return []

            candidates = []
            for entry in info['entries']:
                if not entry:
                    continue
                title = entry.get('title', '')
                uploader = entry.get('uploader', '')
                duration = entry.get('duration', 0) or 0

                if _is_bad_video(title, uploader):
                    continue

                candidates.append({
                    'id': entry.get('id', ''),
                    'title': title,
                    'url': f"https://youtube.com/watch?v={entry.get('id', '')}",
                    'duration': duration,
                    'uploader': uploader,
                })

        if not candidates:
            return []

        # Phase 2: Fetch full metadata for top candidates and deep-filter
        # Use a smaller pool than phase 1 to avoid excessive network calls
        deep_check_limit = min(len(candidates), max_results + 3)
        final_results = []

        for candidate in candidates[:deep_check_limit]:
            full_info = _fetch_video_full_info(candidate['id'])

            if full_info is None:
                # Metadata fetch failed — let the candidate through with
                # phase 1 data only (skip deep checks that need description)
                # This prevents transient yt-dlp errors from zeroing results
                print(f"  [search] Metadata fetch failed for {candidate['id']}, "
                      f"allowing through with phase-1 check only", file=sys.stderr)
                final_results.append(candidate)
                if len(final_results) >= max_results:
                    break
                continue

            # Enrich candidate with full metadata
            candidate['view_count'] = full_info.get('view_count', 0) or 0
            candidate['description'] = (full_info.get('description', '') or '')[:1000]
            candidate['categories'] = full_info.get('categories', []) or []
            candidate['age_limit'] = full_info.get('age_limit', 0) or 0
            candidate['like_count'] = full_info.get('like_count', 0) or 0

            # Deep filters (only run when we have full metadata)
            if _is_copyright_risk({
                'uploader': candidate['uploader'],
                'title': candidate['title'],
                'description': candidate['description'],
                'duration': candidate['duration'],
                'view_count': candidate['view_count'],
            }):
                continue

            if _check_video_description(candidate['description']):
                continue

            # Age-restricted content
            if candidate['age_limit'] > 0:
                continue

            final_results.append(candidate)
            if len(final_results) >= max_results:
                break

        return final_results

    # Try search with 1 retry on transient failure
    for attempt in range(2):
        try:
            return _do_search()
        except Exception as e:
            if attempt == 0:
                print(f"[youtube_footage] Search attempt {attempt + 1} failed: {e}. "
                      f"Retrying once...", file=sys.stderr)
                time.sleep(2)
            else:
                print(f"[youtube_footage] Search failed after retry: {e}", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)
                return []


# ========================================
# Transcript & Keyword Functions
# ========================================


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
    except Exception:
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
        score = 1
        if w in [t.lower() for t in search_terms]:
            score += 3
        if w[0].isupper() and w in combined:
            score += 2
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
    window_size = 3

    for i in range(len(transcript) - window_size + 1):
        window = transcript[i:i + window_size]
        window_text = ' '.join(seg['text'].lower() for seg in window)

        score = 0
        for kw in keywords:
            if kw.lower() in window_text:
                score += 1

        if score > best_score:
            best_score = score
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


# ========================================
# Download Functions
# ========================================


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
    """Download a segment from a stream URL using ffmpeg input seeking."""
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
    """
    if not YT_DLP_AVAILABLE:
        return {'success': False, 'error': 'yt-dlp not installed'}

    out_dir = os.path.dirname(output_path)
    os.makedirs(out_dir, exist_ok=True)

    ffmpeg_path = _get_ffmpeg_path()
    ffprobe_path = _get_ffprobe_path()

    if start_time is None:
        start_time = 30 + random.random() * 60

    end_time = start_time + duration
    temp_files = []

    try:
        with yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True}) as ydl:
            info = ydl.extract_info(video_url, download=False)

        formats = info.get('formats', [])

        # Prefer combined formats (simpler, better quality)
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
            result = _download_segment(
                ffmpeg_path, combined_fmt['url'], start_time, end_time, output_path
            )
            if result.returncode == 0 and os.path.exists(output_path):
                file_size = os.path.getsize(output_path)
                actual_dur = _get_actual_duration(ffprobe_path, output_path) or duration
                return _clip_success(output_path, file_size, actual_dur,
                                     duration, start_time, info.get('title', ''))

        # DASH fallback
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
                if height > best_height:
                    video_fmt = fmt
                    best_height = height
            elif vcodec == 'none' and acodec != 'none':
                if audio_fmt is None or (fmt.get('abr', 0) or 0) > (audio_fmt.get('abr', 0) or 0):
                    audio_fmt = fmt

        if not video_fmt or not audio_fmt:
            return {'success': False, 'error': 'No suitable format found (no combined or DASH streams)'}

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

        merge_result = _merge_av(ffmpeg_path, temp_video, temp_audio, output_path)
        if merge_result.returncode != 0 or not os.path.exists(output_path):
            return {'success': False, 'error': f'Failed to merge streams: {merge_result.stderr[:200]}'}

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


MIN_CLIP_SIZE = 51200  # 50KB minimum for a valid video clip


def _clip_success(file_path: str, file_size: int, actual_duration: float,
                  target_duration: float, start_time: float,
                  source_title: str) -> dict:
    """Build a success response dict for a downloaded clip.
    Rejects files that are too small to be valid video clips.
    """
    if file_size < MIN_CLIP_SIZE:
        print(f"[youtube_footage] Rejecting clip: too small ({file_size} bytes < {MIN_CLIP_SIZE})", file=sys.stderr)
        return {'success': False, 'error': f'Clip too small ({file_size} bytes)'}
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


def _build_search_query(scene_text: str, search_terms: list[str],
                        keywords: list[str]) -> str:
    """
    Build a YouTube-search-friendly query from scene text and search terms.

    Strategy:
    1. Try extracting key named entities and topic words from the scene text
       (the spoken narration is the BEST source of searchable keywords)
    2. Fall back to search terms if scene text is too short
    3. Last resort: use extracted keywords or generic fallback

    This is critical because the AI now generates visual scene descriptions
    (e.g. "dark rainy window calm atmosphere") which are TERRIBLE for YouTube
    search — we need the actual topic (e.g. "Call of Duty Mobile drone").
    """
    # Step 1: Extract the best searchable words from scene text
    # Scene text is the spoken narration: "The killer drone in Call of Duty Mobile..."
    # We want: key nouns, capitalized names, topic words
    text_lower = scene_text.lower()


    # Extract capitalized phrases (proper nouns, game names, brands)
    proper_nouns = re.findall(r'\\b[A-Z][a-z]+\\s[A-Z][a-z]+\\b', scene_text)
    # Also grab any word that starts with a capital letter (excluding sentence starts)
    capital_words = []
    words = scene_text.split()
    for i, w in enumerate(words):
        if w[0].isupper() and i > 0 and len(w) > 2:
            capital_words.append(w.lower())

    # Score words from scene text: proper nouns > capital words > long words
    word_scores = {}

    # Proper nouns get highest priority
    for pn in proper_nouns:
        pn_lower = pn.lower()
        word_scores[pn_lower] = word_scores.get(pn_lower, 0) + 5

    # Capitalized words (topic indicators)
    for cw in capital_words:
        word_scores[cw] = word_scores.get(cw, 0) + 3

    # All words from text (filtered)
    all_words = re.findall(r'\\b[a-zA-Z]{3,}\\b', text_lower)
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
                  'right', 'old', 'big', 'high', 'different', 'small', 'large',
                  'really', 'actually', 'quite', 'pretty', 'basically', 'literally',
                  'even', 'still', 'already', 'yet', 'just', 'now', 'also', 'ever'}

    for w in all_words:
        if w not in stop_words:
            word_scores[w] = word_scores.get(w, 0) + 1

    # Sort by score
    sorted_words = sorted(word_scores.items(), key=lambda x: -x[1])
    top_words = [w for w, s in sorted_words[:6]]

    # If we got meaningful words from scene text, use them
    if len(top_words) >= 2:
        query_from_text = ' '.join(top_words[:4])
        # Only use if query looks searchable (has more than just filler words)
        if len(query_from_text.split()) >= 2:
            return query_from_text

    # Step 2: Fall back to search terms (for very short scene texts)
    if search_terms:
        # If search terms are long visual descriptions (> 4 words each),
        # extract the most concrete/searchable words from them
        all_search_words = ' '.join(search_terms).lower()
        search_word_list = re.findall(r'\\b[a-zA-Z]{3,}\\b', all_search_words)
        # Filter out generic visual-description words
        visual_words = {'view', 'scene', 'shot', 'angle', 'close', 'up', 'look', 'feel', 'mood',
                        'aerial', 'footage', 'broll', 'stock', 'atmosphere', 'lighting', 'background',
                        'foreground', 'ambient', 'setting', 'environment', 'cinematic', 'slow motion',
                        'closeup', 'wide', 'reaction', 'detail', 'frame', 'clip', 'video', 'view',
                        'top', 'bottom', 'side', 'front', 'back', 'overhead', 'underneath', 'behind',
                        'dark', 'bright', 'dim', 'soft', 'warm', 'cool', 'vibrant', 'muted', 'pale'}
        concrete_words = [w for w in search_word_list if w not in visual_words]
        if concrete_words:
            return ' '.join(concrete_words[:4])
        # If all words are visual, just use first 2 search terms
        return ' '.join(search_terms[:2])

    # Step 3: Use extracted keywords
    if keywords:
        return ' '.join(keywords[:3])

    # Final fallback
    return 'stock footage b roll'


def process_scene(scene_text: str, search_terms: list[str],
                  output_dir: str, scene_index: int,
                  clip_duration: float = 12) -> dict:
    """
    Process a single scene: find and download a relevant clip.

    Steps:
    1. Extract keywords and build search query
    2. Search YouTube with aggressive multi-phase filtering
    3. Try multiple query variations if first search fails
    4. Fetch transcripts and find best timestamp
    5. Download segment
    6. Post-download: check for text overlays using frame analysis

    Returns dict with clip info or fallback.
    """
    keywords = extract_keywords(scene_text, search_terms)
    query = _build_search_query(scene_text, search_terms, keywords)

    if not query:
        query = 'stock footage b roll'

    print(f"[Scene {scene_index}] Searching: '{query}'", file=sys.stderr)
    videos = search_youtube(query, max_results=5)

    # Try fallback queries if first search yields nothing
    if not videos:
        fallback_queries = _generate_fallback_queries(scene_text, search_terms, keywords)
        for alt_query in fallback_queries:
            print(f"[Scene {scene_index}] No clean results for primary query, "
                  f"trying: '{alt_query}'", file=sys.stderr)
            videos = search_youtube(alt_query, max_results=5)
            if videos:
                print(f"[Scene {scene_index}] Found {len(videos)} results with "
                      f"fallback query", file=sys.stderr)
                break

    if not videos:
        print(f"[Scene {scene_index}] No videos found for any query variation",
              file=sys.stderr)
        return {'success': False, 'error': f'No videos found for: {query}',
                'query_tried': query}

    # Shuffle to avoid always picking the same channels
    random.shuffle(videos)

    for video in videos[:3]:  # Try top 3 results
        vid_id = video['id']
        print(f"[Scene {scene_index}] Trying video: {video['title'][:60]}", file=sys.stderr)

        # Fetch transcript
        transcript = fetch_transcript(vid_id)
        best_match = None

        if transcript:
            best_match = find_best_timestamp(transcript, keywords)

        output_path = os.path.join(
            output_dir,
            f"scene_{scene_index:03d}_{sanitize_filename(query)}_{vid_id}.mp4"
        )

        if best_match and best_match['score'] >= 1:
            seg_duration = min(clip_duration, best_match['end'] - best_match['start'])
            seg_duration = max(seg_duration, 5)
            print(f"[Scene {scene_index}] Found transcript match at {best_match['start']:.1f}s "
                  f"(score: {best_match['score']})", file=sys.stderr)

            result = download_clip(
                video['url'], output_path,
                start_time=best_match['start'],
                duration=seg_duration
            )
        else:
            if transcript:
                print(f"[Scene {scene_index}] No keyword match in transcript, "
                      f"using random segment", file=sys.stderr)
            else:
                print(f"[Scene {scene_index}] No transcript available, "
                      f"using random segment", file=sys.stderr)

            result = download_clip(
                video['url'], output_path,
                start_time=None,
                duration=clip_duration
            )

        if result.get('success'):
            actual_duration = get_clip_duration(result['file_path'])
            result['actual_duration'] = actual_duration if actual_duration > 0 else clip_duration

            # Post-download: check for text overlays
            print(f"[Scene {scene_index}] Checking for text overlays...", file=sys.stderr)
            frames = _extract_video_frames(result['file_path'], num_frames=3)
            if frames:
                text_check = _detect_text_overlay_on_frames(frames)
                _cleanup_frames(frames)

                result['text_overlay_check'] = text_check

                if text_check.get('text_detected'):
                    # Include raw metrics for debugging
                    raw_scores = text_check.get('frame_scores', [])
                    scores_str = f"scores={','.join(f'{s:.2f}' for s in raw_scores[:3])}" if raw_scores else ""
                    print(f"[Scene {scene_index}] ⚠ Text overlay detected "
                          f"(confidence: {text_check['confidence']:.2f}, {scores_str}) — "
                          f"will use as fallback only", file=sys.stderr)
                    # Still mark as success, but flag it
                    result['text_overlay_risk'] = True
                else:
                    print(f"[Scene {scene_index}] ✓ No text overlay detected "
                          f"({text_check['reason']})", file=sys.stderr)
                    result['text_overlay_risk'] = False

            result['scene_index'] = scene_index
            result['scene_text'] = scene_text
            result['source_title'] = video.get('title', '')
            result['keyword_match'] = best_match is not None
            return result

        print(f"[Scene {scene_index}] Download failed: {result.get('error')}",
              file=sys.stderr)

    return {'success': False, 'error': f'Failed to download clip for scene {scene_index}'}


def _generate_fallback_queries(scene_text: str, search_terms: list[str],
                                keywords: list[str]) -> list[str]:
    """
    Generate alternative search queries when the primary search fails.

    Tries different combinations and qualifiers.
    """
    queries = []

    # 1. Try without "b roll" qualifier
    if search_terms:
        queries.append(' '.join(search_terms[:2]))

    # 2. Try with "stock footage" qualifier
    if search_terms:
        queries.append(f"{' '.join(search_terms[:2])} stock footage")
    elif keywords:
        queries.append(f"{' '.join(keywords[:2])} stock footage")

    # 3. Try with common stock footage keywords based on scene type
    scene_lower = scene_text.lower()
    if any(w in scene_lower for w in ['people', 'person', 'man', 'woman', 'someone']):
        queries.append('people stock footage')
    if any(w in scene_lower for w in ['nature', 'outdoor', 'outside', 'tree', 'mountain']):
        queries.append('nature b roll footage')
    if any(w in scene_lower for w in ['city', 'urban', 'street', 'building']):
        queries.append('city b roll stock')
    if any(w in scene_lower for w in ['dark', 'night', 'shadow', 'dim']):
        queries.append('dark atmospheric b roll')
    if any(w in scene_lower for w in ['light', 'sun', 'bright', 'sunlight']):
        queries.append('sunlight b roll stock')
    if any(w in scene_lower for w in ['office', 'work', 'business', 'desk']):
        queries.append('office b roll corporate')
    if any(w in scene_lower for w in ['food', 'cook', 'kitchen', 'eat']):
        queries.append('food cooking b roll')
    if any(w in scene_lower for w in ['water', 'ocean', 'sea', 'river', 'rain']):
        queries.append('water nature b roll')
    if any(w in scene_lower for w in ['technology', 'tech', 'computer', 'digital', 'screen']):
        queries.append('technology b roll stock')
    if any(w in scene_lower for w in ['health', 'fitness', 'exercise', 'gym', 'workout']):
        queries.append('fitness exercise b roll')

    # 5. Absolute fallback
    queries.append('atmospheric b roll stock footage')

    # Remove duplicates and empty queries
    seen = set()
    unique = []
    for q in queries:
        q_clean = q.strip()
        if q_clean and q_clean not in seen:
            seen.add(q_clean)
            unique.append(q_clean)

    return unique[:5]  # Max 5 fallback queries


def download_scene_clips(scenes: list[dict], output_dir: str = None,
                         clip_duration: float = 12) -> dict:
    """
    Download clips for each scene.

    Args:
        scenes: List of {text, searchTerms}
        output_dir: Directory to save clips
        clip_duration: Target duration per clip in seconds

    Returns:
        dict with list of clips and metadata about failures
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
    text_overlay_flagged = 0

    for i, scene in enumerate(scenes):
        text = scene.get('text', '')
        search_terms = scene.get('searchTerms', scene.get('search_terms', []))

        print(f"\n[Scene {i + 1}/{len(scenes)}] {text[:60]}...", file=sys.stderr)
        print(f"  Search terms: {search_terms}", file=sys.stderr)

        result = process_scene(text, search_terms, output_dir, i + 1, clip_duration)
        clips.append(result)

        if not result.get('success'):
            print(f"  ✗ Failed: {result.get('error', 'Unknown error')}", file=sys.stderr)
        else:
            text_risk = result.get('text_overlay_risk', False)
            if text_risk:
                text_overlay_flagged += 1
                print(f"  ✓ Downloaded (⚠ text overlay): "
                      f"{os.path.basename(result['file_path'])} "
                      f"({result.get('actual_duration', 0):.1f}s)", file=sys.stderr)
            else:
                print(f"  ✓ Downloaded: {os.path.basename(result['file_path'])} "
                      f"({result.get('actual_duration', 0):.1f}s)", file=sys.stderr)

    successful = [c for c in clips if c.get('success')]

    # Sort successful clips: prefer clips WITHOUT text overlays
    clean_clips = [c for c in successful if not c.get('text_overlay_risk')]
    risky_clips = [c for c in successful if c.get('text_overlay_risk')]
    ordered_clips = clean_clips + risky_clips

    return {
        'success': len(successful) > 0,
        'clips': clips,
        'successful_clips': ordered_clips,
        'total_scenes': len(scenes),
        'successful_count': len(successful),
        'failed_count': len(scenes) - len(successful),
        'text_overlay_flagged': text_overlay_flagged,
        'has_failures': len(clean_clips) < len(scenes),
        'fallback': len(clean_clips) == 0,
    }


if __name__ == '__main__':
    input_data = json.loads(sys.stdin.read())

    scenes = input_data.get('scenes', [])
    output_dir = input_data.get('output_dir')
    clip_duration = input_data.get('clip_duration', 12)

    result = download_scene_clips(scenes, output_dir, clip_duration)
    print(json.dumps(result, indent=2))
