# Stickman Story — Manual Media Insertion

## Overview

Add a **Manual mode** to the Stickman Story pipeline. The AI generates the script, scene prompts, and voiceover as before, but instead of auto-rendering images via the Gemini bridge, the user uploads their own images/videos per scene, then clicks "Assemble" to produce the final video.

## Changes Summary

| Area | Change |
|------|--------|
| UI (PipelineForm) | Rename "🎨 Gemini Story" → "Create Stickman Story"; add mode toggle + aspect ratio |
| Pipeline state | New state `awaiting_media` between voiceover and assembly |
| UI (WorkflowCard) | Scene media grid with drag-drop upload per scene |
| API | New endpoint `POST /api/workflow/:id/assemble` |
| Backend | `WorkflowOrchestrator.handleManualAssembly()` |
| Python | `ffmpeg_video.py` new action `manual_assembly` for mixed image/video + audio |

---

## 1. UI Changes

### PipelineForm.tsx

- `"🎨 Gemini Story"` → `"Create Stickman Story"` in toggle-group
- When `footage_source === 'stickman_story'`, show below the toggle:
  - **Mode**: `[Automate] [Manual]` toggle buttons
  - **Aspect Ratio** (only in Manual mode): `[9:16 Reels (1080x1920)] [16:9 Landscape (1920x1080)]`

### WorkflowCard.tsx

When `workflow.status === 'awaiting_media'`, render a `SceneMediaManager` component (extended from the existing `SceneImageManager`).

### SceneMediaManager (new/extended component)

Props:
- `workflowId`, `scenes` (each with `text`, `searchTerms`, `imagePrompt`), `sceneImages` (status per scene), `aspectRatio`, `onAssemble`

Each scene card shows:
1. Scene number + narration text + AI image prompt (collapsible)
2. Drop zone (click or drag) accepting: `.png`, `.jpg`, `.jpeg`, `.mp4`, `.mov`, `.webm`
3. After upload: thumbnail preview, media type badge (Image/Video), file size, replace button
4. Upload progress indicator per scene

Footer:
- Progress bar: "X/Y scenes filled"
- "Assemble Final Video" button — enabled only when all Y scenes have media

---

## 2. Pipeline Flow (Manual Mode)

```
User enters topic (Create Stickman Story + Manual + 9:16)
  ↓
executeShortPipeline → generateStickmanStoryJson() (AI generates 30-scene JSON)
  ↓
awaiting_script_approval (user reviews/edits narration)
  ↓ User approves
continuePipelineAfterApproval → generateVoiceover()
  ↓
status = 'awaiting_media' ← NEW
  ↓ User uploads media per scene, clicks "Assemble"
POST /api/workflow/:id/assemble
  ↓
orchestrator.assembleManualVideo(workflowId)
  → collect scene media paths from disk
  → calculate per-scene durations (word_count / 2.8 wps, min 2s)
  → call ffmpeg_video.py action=manual_assembly
  → update steps, complete workflow
```

---

## 3. API

### `POST /api/workflow/:id/scenes/:sceneIndex/upload-media`
Multipart upload (field: `media`). Saves to `output/assets/scenes/{workflowId}/manual/scene_{index:04d}.{ext}`. Returns `{ success, fileUrl, mediaType }`.

### `POST /api/workflow/:id/assemble`
No body. Checks all scenes have media, then triggers assembly. Returns `{ success, message }`.

---

## 4. Backend

### Types (server/src/types.ts)

Add to `WorkflowState`:
- `manual_mode?: boolean`
- `aspect_ratio?: '9:16' | '16:9'`
- `manual_media?: ManualMediaInfo[]`

```typescript
interface ManualMediaInfo {
  sceneIndex: number;
  mediaType: 'image' | 'video';
  fileName: string;
  fileUrl: string;
  uploadedAt: string;
}
```

Add `'awaiting_media'` to status union.

### WorkflowOrchestrator.ts

- `executeShortPipeline()`: store `manual_mode` and `aspect_ratio` on workflow from request
- `continuePipelineAfterApproval()`: after voiceover, set status to `'awaiting_media'` if manual mode, emit `media_ready` event
- `uploadSceneMedia(workflowId, sceneIndex, buffer, mimetype)`: save to disk, update workflow manual_media
- `assembleManualVideo(workflowId)`: 
  1. Validate all scenes have media
  2. Build scene array with `{ media_path, media_type, text, duration_seconds }`
  3. Run ffmpeg_video.py with action=`manual_assembly`
  4. Complete workflow with result

### route: workflow.ts

- `POST /:id/scenes/:sceneIndex/upload-media` (multipart)
- `POST /:id/assemble`

---

## 5. Python — ffmpeg_video.py

New action `manual_assembly`:

Input:
```json
{
  "action": "manual_assembly",
  "scenes": [
    {
      "media_path": "path/to/file",
      "media_type": "image",
      "text": "narration text",
      "duration_seconds": 6.0
    },
    {
      "media_path": "path/to/file",
      "media_type": "video",
      "text": "more narration",
      "duration_seconds": 0  // ignored for video, natural duration used
    }
  ],
  "audio_path": "path/to/audio.wav",
  "output_filename": "output.mp4",
  "resolution": "1080x1920",
  "caption_position": "bottom",
  "caption_background_color": "black"
}
```

Assembly logic:
1. For each scene, determine display duration:
   - Image: use `duration_seconds` (calculated from word count)
   - Video: probe natural duration, use that
2. Build ffmpeg concat file:
   - Image → `file 'path'` + `duration X.XXX`
   - Video → transcode to consistent codec first if needed, then `file 'path'`
3. Overlay audio with `-shortest`
4. Render subtitles from narration text (burned in or as ASS)

---

## 6. Error Handling

- **Upload fails**: show error per scene, user retries
- **Assemble fails**: workflow goes to failed state with error message in logs
- **Partial upload on assemble call**: return 400 with list of missing scenes
- **File type rejection**: client-side validation before upload
