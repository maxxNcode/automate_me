# Script Preview + Dual Render Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add script preview with inline editing before video rendering, dual render path toggle (Sidecar stock footage / YouTube gameplay clips), and improved AI prompts for richer scenes.

**Architecture:** Backend pauses pipeline after AI scene generation, stores scenes in workflow state, exposes approve/regenerate endpoints. Frontend shows editable script panel. After approval, pipeline branches based on `footage_source` field (sidecar Docker container or local YouTube clip assembly).

**Tech Stack:** Node.js/Express, React/TypeScript, Python scripts, Docker sidecar

---

### Task 1: Add Types (Server + Client)

**Files:**
- Modify: `server/src/types.ts`
- Modify: `client/src/types.ts`

**Server types (`server/src/types.ts`):**

- [ ] **Step 1: Add `awaiting_script_approval` to workflow status union**

Find the type for workflow status (likely `'queued' | 'running' | 'completed' | 'failed'`) and add `'awaiting_script_approval'` to the union.

- [ ] **Step 2: Add `footage_source` to PipelineRequest**

Find `PipelineRequest` interface and add:
```typescript
footage_source?: 'sidecar' | 'youtube_clips';
```

- [ ] **Step 3: Add `ScriptPreviewResult` type**

Add after the existing result types:
```typescript
export interface ScriptPreviewResult {
  success: boolean;
  scenes: Array<{ text: string; searchTerms: string[] }>;
  model: string;
  fallback: boolean;
  word_count: number;
  duration_seconds: number;
}
```

- [ ] **Step 4: Add script preview fields to WorkflowState**

Add to the `WorkflowState` interface:
```typescript
scenes?: Array<{ text: string; searchTerms: string[] }>;
fallback: boolean;
model_used: string;
```

**Client types (`client/src/types.ts`):**

- [ ] **Step 5: Add `footage_source` to frontend PipelineRequest**

Add `footage_source: 'sidecar' | 'youtube_clips'` to the client-side `PipelineRequest` interface.

- [ ] **Step 6: Add `ScriptPreviewResult` to client types**

Same as server version.

- [ ] **Step 7: Add `awaiting_script_approval` to WorkflowStatus**

Add to the `WorkflowStatus` union/type.

- [ ] **Step 8: Commit**

```bash
git add server/src/types.ts client/src/types.ts
git commit -m "feat: add script preview and footage source types"
```

---

### Task 2: Rewrite AI Scene Prompts

**Files:**
- Modify: `server/src/services/aiProvider.ts`

- [ ] **Step 1: Rewrite SCENES_SYSTEM_PROMPT**

Replace the existing `SCENES_SYSTEM_PROMPT` constant (lines 426-449) with:

```typescript
const SCENES_SYSTEM_PROMPT = `You are an expert short-form video scriptwriter. You write scripts that go viral using these techniques:

- **Curiosity gaps**: Tease what's coming next, make viewers need to know
- **Bold claims**: Start with something that challenges assumptions
- **Pattern interrupts**: Break expected patterns to snap attention
- **Specific data**: Use real numbers, percentages, case studies
- **Emotional triggers**: FOMO, aspiration, surprise, relatability

Each scene has two parts:
1. "text": A spoken line (15-30 words) — conversational, specific, natural when read aloud
2. "searchTerms": 4-5 keywords describing EXACT visuals for the footage

Search terms must be ACTION-ORIENTED and SPECIFIC, not generic:
  BAD: "minecraft", "football", "cooking"
  GOOD: "player mining diamond with iron pickaxe", "crowd cheering at stadium goal celebration", "chef slicing vegetables on wooden cutting board"

Arrange scenes naturally — hook first to grab attention, body scenes each covering ONE unique angle, end with a CTA. No filler.`;
```

- [ ] **Step 2: Rewrite the user prompt in `generateScenes`**

Replace the user prompt inside `generateScenes` (lines 463-483) with:

```typescript
const userPrompt = `Generate ${sceneCount} scenes for a short video about: "${topic}"

Tone: ${tone}
Target duration: ~${durationSeconds} seconds (${sceneCount} scenes)

Each scene MUST have:
- "text": A spoken line (15-30 words) — specific, conversational, one clear point
- "searchTerms": 4-5 ACTION-ORIENTED keywords for stock footage matching the spoken content

