#!/usr/bin/env python3
"""
Gemini Story Video Generator
============================
Drives the Gemini bridge: enqueues scene prompts, waits for the browser
extension to deliver generated images via the bridge, then assembles the
final video using ffmpeg_video.py.

If only partial images are received (e.g., due to rate limits), the script
saves whatever it got, reports partial success back to the orchestrator so
the user can manually upload missing images later and continue.
"""

import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

BRIDGE_BASE = os.environ.get('GEMINI_BRIDGE_URL', 'http://127.0.0.1:3001')


def log(msg: str) -> None:
    print(f'[gemini_story] {msg}', file=sys.stderr, flush=True)


def bridge_get(path: str, timeout: int = 30) -> dict:
    with urllib.request.urlopen(f'{BRIDGE_BASE}{path}', timeout=timeout) as resp:
        return json.loads(resp.read())


def bridge_post(path: str, body: dict) -> dict:
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(
        f'{BRIDGE_BASE}{path}',
        data=data,
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def main() -> int:
    try:
        input_data = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        log(f'Invalid input JSON: {e}')
        return 1

    workflow_id = input_data['workflowId']
    scenes = input_data['scenes']
    audio_path = input_data['audio_path']
    output_filename = input_data['output_filename']
    resolution = input_data.get('resolution', '768x432')
    fps = input_data.get('fps', 10)

    if not scenes:
        log('No scenes provided — nothing to do')
        return 1

    n = len(scenes)
    log(f'Received {n} scene(s) for workflow {workflow_id}')

    # 1. Enqueue prompts to Gemini bridge
    try:
        bridge_post('/gemini-bridge/enqueue', {
            'workflowId': workflow_id,
            'prompts': [{'sceneIndex': s['sceneIndex'], 'prompt': s['prompt']} for s in scenes],
        })
    except (urllib.error.URLError, ConnectionError) as e:
        log(f'Bridge unreachable: {e}')
        return 1

    log(f'Enqueued {n} prompt(s). Waiting for extension to deliver images...')

    # 2. Await images — blocks until extension posts all results or timeout
    try:
        resp = bridge_get(
            f'/gemini-bridge/await-images?workflowId={workflow_id}&expected={n}&timeoutMs=1800000',
            timeout=1800
        )
    except urllib.error.HTTPError as e:
        log(f'await-images failed: HTTP {e.code}: {e.read().decode()}')
        return 1

    images = resp.get('images', [])
    is_partial = resp.get('partial', False)
    actual = len(images)

    if is_partial or actual < n:
        log(f'Got {actual}/{n} images ({"partial" if is_partial else "bridge returned fewer than expected"})')

    if actual == 0:
        log('No images received — cannot assemble video')
        return 1

    # 3. Save images to disk
    scenes_dir = os.path.join(os.path.dirname(output_filename), '..', 'scenes', workflow_id)
    scenes_dir = os.path.abspath(scenes_dir)
    os.makedirs(scenes_dir, exist_ok=True)

    for img in images:
        scene_index = img['sceneIndex']
        slug = f'scene_{scene_index:04d}'
        out_path = os.path.join(scenes_dir, f'{slug}.png')
        with open(out_path, 'wb') as f:
            f.write(base64.b64decode(img['base64']))
        log(f'Saved {out_path}')

    log(f'Saved {actual}/{n} images to {scenes_dir}')

    # 4. Try to assemble video with ffmpeg_video.py
    #    If this fails (e.g., partial images cause gaps), we still report
    #    partial success — the orchestrator will save the images and pause
    #    so the user can upload remaining scenes manually.
    log(f'Attempting ffmpeg_video.py assembly (resolution={resolution}, fps={fps})...')
    ffmpeg_proc = subprocess.run(
        [sys.executable, 'ffmpeg_video.py',
         '--images', scenes_dir,
         '--audio', audio_path,
         '--output', output_filename,
         '--resolution', resolution,
         '--fps', str(fps),
         '--subtitles', 'true'],
        capture_output=True,
        text=True,
    )

    if ffmpeg_proc.returncode != 0:
        log(f'ffmpeg_video.py failed (expected with partial images): {ffmpeg_proc.stderr[:500]}')
        # Return partial success — images are saved, orchestrator will pause
        print(json.dumps({
            'success': True,
            'partial': True,
            'file_path': output_filename,
            'scenes_dir': scenes_dir,
            'images_saved': actual,
            'images_expected': n,
            'message': f'Saved {actual}/{n} images. Video assembly deferred.',
        }))
        return 0

    # Parse ffmpeg_video.py output
    try:
        result = json.loads(ffmpeg_proc.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError) as e:
        log(f'Could not parse ffmpeg_video.py output: {e}')
        # Return partial success anyway
        print(json.dumps({
            'success': True,
            'partial': True,
            'file_path': output_filename,
            'scenes_dir': scenes_dir,
            'images_saved': actual,
            'images_expected': n,
            'message': f'Video assembly output unparseable but {actual} images saved.',
        }))
        return 0

    if not result.get('success'):
        log(f'ffmpeg_video.py reported failure: {result.get("error", "unknown")}')
        # Return partial success anyway
        print(json.dumps({
            'success': True,
            'partial': True,
            'file_path': output_filename,
            'scenes_dir': scenes_dir,
            'images_saved': actual,
            'images_expected': n,
            'message': f'Video assembly failed but {actual} images saved.',
        }))
        return 0

    # Full success — ffmpeg completed with all images
    print(json.dumps({**result, 'scenes_dir': scenes_dir, 'partial': False}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
