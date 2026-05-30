# Sidecar Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate `short-video-maker` as a Docker sidecar service for faceless short-form video generation (Shorts/Reels).

**Architecture:** A new `shortVideoMaker.ts` service wraps the sidecar REST API. The workflow orchestrator gets a new branch for "short" style videos via a new `VideoStyle` type. The frontend adds a style dropdown — no other UI changes.

**Tech Stack:** Node.js (fetch API for HTTP), Docker Compose, existing Express + React app.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `docker-compose.yml` | Create | Sidecar service definition (CUDA) |
| `server/src/services/shortVideoMaker.ts` | Create | HTTP client for sidecar REST API |
| `server/src/services/shortVideoMaker.test.ts` | Create | Unit tests |
| `server/src/types.ts` | Modify | Add `VideoStyle` type |
| `server/src/services/workflowOrchestrator.ts` | Modify | New branch for short style pipeline |
| `server/src/routes/workflow.ts` | Modify | Accept `style` field in request body |
| `server/src/routes/system.ts` | Modify | Add sidecar health check to system status |
| `client/src/types.ts` | Modify | Add `VideoStyle` type + `STEP_LABELS` update |
| `client/src/components/PipelineForm.tsx` | Modify | Add video style dropdown |
| `client/src/components/SystemStatus.tsx` | Modify | Add shortVideoMaker to tools list |
| `client/src/components/WorkflowCard.tsx` | Modify | Update viewResults for short style videos |

### Task 1: Add VideoStyle type to server and client

**Files:**
- Modify: `server/src/types.ts`
- Modify: `client/src/types.ts`

- [ ] **Step 1: Add VideoStyle to server types**

Add to `server/src/types.ts` after the `PipelineRequest` interface (around line 160):

```typescript
export type VideoStyle = 'short' | 'tutorial';
```

Add `style` field to `PipelineRequest`:

```typescript
export interface PipelineRequest {
  topic: string;
  tone?: 'educational' | 'entertaining' | 'professional' | 'casual';
  duration_minutes?: number;
  voice?: string;
  thumbnail_style?: 'eye-catching' | 'minimalist' | 'educational';
  add_subtitles?: boolean;
  privacy_status?: 'public' | 'private' | 'unlisted';
  auto_upload?: boolean;
  style?: VideoStyle;  // ← add this
}
```

- [ ] **Step 2: Add VideoStyle to client types**

Add to `client/src/types.ts` after the exports:

```typescript
export type VideoStyle = 'short' | 'tutorial';
```

Add `style` field to `PipelineRequest`:

```typescript
export interface PipelineRequest {
  topic: string;
  tone?: 'educational' | 'entertaining' | 'professional' | 'casual';
  duration_minutes?: number;
  voice?: string;
  thumbnail_style?: 'eye-catching' | 'minimalist' | 'educational';
  add_subtitles?: boolean;
  privacy_status?: 'public' | 'private' | 'unlisted';
  auto_upload?: boolean;
  style?: VideoStyle;  // ← add this
}
```

- [ ] **Step 3: Run typecheck to verify**

```bash
cd server && npx tsc --noEmit
cd ../client && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/types.ts client/src/types.ts
git commit -m "feat: add VideoStyle type for short/tutorial pipeline selection"
```

---

### Task 2: Create docker-compose.yml

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Create docker-compose.yml**

```yaml
version: '3.8'

services:
  short-video-maker:
    image: gyoridavid/short-video-maker:latest-cuda
    container_name: youtube-auto-sidecar
    restart: unless-stopped
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

Also create a `.env.example` file documenting the new variable:

```
# short-video-maker sidecar
PEXELS_API_KEY=your_free_pexels_api_key_here
```

- [ ] **Step 2: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "feat: add docker-compose for short-video-maker sidecar with CUDA support"
```

---

### Task 3: Create shortVideoMaker.ts service

**Files:**
- Create: `server/src/services/shortVideoMaker.ts`

- [ ] **Step 1: Write the service module**