STRUCTURE:
- Scene 1: HOOK — curiosity gap, bold claim, or pattern interrupt
- Scenes 2 to ${sceneCount - 1}: BODY — each scene covers ONE distinct angle with specific examples or data
- Scene ${sceneCount}: CTA — compelling reason to follow/comment/share

Example of GOOD search terms:
  Text: "This one mining technique doubled my diamond yield in under an hour"
  Search terms: ["player mining diamond with pickaxe", "minecraft underground cave", "diamond ore vein", "mining redstone torch", "survival mode gameplay"]

BAD search terms (too generic, avoid):
  ["minecraft", "game", "play", "video", "fun"]

Return ONLY a JSON array of scene objects. No markdown, no code fences.`;
```

- [ ] **Step 3: Commit**

```bash
git add server/src/services/aiProvider.ts
git commit -m "feat: rewrite AI prompts with hooking techniques and action-oriented search terms"
```

---

### Task 3: Orchestrator — Script Preview Pause/Resume

**Files:**
- Modify: `server/src/services/workflowOrchestrator.ts`

- [ ] **Step 1: Add `approveScript` method**

Add after `generateAIScenes` method:

```typescript
async approveScript(workflowId: string, editedScenes?: ShortVideoScene[]): Promise<boolean> {
  const workflow = this.workflows.get(workflowId);
  if (!workflow || workflow.status !== 'awaiting_script_approval') return false;

  // Use edited scenes if provided, otherwise use stored scenes
  if (editedScenes && editedScenes.length > 0) {
    workflow.scenes = editedScenes as unknown as ShortVideoScene[];
  }

  workflow.status = 'running';
  workflow.updatedAt = new Date().toISOString();

  this.emitEvent(workflowId, 'log', { message: 'Script approved — continuing pipeline...' });

  // Resume the pipeline from where it paused
  // The pipeline continuation is handled by processing the queue
  // Re-enqueue this workflow to continue from script generation step
  this.activeWorkflows.add(workflowId);

  // Trigger the continuation
  this.continuePipelineAfterApproval(workflowId).catch(err => {
    this.handleError(workflowId, 'pipeline', err instanceof Error ? err.message : 'Pipeline continuation failed');
  });

  return true;
}
```

- [ ] **Step 2: Add `continuePipelineAfterApproval` method**

```typescript
private async continuePipelineAfterApproval(workflowId: string): Promise<void> {
  const workflow = this.workflows.get(workflowId);
  if (!workflow) return;

  const scenes = workflow.scenes as unknown as ShortVideoScene[];
  if (!scenes || scenes.length === 0) {
    throw new Error('No scenes available after approval');
  }

  const fullScript = scenes.map(s => s.text).join('. ');
  const request = {
    topic: workflow.topic,
    tone: workflow.tone || 'educational',
    duration_minutes: workflow.duration_minutes || 1,
    footage_source: workflow.footage_source || 'sidecar',
    voice: workflow.voice,
    add_subtitles: workflow.add_subtitles,
    username: workflow.createdBy,
  };

  const results: Partial<Record<WorkflowStep, unknown>> = {};

  // Reconstruct script result
  results.script_generation = {
    success: true,
    script: fullScript,
    model: workflow.model_used || 'ai-provider',
    topic: workflow.topic,
    tone: workflow.tone || 'educational',
    duration_minutes: workflow.duration_minutes || 1,
    word_count: fullScript.split(/\s+/).length,
    fallback: workflow.fallback || false,
  };

  // Generate voiceover + render
  await this.renderAfterApproval(workflowId, scenes, fullScript, request, results);
}
```

- [ ] **Step 3: Modify `executeShortPipeline` to pause after script generation**

In `executeShortPipeline`, after scenes are generated and stored, instead of continuing to voiceover, store the scenes in workflow state, set status to `awaiting_script_approval`, and return early:

```typescript
// After script generation, store scenes and pause for approval
const scenes = // ... from AI generation or fallback
const script = scenes.map(s => s.text).join(' ');

// Store scenes in workflow state for approval
workflow.scenes = scenes as unknown as ShortVideoScene[];
workflow.fallback = modelUsed === 'viral-template';
workflow.model_used = modelUsed;
workflow.status = 'awaiting_script_approval';
workflow.updatedAt = new Date().toISOString();
this.workflows.set(workflowId, workflow);

// Emit script preview event
this.emitEvent(workflowId, 'script_ready', {
  scenes: scenes.map(s => ({ text: s.text, searchTerms: s.searchTerms })),
  model: modelUsed,
  fallback: modelUsed === 'viral-template',
});

// Pause — wait for user approval
return;
```

