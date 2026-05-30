# Sidecar Integration: short-video-maker

## Goal
Add faceless short-form video generation (YouTube Shorts, TikTok, Reels) to the existing YouTube Automation Workflow by integrating `short-video-maker` as a Docker sidecar service — zero changes to the frontend UI, minimal additions to the backend.

## Architecture

```
User's Browser (React, port 5173)
       │
       │ API calls + WebSocket
       ▼
Your Express Backend (port 3001)
       │
       │ HTTP REST
       ▼
short-video-maker (Docker, port 3123)
       │
       ├── Kokoro TTS (CPU, free)
       ├── Whisper.cpp (GPU via CUDA on RTX 3060)
       ├── Pexels API (free key) → background footage
       ├── Remotion → video rendering
       └── FFmpeg → final encoding
```

Your existing frontend, backend, WebSocket, and workflow state machine remain **unchanged**. The sidecar is a new "engine" behind a thin integration service.

## Sidecar Setup

### Docker Compose Addition
A new `docker-compose.yml` in the project root (or a `sidecar/` folder) runs the CUDA-optimized image:

```yaml
services:
  short-video-maker:
    image: gyoridavid/short-video-maker:latest-cuda
    ports:
      - "3123:3123"
    environment:
      - PEXELS_API_KEY=${PEXELS_API_KEY}
      - LOG_LEVEL=info
      - CONCURRENCY=2
      - VIDEO_CACHE_SIZE_IN_BYTES=4294967296
    volumes:
      - ./output/videos:/app/data/videos
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

### Prerequisites
- Docker Desktop with WSL2 + NVIDIA Container Toolkit
- Free Pexels API key from https://www.pexels.com/api/
- ~4GB RAM minimum for the container

## Backend Integration

### New File: `server/src/services/shortVideoMaker.ts`
Thin HTTP client wrapping the sidecar REST API. Methods:

| Method | Calls Sidecar | Returns |
|--------|---------------|---------|
| `createVideo(scenes, config)` | `POST /api/short-video` | `{ videoId }` |
| `getStatus(videoId)` | `GET /api/short-video/{id}/status` | `{ status: 'processing' \| 'ready' \| 'error' }` |
| `downloadVideo(videoId)` | `GET /api/short-video/{id}` | Video binary, saved to `output/` |
| `listVideos()` | `GET /api/short-videos` | Array of `{ id, status }` |
| `deleteVideo(videoId)` | `DELETE /api/short-video/{id}` | `{ success }` |
| `healthCheck()` | `GET /health` | `{ status: 'ok' }` |

### Scene Mapping
When a user submits a topic, the backend converts it into scenes for the sidecar:

```
Input topic: "5 habits of successful people"
         ↓
Scenes: [
  { text: "Success isn't about luck — it's about daily habits.",             searchTerms: ["success", "morning routine"] },
  { text: "Habit #1: Wake up at 5 AM every single day.",                     searchTerms: ["sunrise", "morning"] },
  { text: "Habit #2: Read for 30 minutes before checking your phone.",       searchTerms: ["reading", "books"] },
  { text: "Habit #3: Exercise — even 10 minutes changes everything.",        searchTerms: ["workout", "fitness"] },
  { text: "Habit #4: Write down your goals every morning.",                  searchTerms: ["journaling", "writing"] },
  { text: "Habit #5: Surround yourself with people who push you higher.",    searchTerms: ["friends", "team"] },
  { text: "Which habit will you start today? Comment below!",                searchTerms: ["motivation", "inspiration"] },
]
```

The backend uses GPT4All (already built) to generate the scene text and extract search terms from the topic. If GPT4All is unavailable, a template-based scene generator is used.

### Configuration Mapping
Sidecar config is auto-derived from existing form fields:

| Your Form Field | Sidecar Config |
|----------------|----------------|
| Tone (educational) | `music: "contemplative"` |
| Tone (entertaining) | `music: "happy"` |
| Tone (professional) | `music: "hopeful"` |
| Tone (casual) | `music: "chill"` |
| Thumbnail style (eye-catching) | `captionPosition: "center"` |
| Thumbnail style (minimalist) | `captionPosition: "bottom"` |
| Thumbnail style (educational) | `captionBackgroundColor: "blue"` |
| _Always_ | `orientation: "portrait"` |

### Workflow Orchestrator Changes
The existing `workflowOrchestrator.ts` gets a new branch:

```
executePipeline():
  if (request.style === 'short') {
    → runShortVideoPipeline()   // NEW: sidecar path
  } else {
    → existing Python pipeline  // unchanged
  }
```

The new `runShortVideoPipeline()`:
1. Generates scenes via GPT4All or template
2. Calls `shortVideoMaker.createVideo(scenes, config)`
3. Polls status every 3 seconds
4. On `ready`, downloads video to `output/assets/videos/`
5. Emits WebSocket events identically to the existing pipeline

## Frontend Changes

### PipelineForm — New Dropdown
Added to the existing form, above the Generate button:

```
[Video Style]
▼ Short / Reel (9:16)    ← new
  Tutorial (16:9)         ← existing
```

### types.ts — New Style Type
```typescript
export type VideoStyle = 'short' | 'tutorial';
```

No other component changes. WorkflowCard, StepProgress, SystemStatus, WebSocket — all work identically for both styles.

## Video Style Behavior Comparison

| Aspect | Tutorial (existing) | Short/Reel (sidecar) |
|--------|-------------------|---------------------|
| Orientation | 16:9 landscape | 9:16 portrait |
| Background | Static image | Pexels video footage |
| Captions | None | Whisper-generated, styled |
| Audio | Coqui TTS | Kokoro TTS |
| Music | None | Background music auto-selected |
| Duration | Configurable (1-15 min) | ~30-60 seconds (scene count) |

## System Status — New Check
The existing `/api/system/status` endpoint adds:
```json
{
  "shortVideoMaker": {
    "available": true,
    "status": "ready",
    "version": "1.0.0"
  }
}
```

Checked by hitting `GET /health` on the sidecar. Shown in the SystemStatus component alongside other tools.

## Error Handling
- **Sidecar unreachable**: The form disables Short/Reel style, shows notice "Install Docker sidecar for Short videos"
- **Sidecar fails mid-render**: Workflow marked as failed, error message returned, user retries
- **Pexels API fails**: Sidecar uses fallback search terms (`nature`, `globe`, `space`, `ocean`)

## Files Changed
```
NEW  docker-compose.yml                        # Sidecar service definition
NEW  server/src/services/shortVideoMaker.ts    # Sidecar HTTP client
MOD  server/src/services/workflowOrchestrator.ts  # New branch for short style
MOD  server/src/routes/workflow.ts             # Accept style field
MOD  server/src/routes/system.ts               # Sidecar health check
MOD  server/src/types.ts                       # VideoStyle type
MOD  client/src/types.ts                        # VideoStyle type
MOD  client/src/components/PipelineForm.tsx     # Style dropdown
```

## Out of Scope (First Version)
- Batch/multiple video generation in one request
- Custom caption styling (colors, fonts, animations)
- Custom background music upload
- Direct upload to YouTube/TikTok from sidecar output
- Scheduling / content calendar