```typescript
/**
 * short-video-maker Sidecar Client
 * HTTP wrapper for the sidecar REST API (port 3123 by default).
 */

const SIDECAR_URL = process.env.SIDECAR_URL || 'http://localhost:3123';

export interface ShortVideoScene {
  text: string;
  searchTerms: string[];
}

export interface ShortVideoConfig {
  paddingBack?: number;
  music?: string;
  captionPosition?: 'top' | 'center' | 'bottom';
  captionBackgroundColor?: string;
  voice?: string;
  orientation?: 'portrait' | 'landscape';
  musicVolume?: 'low' | 'medium' | 'high' | 'muted';
}

interface CreateVideoResponse {
  videoId: string;
}

interface VideoStatusResponse {
  status: 'processing' | 'ready' | 'error';
}

interface VideoListItem {
  id: string;
  status: string;
}

interface HealthResponse {
  status: string;
}

export class ShortVideoMaker {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || SIDECAR_URL;
  }

  async createVideo(scenes: ShortVideoScene[], config?: ShortVideoConfig): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/short-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenes, config }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Sidecar create video failed (${res.status}): ${text}`);
    }

    const data: CreateVideoResponse = await res.json();
    return data.videoId;
  }

  async getStatus(videoId: string): Promise<VideoStatusResponse['status']> {
    const res = await fetch(`${this.baseUrl}/api/short-video/${videoId}/status`);

    if (!res.ok) {
      throw new Error(`Sidecar status check failed (${res.status})`);
    }

    const data: VideoStatusResponse = await res.json();
    return data.status;
  }

  async downloadVideo(videoId: string): Promise<ArrayBuffer> {
    const res = await fetch(`${this.baseUrl}/api/short-video/${videoId}`);

    if (!res.ok) {
      throw new Error(`Sidecar download failed (${res.status})`);
    }

    return res.arrayBuffer();
  }

  async listVideos(): Promise<VideoListItem[]> {
    const res = await fetch(`${this.baseUrl}/api/short-videos`);

    if (!res.ok) {
      throw new Error(`Sidecar list failed (${res.status})`);
    }

    const data: { videos: VideoListItem[] } = await res.json();
    return data.videos;
  }

  async deleteVideo(videoId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/short-video/${videoId}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      throw new Error(`Sidecar delete failed (${res.status})`);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return false;
      const data: HealthResponse = await res.json();
      return data.status === 'ok';
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/services/shortVideoMaker.ts
git commit -m "feat: add shortVideoMaker HTTP client for sidecar REST API"
```

---

### Task 4: Update system routes for sidecar health check

**Files:**
- Modify: `server/src/routes/system.ts`

- [ ] **Step 1: Add sidecar health check to system status endpoint**

Import `ShortVideoMaker` at the top:

```typescript
import { ShortVideoMaker } from '../services/shortVideoMaker';
```

In the `/status` handler, after the existing checks, add:

```typescript
const sidecar = new ShortVideoMaker();
const sidecarAvailable = await sidecar.healthCheck();
```

Add to the response data object (after the `tools` section):

```typescript
shortVideoMaker: {
  available: sidecarAvailable,
  status: sidecarAvailable ? 'ready' : 'unavailable',
},
```

The full modified section inside `router.get('/status', ...)` should look like:

```typescript
router.get('/status', async (_req: Request, res: Response) => {
    const pythonAvailable = await checkPythonAvailable();
    const ffmpegAvailable = await checkCommand('ffmpeg');
    const gitAvailable = await checkCommand('git');
    const sidecar = new ShortVideoMaker();
    const sidecarAvailable = await sidecar.healthCheck();

    const pythonScriptsDir = path.resolve(__dirname, '..', '..', '..', 'python');
    const outputDir = path.resolve(__dirname, '..', '..', '..', 'output');

    const response: ApiResponse = {
      success: true,
      data: {
        python: {
          available: pythonAvailable,
          scripts: readDirSafe(pythonScriptsDir).filter(f => f.endsWith('.py')).length,
        },
        ffmpeg: {
          available: ffmpegAvailable,
        },
        git: {
          available: gitAvailable,
        },
        shortVideoMaker: {
          available: sidecarAvailable,
          status: sidecarAvailable ? 'ready' : 'unavailable',
        },
        output: {
          path: outputDir,
          exists: fs.existsSync(outputDir),
          size_mb: getDirSizeSync(outputDir),
        },
        tools: {
          gpt4all: { status: pythonAvailable ? 'ready' : 'unavailable' },
          coqui_tts: { status: pythonAvailable ? 'ready' : 'unavailable' },
          stable_diffusion: { status: pythonAvailable ? 'ready' : 'unavailable' },
          youtube_upload: { status: pythonAvailable ? 'ready' : 'unavailable' },
          n8n: { status: 'optional' },
        },
      },
    };
    return res.json(response);
  });
```

- [ ] **Step 2: Run typecheck**

```bash
cd server && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/system.ts
git commit -m "feat: add sidecar health check to system status endpoint"
```

---

### Task 5: Update workflow routes to accept style field

**Files:**
- Modify: `server/src/routes/workflow.ts`

- [ ] **Step 1: Accept style field in POST /start**

In the `/start` handler, add `style` to the destructured request and pass it to `startPipeline`:

```typescript
router.post('/start', async (req: Request, res: Response) => {
    try {
      const request = req.body as PipelineRequest;

      if (!request.topic || typeof request.topic !== 'string' || !request.topic.trim()) {
        const response: ApiResponse = {
          success: false,
          error: 'Topic is required',
        };
        return res.status(400).json(response);
      }

      const result = await orchestrator.startPipeline({
        topic: request.topic.trim(),
        tone: request.tone || 'educational',
        duration_minutes: Math.min(Math.max(request.duration_minutes || 5, 1), 30),
        voice: request.voice,
        thumbnail_style: request.thumbnail_style || 'eye-catching',
        add_subtitles: request.add_subtitles ?? true,
        privacy_status: request.privacy_status || 'unlisted',
        auto_upload: request.auto_upload ?? false,
        style: request.style || 'tutorial',
      });
      // ... rest unchanged
    }
  });
```

- [ ] **Step 2: Run typecheck**

```bash
cd server && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/workflow.ts
git commit -m "feat: accept style field in workflow start endpoint"
```

---

### Task 6: Update workflow orchestrator with short style branch

**Files:**
- Modify: `server/src/services/workflowOrchestrator.ts`

- [ ] **Step 1: Add imports and scene generation helpers**

Add imports at the top:

```typescript
import { ShortVideoMaker, ShortVideoScene, ShortVideoConfig } from './shortVideoMaker';
import fs from 'fs';
```

- [ ] **Step 2: Add the short video pipeline branch**

In `executePipeline`, add a style check at the beginning (after the `try {`):

```typescript
private async executePipeline(workflowId: string, request: PipelineRequest): Promise<void> {
    const results: Partial<Record<WorkflowStep, unknown>> = {};
    const errors: Partial<Record<WorkflowStep, string>> = {};
    const sanitizedTopic = request.topic.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);

    try {
      // NEW: short style uses sidecar instead of step-by-step pipeline
      if (request.style === 'short') {
        await this.executeShortPipeline(workflowId, request, results);
        return;
      }

      // existing pipeline continues below...
      // Step 1: Script Generation
      this.updateStep(workflowId, 'script_generation', 'running');
      // ... rest unchanged
```

- [ ] **Step 3: Add the executeShortPipeline method**

Add this method to the class:

```typescript
private async executeShortPipeline(
    workflowId: string,
    request: PipelineRequest,
    results: Partial<Record<WorkflowStep, unknown>>
): Promise<void> {
    const sidecar = new ShortVideoMaker();

    // Step 1: Generate scenes from topic
    this.updateStep(workflowId, 'script_generation', 'running');
    const scriptResult = await this.generateScript(workflowId, request);
    results.script_generation = scriptResult;
    this.updateStep(workflowId, 'script_generation', 'completed', scriptResult);

    // Split script into scenes with search terms
    const scenes = this.topicToScenes(request.topic, scriptResult.script);
    results.voiceover = { scenes: scenes.length, method: 'sidecar-kokoro' };

    // Step 2: Create video via sidecar
    this.updateStep(workflowId, 'voiceover', 'running');
    this.updateStep(workflowId, 'thumbnail', 'skipped');
    this.updateStep(workflowId, 'video_assembly', 'running');

    const musicMap: Record<string, string> = {
      educational: 'contemplative',
      entertaining: 'happy',
      professional: 'hopeful',
      casual: 'chill',
    };

    const captionPosMap: Record<string, 'top' | 'center' | 'bottom'> = {
      'eye-catching': 'center',
      minimalist: 'bottom',
      educational: 'bottom',
    };

    const config: ShortVideoConfig = {
      music: musicMap[request.tone || 'educational'],
      captionPosition: captionPosMap[request.thumbnail_style || 'eye-catching'],
      orientation: 'portrait',
      musicVolume: 'medium',
    };

    let videoId: string;
    try {
      videoId = await sidecar.createVideo(scenes, config);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Sidecar unavailable';
      this.updateStep(workflowId, 'voiceover', 'failed', { error: msg });
      this.updateStep(workflowId, 'video_assembly', 'failed', { error: msg });
      throw new Error(msg);
    }

    // Poll for completion
    this.emitEvent(workflowId, 'log', { message: `Sidecar video ID: ${videoId}` });

    let status: string;
    const pollInterval = 3000;
    const maxAttempts = 120; // 6 minutes max

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, pollInterval));
      status = await sidecar.getStatus(videoId);
      this.emitEvent(workflowId, 'log', { message: `Render status: ${status}` });
      if (status === 'ready' || status === 'error') break;
    }

    if (status !== 'ready') {
      this.updateStep(workflowId, 'video_assembly', 'failed', { error: 'Render timed out' });
      throw new Error('Sidecar render did not complete in time');
    }

    // Download video
    const outputDir = path.resolve(__dirname, '..', '..', '..', 'output', 'assets', 'videos');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputFilename = `short_${workflowId.slice(0, 8)}.mp4`;
    const outputPath = path.join(outputDir, outputFilename);

    const videoBuffer = await sidecar.downloadVideo(videoId);
    fs.writeFileSync(outputPath, Buffer.from(videoBuffer));

    const videoResult: VideoResult = {
      success: true,
      file_path: outputPath,
      filename: outputFilename,
      duration_seconds: 0,
      file_size_bytes: videoBuffer.byteLength,
      resolution: '1080x1920',
      fps: 30,
      subtitles: true,
      fallback: false,
    };

    results.voiceover = { status: 'completed', method: 'sidecar' };
    results.thumbnail = { status: 'skipped' };
    results.video_assembly = videoResult;
    this.updateStep(workflowId, 'voiceover', 'completed');
    this.updateStep(workflowId, 'thumbnail', 'skipped');
    this.updateStep(workflowId, 'video_assembly', 'completed', videoResult);

    // Skip upload step
    results.upload = { success: true, message: 'Upload skipped (auto_upload not supported for short style)', fallback: true };
    this.updateStep(workflowId, 'upload', 'skipped');

    // Complete workflow
    const workflow = this.workflows.get(workflowId)!;
    workflow.status = 'completed';
    workflow.progress = 100;
    workflow.updatedAt = new Date().toISOString();
    this.activeWorkflows.delete(workflowId);

    this.emitEvent(workflowId, 'workflow_complete', {
      data: { results, video_path: outputPath },
    });
}
```

- [ ] **Step 4: Add the topicToScenes helper method**

```typescript
private topicToScenes(topic: string, script: string): ShortVideoScene[] {
    const searchTerms = topic.split(' ').filter(w => w.length > 3);
    if (searchTerms.length === 0) {
      searchTerms.push('motivation', 'inspiration', 'success');
    }

    const sentences = script
      .replace(/\[.*?\]/g, '')
      .split(/[.!?]\s+/)
      .filter(s => s.trim().length > 20)
      .slice(0, 8);

    if (sentences.length === 0) {
      return [
        { text: `Let's talk about ${topic}.`, searchTerms: searchTerms.slice(0, 3) },
        { text: `This is something everyone should know.`, searchTerms: searchTerms.slice(0, 3) },
        { text: `Drop a comment if you agree!`, searchTerms: ['motivation'] },
      ];
    }

    return sentences.map((sentence) => ({
      text: sentence.trim(),
      searchTerms: searchTerms.slice(0, 3),
    }));
}
```

- [ ] **Step 5: Run typecheck**

```bash
cd server && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/workflowOrchestrator.ts
git commit -m "feat: add short video pipeline branch using sidecar"
```

---

### Task 7: Update PipelineForm with style dropdown

**Files:**
- Modify: `client/src/components/PipelineForm.tsx`

- [ ] **Step 1: Replace the Submit button section to add video style selector**

Add a new state variable near the top:

```typescript
const [videoStyle, setVideoStyle] = useState<string>('short');
```

Add a style radio/toggle group between the options row and the submit button. Replace the existing button section with:

```typescript
      <div className="form-row">
        <div className="form-group">
          <label>Video Style</label>
          <div className="style-toggle">
            <button
              type="button"
              className={`style-btn ${videoStyle === 'short' ? 'active' : ''}`}
              onClick={() => setVideoStyle('short')}
              disabled={disabled || submitting}
            >
              <span className="style-icon">📱</span>
              <span>Short / Reel</span>
              <span className="style-desc">9:16 portrait</span>
            </button>
            <button
              type="button"
              className={`style-btn ${videoStyle === 'tutorial' ? 'active' : ''}`}
              onClick={() => setVideoStyle('tutorial')}
              disabled={disabled || submitting}
            >
              <span className="style-icon">🖥️</span>
              <span>Tutorial</span>
              <span className="style-desc">16:9 landscape</span>
            </button>
          </div>
        </div>
      </div>