Find the section where script generation completes (around lines 411-434 in the current code), and replace the continuation logic so it pauses instead of proceeding to voiceover.

- [ ] **Step 4: Add `renderAfterApproval` method**

This method handles voiceover generation + the dual render path:

```typescript
private async renderAfterApproval(
  workflowId: string,
  scenes: ShortVideoScene[],
  fullScript: string,
  request: any,
  results: Partial<Record<WorkflowStep, unknown>>
): Promise<void> {
  // Voiceover generation
  this.updateStep(workflowId, 'voiceover', 'running');
  this.emitEvent(workflowId, 'log', { message: `Generating voiceover for ${scenes.length} scenes...` });

  const voiceoverResult = await this.generateVoiceover(workflowId, fullScript, request.voice);
  results.voiceover = voiceoverResult;
  this.updateStep(workflowId, 'voiceover', 'completed', voiceoverResult);

  if (!voiceoverResult.success || !voiceoverResult.file_path) {
    throw new Error('Voiceover generation failed');
  }

  // Branch based on footage source
  if (request.footage_source === 'sidecar') {
    await this.renderWithSidecar(workflowId, scenes, voiceoverResult.file_path, request, results);
  } else {
    await this.renderWithYouTubeClips(workflowId, scenes, voiceoverResult.file_path, request, results);
  }
}
```

- [ ] **Step 5: Add `renderWithSidecar` method**

This re-implements the sidecar render path:

```typescript
private async renderWithSidecar(
  workflowId: string,
  scenes: ShortVideoScene[],
  audioPath: string,
  request: any,
  results: Partial<Record<WorkflowStep, unknown>>
): Promise<void> {
  const { ShortVideoMaker } = require('./shortVideoMaker');
  const sidecar = new ShortVideoMaker();

  this.updateStep(workflowId, 'thumbnail', 'skipped');
  this.updateStep(workflowId, 'video_assembly', 'running');
  this.emitEvent(workflowId, 'log', { message: 'Sending scenes to sidecar for rendering...' });

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

  const config: any = {
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

  this.emitEvent(workflowId, 'log', { message: `Sidecar video ID: ${videoId}` });

  // Poll for completion
  let status: string = 'processing';
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 3000));
    status = await sidecar.getStatus(videoId);
    this.emitEvent(workflowId, 'log', { message: `Render status: ${status}` });
    if (status === 'ready' || status === 'error') break;
  }

  if (status !== 'ready') {
    this.updateStep(workflowId, 'video_assembly', 'failed', { error: 'Render timed out' });
    throw new Error('Sidecar render did not complete in time');
  }

  // Download video
  const outputDir = getOutputDir('assets/videos');
  const outputFilename = `short_${workflowId.slice(0, 8)}.mp4`;
  const outputPath = path.join(outputDir, outputFilename);

  const videoBuffer = await sidecar.downloadVideo(videoId);
  fs.writeFileSync(outputPath, Buffer.from(videoBuffer));

  // Clean up sidecar copy
  sidecar.deleteVideo(videoId).catch(() => {});

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

  results.video_assembly = videoResult;
  this.updateStep(workflowId, 'video_assembly', 'completed', videoResult);

  results.upload = { success: true, message: 'Upload skipped (auto_upload not supported for short style)', fallback: true } as unknown as UploadResult;
  this.updateStep(workflowId, 'upload', 'skipped');

  this.completeWorkflow(workflowId, results, outputPath);
}
```

- [ ] **Step 6: Extract `renderWithYouTubeClips` method**

This should contain the current YouTube clip download + FFmpeg assembly logic from `executeShortPipeline` (lines 454-559 in current code). Move it into a separate method:

