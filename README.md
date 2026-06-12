# YouTube Automation Workflow

A full-stack web application for fully automated YouTube video generation. From a single web dashboard, generate scripts, create voiceovers, render thumbnails, assemble videos, and optionally upload to YouTube. Supports tutorial/landscape and short/portrait formats with multiple footage sourcing methods.

## Architecture

```
youtubeauto/
├── client/              # React + Vite frontend (TypeScript)
│   └── src/
│       ├── api/         # API client modules
│       ├── components/  # React components (PipelineDashboard, PipelineForm, etc.)
│       ├── hooks/       # useWebSocket, useWorkflow
│       └── types.ts     # TypeScript definitions
├── server/              # Node.js Express backend (TypeScript)
│   └── src/
│       ├── routes/      # API routes (workflow, system, auth, bridge)
│       ├── services/    # Business logic (orchestrator, AI, assembly, media)
│       └── types.ts     # Core type definitions
├── python/              # Python integration scripts
│   ├── ffmpeg_video.py  # Video assembly (FFmpeg)
│   ├── gemini_story.py  # Gemini bridge scene renderer
│   ├── stickman_story.py# Stickman video generator with SD
│   ├── kokoro_tts.py    # Kokoro-82M TTS model
│   ├── youtube_uploader.py # YouTube Data API upload
│   └── ...
├── launcher/            # Production server launcher
├── docker-compose.yml   # Sidecar container (short-video-maker)
└── ffmpeg_bin/          # Bundled FFmpeg binaries
```

### Pipeline Flow

1. **Script Generation** — AI generates video script via Groq/OpenRouter (multi-model cycling with fallbacks)
2. **Voiceover** — TTS via edge-tts (cloud) or Kokoro-82M (local)
3. **Footage Acquisition** — One of four methods: stock footage (sidecar), YouTube clips, AI-generated images (Gemini bridge), or user-uploaded media
4. **Video Assembly** — FFmpeg assembles clips + audio + captions + overlays
5. **Upload** — Optional YouTube Data API v3 upload

Every step has graceful fallbacks (built-in templates, silent audio, gradient backgrounds).

## Quick Start

### Prerequisites
- **Node.js** 18+
- **Python** 3.9+
- **FFmpeg** (bundled in `ffmpeg_bin/`)

### Installation

```bash
# Install all dependencies
npm run install:all

# (Optional) Python deps
npm run setup:python

# Start dev servers
npm run dev
```

App at **http://localhost:5173**, backend API at **http://localhost:3001**.

### Environment Variables

Create a `.env` file (see `.env.example`):

```env
PORT=3001
CLIENT_ORIGIN=http://localhost:5173
GROQ_API_KEY=your_groq_key
OPENROUTER_API_KEY=your_openrouter_key
```

## Key Features

- **Two video modes** — Tutorial (16:9) and Short (9:16)
- **Four footage sources** — Stock footage, YouTube gameplay clips, AI-generated story images, manual media upload
- **AI provider cycling** — Automatic fallback across Groq and OpenRouter models
- **Real-time updates** — WebSocket-powered pipeline progress
- **Queue system** — Sequential processing with position tracking
- **Multi-user support** — Access key based authentication
- **Graceful degradation** — Works with zero dependencies using built-in templates

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start both servers concurrently |
| `npm run dev:server` | Backend only |
| `npm run dev:client` | Frontend only |
| `npm run build` | Production build |
| `npm run setup:python` | Install Python dependencies |

## Tech Stack

- **Frontend:** React 18, TypeScript, Vite 5
- **Backend:** Node.js, Express, TypeScript, WebSocket (ws), SQLite (better-sqlite3)
- **AI Providers:** Groq (Llama 3.3, Mixtral), OpenRouter (DeepSeek V4, Llama 3.3, Nemotron, Gemma 4, Qwen 3, Kimi K2.6)
- **Python:** FFmpeg, edge-tts, Kokoro-82M, diffusers, transformers, OpenCV
- **Infrastructure:** Docker (sidecar with GPU), WebSocket, SQLite WAL mode

## License

MIT
