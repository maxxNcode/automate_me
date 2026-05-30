# 🎥 YouTube Automation Workflow

A full-stack web application for automated YouTube video generation. Generate scripts, voiceovers, thumbnails, and videos — then optionally upload to YouTube — all from a single web dashboard.

## 🏗 Architecture

```
youtubeauto/
├── client/          # React + Vite frontend (TypeScript)
├── server/          # Node.js Express backend (TypeScript)
├── python/          # Python integration scripts
├── output/          # Generated assets (videos, audio, thumbnails)
│   └── assets/
│       ├── audio/
│       ├── thumbnails/
│       └── videos/
└── config/          # YouTube API credentials (create manually)
```

### Pipeline Steps

| Step | Tool | Purpose |
|------|------|---------|
| 1. **Script** | GPT4All | Local LLM generates video script |
| 2. **Voiceover** | Coqui TTS | Text-to-speech audio generation |
| 3. **Thumbnail** | Stable Diffusion | AI-generated thumbnail art |
| 4. **Video** | FFmpeg | Assemble audio + images into video |
| 5. **Upload** | youtube-upload CLI | Publish to YouTube |

All steps gracefully fall back to built-in templates when local tools aren't installed — you can run the full pipeline with **zero dependencies** to see the workflow in action.

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+
- **Python** 3.9+ (optional, for AI tools)
- **FFmpeg** (optional, for video assembly)

### Installation

```bash
# 1. Install all dependencies
npm run install:all

# 2. (Optional) Install Python dependencies
npm run setup:python

# 3. Start development servers (both backend + frontend)
npm run dev
```

The app will be available at **http://localhost:5173** with the backend API at **http://localhost:3001**.

### Environment Variables (optional)

Create a `.env` file in the project root:

```env
PORT=3001
CLIENT_ORIGIN=http://localhost:5173
```

## 🎬 Usage

1. Open the dashboard at http://localhost:5173
2. Enter a video topic in the "New Pipeline" form
3. Configure tone, duration, and thumbnail style
4. Click "Generate Video" to start the pipeline
5. Watch real-time progress as each step executes
6. Find generated assets in the `output/` directory

## 🔧 Available Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start both servers concurrently |
| `npm run dev:server` | Start only the backend server |
| `npm run dev:client` | Start only the frontend dev server |
| `npm run build` | Build both for production |
| `npm run setup:python` | Install Python dependencies |

### Individual Scripts

```bash
# Generate a script
echo '{"topic": "Machine Learning", "tone": "educational"}' | python python/gpt4all_script.py

# Generate voiceover (requires audio output path)
python python/coqui_tts.py < input.json

# Generate thumbnail
python python/stable_diffusion.py < input.json

# Assemble video
python python/ffmpeg_video.py < input.json
```

## 🔌 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/workflow/start` | Start a full pipeline |
| GET | `/api/workflow/:id` | Get workflow status |
| GET | `/api/workflow` | List all workflows |
| POST | `/api/workflow/:id/cancel` | Cancel a workflow |
| GET | `/api/system/status` | Check tool availability |

## 🛠 Tech Stack

- **Frontend:** React 18, TypeScript, Vite
- **Backend:** Node.js, Express, TypeScript, WebSocket (ws)
- **AI/ML:** GPT4All, Coqui TTS, Stable Diffusion
- **Media:** FFmpeg, Pillow
- **Upload:** YouTube Data API v3 / youtube-upload CLI

## 📋 License

MIT