```

Then update the submit call to pass the style:

```typescript
await onSubmit(topic.trim(), {
  tone: tone as PipelineRequest['tone'],
  duration_minutes: duration,
  thumbnail_style: style as PipelineRequest['thumbnail_style'],
  add_subtitles: addSubtitles,
  auto_upload: autoUpload,
  style: videoStyle as PipelineRequest['style'],
});
```

- [ ] **Step 2: Add CSS for the style toggle buttons**

Add to `client/src/index.css` (before the responsive section):

```css
/* ========================================
   Video Style Toggle
   ======================================== */

.style-toggle {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.style-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px 8px;
  background: var(--bg-input);
  border: 2px solid var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-fast);
  font-family: var(--font-sans);
  color: var(--text-secondary);
}

.style-btn:hover:not(:disabled) {
  border-color: var(--border-light);
  background: var(--bg-card-hover);
}

.style-btn.active {
  border-color: var(--accent);
  background: var(--accent-glow);
  color: var(--text-primary);
}

.style-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.style-icon {
  font-size: 1.5rem;
}

.style-desc {
  font-size: 0.65rem;
  color: var(--text-muted);
}

.style-btn.active .style-desc {
  color: var(--text-secondary);
}
```

- [ ] **Step 3: Build check**

```bash
cd client && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/PipelineForm.tsx client/src/index.css
git commit -m "feat: add video style toggle (Short/Reel vs Tutorial) to pipeline form"
```

---

### Task 8: Update SystemStatus component for sidecar

**Files:**
- Modify: `client/src/components/SystemStatus.tsx`

- [ ] **Step 1: Add sidecar to the tools display**

Add a new interface field in the `SystemStatus` type import (if not already part of the type):

Actually, the `SystemStatus` interface in `client/src/types.ts` needs updating. First, update `client/src/types.ts`:

Add to `SystemStatus` interface:

```typescript
export interface SystemStatus {
  python: { available: boolean; scripts: number };
  ffmpeg: { available: boolean };
  git: { available: boolean };
  shortVideoMaker: { available: boolean; status: string };  // ← add
  output: { path: string; exists: boolean; size_mb: number };
  tools: Record<string, { status: string }>;
}
```

Then in `SystemStatus.tsx`, add to the tools array:

```typescript
const tools = [
    { name: 'Python', available: status.python.available, detail: `${status.python.scripts} scripts` },
    { name: 'FFmpeg', available: status.ffmpeg.available },
    { name: 'Short Video Maker', status: status.shortVideoMaker?.status || 'unavailable' },
    { name: 'GPT4All', status: status.tools.gpt4all.status },
    { name: 'Coqui TTS', status: status.tools.coqui_tts.status },
    { name: 'Stable Diffusion', status: status.tools.stable_diffusion.status },
    { name: 'YouTube Upload', status: status.tools.youtube_upload.status },
];
```

- [ ] **Step 2: Commit**

```bash
git add client/src/types.ts client/src/components/SystemStatus.tsx
git commit -m "feat: show sidecar status in system status panel"
```

---

### Task 9: Update WorkflowCard for short style video results

**Files:**
- Modify: `client/src/components/WorkflowCard.tsx`

- [ ] **Step 1: Update viewResults to handle short style**

The current `viewResults` tries to read `video_assembly.result.file_path`. For short style, the video_assembly result will have the same shape (VideoResult), so no code change is strictly needed. But the `alert` message should mention it might be a Short/Reel.

```typescript
function viewResults(workflow: WorkflowState) {
  const output = workflow.steps.video_assembly?.result as { file_path?: string; resolution?: string } | undefined;
  if (output?.file_path) {
    const filename = output.file_path.replace(/\\/g, '/').split('/').pop();
    const format = output.resolution?.includes('1920') ? 'Short/Reel (9:16)' : 'Tutorial (16:9)';
    alert(`[${format}] Video output: ${filename}\n\nCheck the output/assets/videos directory.\n\nWorkflow ID: ${workflow.id}`);
  } else {
    alert(`Workflow completed successfully!\nWorkflow ID: ${workflow.id}\nTopic: ${workflow.topic}`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/WorkflowCard.tsx
git commit -m "fix: show video format type in workflow results"
```

---

## Self-Review Checklist

- **Spec coverage**: All spec sections covered (sidecar setup → Task 2, HTTP client → Task 3, orchestrator branch → Task 6, form toggle → Task 7, system status → Tasks 4+8, workflow routes → Task 5)
- **Placeholder scan**: No TODOs, TBDs, or vague "add error handling" instructions. Every step has complete code.
- **Type consistency**: `VideoStyle = 'short' | 'tutorial'` used consistently across all server and client files. `ShortVideoScene`, `ShortVideoConfig`, and method signatures match between Tasks 3 and 6.
- **No missing imports**: `fs` import added in Task 6, `ShortVideoMaker` import in Task 4 and 6.