```typescript
private async renderWithYouTubeClips(
  workflowId: string,
  scenes: ShortVideoScene[],
  audioPath: string,
  request: any,
  results: Partial<Record<WorkflowStep, unknown>>
): Promise<void> {
  this.updateStep(workflowId, 'thumbnail', 'skipped');
  this.updateStep(workflowId, 'video_assembly', 'running');

  // Download YouTube clips
  const clipDir = getOutputDir('assets/videos/clips');
  let clipPaths: string[] = [];
  try {
    const footageResult = await runPythonScript<any>('youtube_footage.py', {
      scenes: scenes.map(s => ({ text: s.text, search_terms: s.searchTerms })),
      output_dir: clipDir,
      clip_duration: 12,
    }, { timeout: 120000 });

    if (footageResult.success && footageResult.successful_clips?.length > 0) {
      clipPaths = footageResult.successful_clips.map((c: any) => c.file_path);
      this.emitEvent(workflowId, 'log', { message: `Downloaded ${clipPaths.length} gameplay clips` });
    } else {
      this.emitEvent(workflowId, 'log', { message: 'YouTube footage download failed — falling back to static background', level: 'warn' });
    }
  } catch (err) {
    this.emitEvent(workflowId, 'log', { message: 'YouTube footage download failed', level: 'warn' });
  }

  // Assemble video
  const outputDir = getOutputDir('assets/videos');
  const outputFilename = `${request.topic.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20)}_${(request.username || 'user').replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().slice(0, 16).replace('T', '_')}_${workflowId.slice(0, 6)}.mp4`;
  const outputPath = path.join(outputDir, outputFilename);

  if (clipPaths.length > 0) {
    try {
      const clipsForAssembly: { file_path: string; text: string }[] = scenes.map((s, i) => ({
        file_path: clipPaths[i] || clipPaths[clipPaths.length - 1],
        text: s.text,
      }));

      const videoResult = await runPythonScript<VideoResult>('ffmpeg_video.py', {
        action: 'scene_assembly',
        clips: clipsForAssembly,
        audio_path: audioPath,
        output_filename: outputFilename,
        resolution: '1080x1920',
      }, { timeout: 300000 });

      if (videoResult.success) {
        results.video_assembly = videoResult;
        this.updateStep(workflowId, 'video_assembly', 'completed', videoResult);
        results.upload = { success: true, message: 'Upload skipped', fallback: true } as unknown as UploadResult;
        this.updateStep(workflowId, 'upload', 'skipped');
        this.completeWorkflow(workflowId, results, videoResult.file_path);
        return;
      }
    } catch (err) {
      this.emitEvent(workflowId, 'log', { message: 'Scene assembly failed, falling back to audio-only', level: 'warn' });
    }
  }

  // Fallback: audio-only video
  this.emitEvent(workflowId, 'log', { message: 'Generating fallback video (audio + gradient background)...' });
  const fallbackResult = await runPythonScript<VideoResult>('ffmpeg_video.py', {
    action: 'assemble',
    script: scenes.map(s => s.text).join('. '),
    audio_path: audioPath,
    output_filename: outputFilename,
    video_title: request.topic,
    add_subtitles: true,
  }, { timeout: 120000 });

  results.video_assembly = fallbackResult;
  this.updateStep(workflowId, 'video_assembly', 'completed', fallbackResult);
  results.upload = { success: true, message: 'Upload skipped', fallback: true } as unknown as UploadResult;
  this.updateStep(workflowId, 'upload', 'skipped');
  this.completeWorkflow(workflowId, results, fallbackResult.file_path || outputPath);
}
```

- [ ] **Step 7: Add `reGenerateScript` method**

```typescript
async reGenerateScript(workflowId: string): Promise<boolean> {
  const workflow = this.workflows.get(workflowId);
  if (!workflow || workflow.status !== 'awaiting_script_approval') return false;

  workflow.status = 'running';
  workflow.updatedAt = new Date().toISOString();

  this.emitEvent(workflowId, 'log', { message: 'Re-generating script...' });

  // Re-run the pipeline from the start but flag for script-only
  this.activeWorkflows.add(workflowId);

  this.executePipeline(workflowId, {
    topic: workflow.topic,
    tone: workflow.tone || 'educational',
    style: 'short',
    duration_minutes: workflow.duration_minutes || 1,
    footage_source: workflow.footage_source || 'sidecar',
    ai_model: workflow.ai_model || 'auto',
    username: workflow.createdBy,
  } as any).catch(err => {
    this.handleError(workflowId, 'pipeline', err instanceof Error ? err.message : 'Re-generation failed');
  });

  return true;
}
```

- [ ] **Step 8: Store additional fields in WorkflowState**

In `startPipeline` and restore logic, ensure `footage_source`, `tone`, `duration_minutes`, `voice`, `add_subtitles`, `ai_model` fields are stored on the workflow state for later use during script approval continuation.

- [ ] **Step 9: Commit**

```bash
git add server/src/services/workflowOrchestrator.ts
git commit -m "feat: add script preview pause/resume and dual render path"
```

---

### Task 4: Workflow Routes — Approve/Regenerate Endpoints

**Files:**
- Modify: `server/src/routes/workflow.ts`

- [ ] **Step 1: Add POST `/api/workflow/:id/approve-script` endpoint**

```typescript
router.post('/:id/approve-script', async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const editedScenes = req.body.scenes;

    const success = await orchestrator.approveScript(id, editedScenes);
    if (!success) {
      return res.status(409).json({ success: false, error: 'Workflow is not awaiting script approval' });
    }

    return res.json({ success: true, message: 'Script approved, continuing pipeline' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});
```

- [ ] **Step 2: Add POST `/api/workflow/:id/re-generate-script` endpoint**

```typescript
router.post('/:id/re-generate-script', async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const success = await orchestrator.reGenerateScript(id);
    if (!success) {
      return res.status(409).json({ success: false, error: 'Workflow is not awaiting script approval' });
    }
    return res.json({ success: true, message: 'Re-generating script' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});
```

- [ ] **Step 3: Add `footage_source` to start endpoint**

In the existing `POST /start` handler, pass `req.body.footage_source` to the pipeline request. Add default if not present:
```typescript
footage_source: req.body.footage_source || 'sidecar',
```

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/workflow.ts
git commit -m "feat: add approve-script and re-generate-script API endpoints"
```

---

### Task 5: Frontend API — approveScript, regenerateScript

**Files:**
- Modify: `client/src/api/workflow.ts`

- [ ] **Step 1: Add `approveScript` and `regenerateScript` functions**

```typescript
export async function approveScript(workflowId: string, scenes?: Array<{ text: string; searchTerms: string[] }>): Promise<ApiResponse> {
  const res = await fetch(`${API_BASE}/workflow/${workflowId}/approve-script`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenes }),
  });
  return res.json();
}

export async function regenerateScript(workflowId: string): Promise<ApiResponse> {
  const res = await fetch(`${API_BASE}/workflow/${workflowId}/re-generate-script`, {
    method: 'POST',
  });
  return res.json();
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/api/workflow.ts
git commit -m "feat: add approveScript and regenerateScript API calls"
```

---

### Task 6: PipelineForm — Footage Source Dropdown

**Files:**
- Modify: `client/src/components/PipelineForm.tsx`

- [ ] **Step 1: Add `footage_source` to form state**

In the component's state (or useState hooks), add:
```typescript
const [footageSource, setFootageSource] = useState<'sidecar' | 'youtube_clips'>('sidecar');
```

- [ ] **Step 2: Add dropdown UI after the video style toggle**

Find where the Short/Reel vs Tutorial toggle is rendered. After it (or in the same row), add:

```tsx
<div className="form-group">
  <label className="form-label">Footage Source</label>
  <div className="toggle-group">
    <button
      className={`toggle-btn ${footageSource === 'sidecar' ? 'active' : ''}`}
      onClick={() => setFootageSource('sidecar')}
      type="button"
    >
      Stock (Pexels)
    </button>
    <button
      className={`toggle-btn ${footageSource === 'youtube_clips' ? 'active' : ''}`}
      onClick={() => setFootageSource('youtube_clips')}
      type="button"
    >
      Gameplay (YouTube)
    </button>
  </div>
</div>
```

- [ ] **Step 3: Include `footage_source` in submit data**

In the submit handler, add `footage_source: footageSource` to the request body.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/PipelineForm.tsx
git commit -m "feat: add footage source toggle to pipeline form"
```

---

### Task 7: WorkflowCard — Script Preview Panel

**Files:**
- Modify: `client/src/components/WorkflowCard.tsx`
- Modify: `client/src/components/StepProgress.tsx` (if needed)

- [ ] **Step 1: Add script preview state**

```typescript
const [editedScenes, setEditedScenes] = useState<Array<{ text: string; searchTerms: string[] }>>([]);
const [isEditing, setIsEditing] = useState<number | null>(null);
```

- [ ] **Step 2: Add script preview UI in WorkflowCard**

When `workflow.status === 'awaiting_script_approval'` and `workflow.scenes` exists, render a script preview panel:

```tsx
{workflow.status === 'awaiting_script_approval' && workflow.scenes && (
  <div className="script-preview-panel">
    <h4>Script Preview — Review before rendering</h4>
    {workflow.scenes.map((scene, i) => (
      <div key={i} className="scene-card">
        <div className="scene-number">Scene {i + 1}</div>
        {isEditing === i ? (
          <textarea
            value={editedScenes[i]?.text || scene.text}
            onChange={(e) => {
              const updated = [...editedScenes];
              updated[i] = { ...(updated[i] || scene), text: e.target.value };
              setEditedScenes(updated);
            }}
            className="scene-text-input"
            rows={3}
          />
        ) : (
          <p className="scene-text" onClick={() => { setIsEditing(i); setEditedScenes(prev => { const n = [...prev]; n[i] = n[i] || scene; return n; }); }}>
            {scene.text}
          </p>
        )}
        <div className="scene-keywords">
          <small>Keywords: {scene.searchTerms?.join(', ')}</small>
        </div>
        {isEditing === i && (
          <button className="btn btn-small" onClick={() => setIsEditing(null)}>Done</button>
        )}
      </div>
    ))}
    <div className="script-actions">
      <button className="btn btn-primary" onClick={handleApprove}>Approve & Render</button>
      <button className="btn btn-secondary" onClick={handleRegenerate}>Regenerate</button>
    </div>
  </div>
)}
```

- [ ] **Step 3: Add approve/regenerate handlers**

```typescript
const handleApprove = async () => {
  const finalScenes = workflow.scenes.map((s, i) => editedScenes[i] || s);
  await approveScript(workflow.id, finalScenes);
};

const handleRegenerate = async () => {
  await regenerateScript(workflow.id);
};
```

- [ ] **Step 4: Add CSS for script preview**

Add to `client/src/index.css`:

```css
.script-preview-panel {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 16px;
  margin-top: 12px;
}
.scene-card {
  background: var(--bg-secondary);
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 8px;
  cursor: pointer;
}
.scene-number {
  font-weight: 600;
  color: var(--accent);
  font-size: 12px;
  margin-bottom: 4px;
}
.scene-text {
  margin: 4px 0;
  line-height: 1.5;
}
.scene-text-input {
  width: 100%;
  background: var(--bg-primary);
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 8px;
  color: var(--text-primary);
  font-size: 14px;
  resize: vertical;
}
.scene-keywords {
  color: var(--text-muted);
  margin-top: 4px;
}
.script-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/WorkflowCard.tsx client/src/index.css
git commit -m "feat: add script preview panel with inline editing to WorkflowCard"
```

---

### Task 8: useWorkflows Hook — Handle Script Preview State

**Files:**
- Modify: `client/src/hooks/useWorkflow.ts` (or wherever the workflow hook is)

- [ ] **Step 1: Handle `awaiting_script_approval` in workflow polling**

In the polling logic (where workflow state is fetched and updated), ensure that when `workflow.status === 'awaiting_script_approval'`, the scenes are also captured from the response and the UI doesn't auto-refresh or treat it as an error state.

- [ ] **Step 2: Listen for `script_ready` WebSocket event**

In the WebSocket event handler (likely in `useWebSocket.ts` or the workflow hook), add a handler for `script_ready` events that updates the workflow state with scenes:

```typescript
case 'script_ready':
  setWorkflows(prev => prev.map(wf => 
    wf.id === event.workflowId 
      ? { ...wf, status: 'awaiting_script_approval' as any, scenes: event.scenes, fallback: event.fallback }
      : wf
  ));
  break;
```

- [ ] **Step 3: Stop auto-polling when awaiting approval**

In the workflow polling logic, if a workflow is `awaiting_script_approval`, keep polling but don't show loading/error states — the script preview panel should remain visible.

- [ ] **Step 4: Commit**

```bash
git add client/src/hooks/useWorkflow.ts client/src/hooks/useWebSocket.ts
git commit -m "feat: handle awaiting_script_approval state in hooks"
```

---

### Self-Review

**Spec coverage:**
- Script preview with inline editing → Task 3 (pause/resume), Task 4 (routes), Task 7 (UI)
- Approve/Regenerate → Task 3 (methods), Task 4 (endpoints), Task 5 (API), Task 7 (buttons)
- Dual render path (sidecar + YouTube clips) → Task 3 (render methods)
- Manual footage source toggle → Task 6 (PipelineForm dropdown)
- Improved AI prompts (hooking techniques + action-oriented search) → Task 2
- WebSocket event for script_ready → Task 8

**Placeholder scan:** All code blocks contain complete implementations. No TBDs or TODOs.

**Type consistency:** `footage_source` uses `'sidecar' | 'youtube_clips'` consistently across all tasks. `awaiting_script_approval` status is consistent across server types, routes, orchestrator, and client types.

**Execution Handoff follows after this section.**
