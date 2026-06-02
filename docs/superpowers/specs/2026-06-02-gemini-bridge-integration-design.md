# Gemini Bridge Integration: Stickman Video Generation

## Goal

Replace the failing local Stable Diffusion stickman pipeline with a Gemini-powered image generation pipeline driven by the user's existing Chrome extension (`C:\Users\Admin\Desktop\geminiauto\`). User clicks "Generate Video" in the youtubeauto UI as today; the backend silently orchestrates the extension to produce one image per scene, then assembles the video as before.

The user's prior workflow tried multiple LoRAs, SD 1.5, SDXL, and Flux models to produce accurate simple cartoon stickman scenes. All produced "messy images." The Gemini web interface, accessed through a browser extension the user already built, produces acceptable results. This spec integrates that extension into the youtubeauto pipeline.

## User-visible behavior

- One click in the youtubeauto UI starts a complete video workflow. No popup interaction.
- The "Gemini Story" footage source replaces "Stickman Story" in the existing radio button.
- The user must have Chrome open with `https://gemini.google.com` loaded and be signed in to a Google account. The extension must be installed in that Chrome.
- If any of the above is missing, the workflow pauses for 60s waiting for the bridge to come online, then fails with a clear, actionable error message.

## Architecture

```
┌─────────────────┐                              ┌──────────────────────────┐
│  React client   │   WS events (existing)       │  Node Express server     │
│  (port 5173)    │ ◀──────────────────────────▶ │  (port 3001)             │
└─────────────────┘                              │                          │
                                                │  ┌────────────────────┐  │
                                                │  │  GeminiBridge TS   │  │ ◀──┐
                                                │  │  (long-poll queue) │  │    │ HTTP long-poll
                                                │  └─────────┬──────────┘  │    │ (localhost:3001)
                                                │            │             │    │
                                                │  ┌─────────▼──────────┐  │    │
                                                │  │  workflowOrchestr. │  │    │
                                                │  │  → spawns python   │  │    │
                                                │  └─────────┬──────────┘  │    │
                                                └────────────┼─────────────┘    │
                                                             │                  │
                                                  python    │  stdout/stderr   │
                                                  subprocess│                  │
                                                             ▼                  │
                                                ┌──────────────────────────┐   │
                                                │  gemini_story.py         │   │
                                                │  (waits for bridge to    │   │
                                                │   deliver N images, then │   │
                                                │   calls ffmpeg_video.py) │   │
                                                └──────────────────────────┘   │
                                                                               │
                                                                               │
┌────────────────────────────────────────────────┐  HTTP long-poll   ┌─────────┴────────┐
│  Chrome — gemini.google.com tab                │ ◀──────────────── │  Content script  │
│  ┌──────────────────────────────────────────┐  │                   │  (in tab)        │
│  │  Content script: poll → type → click    │  │  HTTP POST result  │  • polls /poll   │
│  │  → wait for <img> → fetch + POST bytes  │  │ ─────────────────▶ │  • POSTs /result │
│  └──────────────────────────────────────────┘  │                   │  • polls /ping   │
└────────────────────────────────────────────────┘                   └──────────────────┘
```

### Runtimes and trust boundaries

- **Node server (port 3001, 127.0.0.1 only).** The bridge endpoint binds to localhost. Extension content scripts on the user's local Chrome are the only callers. No external network.
- **Python subprocess.** Spawned by the orchestrator, calls the bridge endpoint on the local server, waits for completion. Uses `urllib.request` (stdlib) for HTTP — no new Python dependencies.
- **Chrome content script.** Runs in `https://gemini.google.com/*` page context. Has access to Gemini's DOM and the user's session cookies. Uses the existing helpers (`enterPrompt`, `clickSend`, `checkForNewImages`).
- **No changes** to the React UI other than renaming one radio button and adding a small "Bridge: connected / waiting" status badge.

## Components

### New: `server/src/services/geminiBridge.ts` (~200 LOC)

Server-side bridge. Exposes 5 HTTP endpoints, all bound to `127.0.0.1:3001`, registered in `server/src/index.ts`:

| Endpoint | Method | Caller | Body | Response | Purpose |
|---|---|---|---|---|---|
| `/gemini-bridge/ping` | GET | extension | — | `{ready: boolean, reason?: string}` | Readiness check from extension |
| `/gemini-bridge/poll` | GET | extension | `?workflowId=X` | `{job?: {workflowId, sceneIndex, prompt, promptSlug, timeoutMs}, status: 'running'\|'complete', reason?: string}` | Long-poll: extension asks "what's next?" every 2s |
| `/gemini-bridge/result` | POST | extension | `multipart/form-data` with `workflowId`, `sceneIndex`, `imageBlob` | `{ok: true}` | Extension returns generated image bytes |
| `/gemini-bridge/enqueue` | POST | python | `{workflowId, prompts: [{sceneIndex, prompt}]}` | `{ok: true, count: N}` | Python enqueues the scene prompts |
| `/gemini-bridge/await-images` | GET | python | `?workflowId=X` | `{ok: true, images: [{sceneIndex, base64}]}` | Python retrieves the received image buffers |

**Special workflowId values for `/poll`:**
- `?workflowId=discover` — returns the next un-consumed job from ANY active workflow (across all workflowIds). Response includes the actual `workflowId` in the `job` field. This is how the extension learns about new workflows.
- `?workflowId=<uuid>` — returns the next un-consumed job for that specific workflow.

**Internal state:**

- Module-level: `lastPing: {ready: boolean, reason?: string, at: number} | null` — the most recent `/ping` from any extension. Used by `getReadiness()`. Liveness check: if `Date.now() - lastPing.at > 30_000`, treat as no extension.
- Per-workflow: `Map<workflowId, WorkflowBridgeState>` where `WorkflowBridgeState = { jobs: Array<{sceneIndex, prompt, promptSlug, timeoutMs}>, results: Map<sceneIndex, {buffer: Buffer, attempts: number, receivedAt: number}>, status: 'ready'\|'active'\|'complete'\|'failed' }`.

**Exports:**
- `enqueuePrompts(workflowId, prompts: Array<{sceneIndex, prompt}>): void` — populates the queue. Idempotent: re-enqueueing the same workflowId resets the queue (used for server-restart recovery).
- `awaitImages(workflowId, expectedCount, timeoutMs): Promise<Map<sceneIndex, Buffer>>` — blocks until all expected scenes have a buffer, or throws `BridgeTimeoutError`/`BridgeSceneRetryExceededError`.
- `getReadiness(): {ready: boolean, reason?: string}` — returns `lastPing` if it was within 30s, else `{ready: false, reason: 'no_extension'}`. This is a global read (not per-workflow).
- `recordSceneFailure(workflowId, sceneIndex): void` — increments retry counter. Auto-fails the workflow after 3.
- `cleanup(workflowId): void` — removes all state. Called by orchestrator on workflow completion or failure.

**WebSocket events emitted:** `bridge_status` with `{workflowId, status: 'initializing'\|'ready'\|'active'\|'complete'\|'failed'\|'timeout', message: string, progress?: {received: number, total: number}}`. Subscribed clients (the React UI) render this as a small badge.

### New: `python/gemini_story.py` (~250 LOC, replaces `sd_api_story.py`)

Replaces local SD rendering. New responsibilities:

1. Read input JSON from stdin: `{workflowId, scenes: [{sceneIndex, prompt, durationSeconds}], audio_path, output_filename, resolution, fps}`.
2. POST `http://127.0.0.1:3001/gemini-bridge/enqueue` with `{workflowId, prompts: scenes.map(s => ({sceneIndex, prompt}))}`. (Server-side endpoint that calls `geminiBridge.enqueuePrompts`.)
3. Loop: GET `/gemini-bridge/poll?workflowId=X` until response has `status: 'complete'` or sentinel `reason: 'unknown_workflow'`. Log progress to stderr: `[gemini_story] waiting for images (0/N received)`.
4. GET `/gemini-bridge/await-images?workflowId=X` (server-side, calls `geminiBridge.awaitImages`). Save each `Buffer` to `data/projects/<workflowId>/scenes/scene_<sceneIndex>_<slug>.png` (slug = sanitized first 30 chars of prompt).
5. Invoke `ffmpeg_video.py` as subprocess (unchanged from `sd_api_story.py`): `--images <scenes_dir> --audio <audio_path> --output <output_filename> --resolution 768x432 --fps 10 --subtitles true`.
6. Return same JSON shape as `sd_api_story.py` did: `{success, file_path, filename, duration_seconds, file_size_bytes, resolution, fps, subtitles, fallback, error?}`.

**No new Python dependencies.** Uses `urllib.request` (stdlib) for HTTP. `ffmpeg_video.py` and `requirements.txt` are unchanged.

### Modified: `geminiauto/content.js`

Two coexisting modes. The popup-driven batch mode is **kept** (legacy/manual). The new bridge mode is **preferred** when the server has work.

**New function `bridgeLoop(workflowId)`:**

```js
async function bridgeLoop(workflowId) {
  while (true) {
    let poll;
    try {
      poll = await pollBridge(workflowId);
    } catch (e) {
      // network blip — backoff and retry
      await sleep(2000);
      continue;
    }
    if (poll.status === 'complete') return;
    if (poll.reason === 'unknown_workflow') {
      log('Server lost bridge state for workflow ' + workflowId, 'error');
      return;
    }
    if (!poll.job) { await sleep(2000); continue; }
    const imageBlob = await generateOneImage(poll.job.prompt, poll.job.timeoutMs);
    if (imageBlob) {
      await postBridgeResult(workflowId, poll.job.sceneIndex, imageBlob);
    }
    // else: empty result, don't advance — server will re-deliver on next poll
  }
}
```

**New function `generateOneImage(prompt, timeoutMs)`:**
1. `enterPrompt(prompt)` — existing helper.
2. Wait 1s for UI to register.
3. `clickSend()` — existing helper.
4. `checkForNewImages(imageSelector, timeoutMs)` — existing helper.
5. If returns `[]`, return `null`.
6. If returns URLs, `fetch(firstUrl, {credentials: 'include'})` → `Blob`.
7. Return the Blob (or `null` if MIME isn't `image/*`).

**New function `pollBridge(workflowId)`:**
```js
async function pollBridge(workflowId) {
  const res = await fetch(`http://127.0.0.1:3001/gemini-bridge/poll?workflowId=${encodeURIComponent(workflowId)}`);
  if (!res.ok) throw new Error('poll failed: ' + res.status);
  return res.json();
}
```

The response shape: `{job?: {workflowId, sceneIndex, prompt, promptSlug, timeoutMs}, status: 'running'|'complete', reason?: string}`. The `workflowId` is always present in `job` (even for normal polls, for defensive consistency) and is required for the `discover` workflowId case.

**New function `postBridgeResult(workflowId, sceneIndex, blob)`:**
```js
async function postBridgeResult(workflowId, sceneIndex, blob) {
  const form = new FormData();
  form.append('workflowId', workflowId);
  form.append('sceneIndex', String(sceneIndex));
  form.append('imageBlob', blob, 'image.png');
  const res = await fetch('http://127.0.0.1:3001/gemini-bridge/result', { method: 'POST', body: form });
  if (!res.ok) throw new Error('result POST failed: ' + res.status);
}
```

**New function `pingReadiness()`:** returns `{ready, reason}`. Checks:
- `location.host === 'gemini.google.com'` (else `reason: 'gemini_tab_not_open'`)
- Profile menu present: `document.querySelector('div[data-user-id]')` or `img[alt*="Profile"]` (else `reason: 'not_signed_in'`)
- Popup batch not active: `(await chrome.storage.local.get('batchState')).batchState?.isRunning` is false OR paused (else `reason: 'popup_busy'`)

**Mode arbitration:** on page load and on every storage change, if `bridgeStatus.currentWorkflowId` is set OR a poll returned a job for an unknown workflowId, the script enters bridge mode and refuses popup mode for the duration. If the popup is already running when a poll returns a job, the bridge script logs the conflict and the server's 60s auto-wake timer will fire.

**Auto-poll on page load:** after page idle, content script starts a "discover" loop — every 5s, GET `/gemini-bridge/poll?workflowId=discover`. The server's response includes the actual `workflowId` of the next un-consumed job (if any). The extension switches to bridge mode for that workflowId. This is how the extension learns about new workflows without the server pushing.

### Modified: `geminiauto/manifest.json`

Add to `host_permissions`:
```json
"http://127.0.0.1:3001/*"
```

Existing `https://gemini.google.com/*`, `https://*.googleusercontent.com/*`, `https://*.gstatic.com/*` stay.

### Modified: `geminiauto/popup.html`, `popup.js`, `popup.css`

Unchanged. Legacy popup mode is preserved as-is.

### Modified: `server/src/services/workflowOrchestrator.ts`

- Rename `renderWithStickmanStory` → `renderWithGeminiStory` (line 653).
- Body replaced: instead of building `sd_api_payload` and calling `sd_api_story.py`, call `gemini_story.py` with `{workflowId, scenes: scenes.map((s, i) => ({sceneIndex: i, prompt: ..., durationSeconds: ...})), audio_path, output_filename, resolution: '768x432', fps: 10}`.
- Same WebSocket event emissions and step status updates — the UI doesn't need to know the implementation changed.
- Remove `_renderStickmanVideo` method (the old SD-rendering path). The new method calls `runPythonScript('gemini_story.py', ...)` directly.
- The "auto-generate SD payloads from AI scenes" fallback (lines 671-689) is gone — scenes come from `stickman_master_json` or from the script generator's `sd_api_payload.prompt` field, both of which are reused as Gemini prompts verbatim.
- On `runPythonScript` failure, emit clear log: `[video_assembly] Gemini generation failed: <stderr>`. Surface error in `results.video_assembly.error`.

### Modified: `server/src/types.ts`

- `WorkflowState.footage_source` and `PipelineRequest.footage_source`: change `'stickman_story'` → `'gemini_story'`.
- Add `WorkflowState.gemini_scenes_dir?: string` (path where generated PNGs are saved, set by `gemini_story.py` via stdout JSON).
- Add `WsEvent.type` union: include `'bridge_status'`.

### Modified: `server/src/index.ts`

- Mount the 5 bridge routes (3 extension-facing: `/ping`, `/poll`, `/result`; 2 server-only: `/enqueue`, `/await-images`) that wrap the bridge service.
- Add WS broadcast hook so `geminiBridge` can push `bridge_status` events to subscribed clients.

### Modified: `client/src/components/Pipeline/`

- One radio button rename: `Stickman Story` → `Gemini Story` (label + value).
- One new UI state: when the workflow is in `renderWithGeminiStory` step, render a small "Bridge: connected / waiting / 3/8 received" badge that subscribes to the `bridge_status` WS event. Pure presentation, no interaction.

### Deleted files

- `python/sd_api_story.py`
- `python/stable_diffusion.py` (used only by SD thumbnail/thumbnail-pipeline; verify no other callers before deletion)
- `python/train_stickman_lora.py`, `python/train_stickman_lora_v2.py`, `python/train_v3.py`
- `python/lora_weights/` (6 safetensors + metadata.json)
- `python/stickman/`, `python/training_data/`, `python/training_data_synthetic/`
- `setup_ai_model.py` (was a ComfyUI model downloader; verify before deletion)

### Unchanged files

- `server/src/services/shortVideoMaker.ts`
- `python/ffmpeg_video.py`
- `python/requirements.txt` (existing deps unchanged — `gemini_story.py` uses stdlib)
- `docker-compose.yml`
- All other client React components
- All launcher scripts

## Data flow: one full cycle

```
[1] User clicks "Generate Video" in React UI
       │
       ▼
[2] POST /api/workflow → routes/workflow.ts → orchestrator.createWorkflow(...)
       │
       ▼
[3] Orchestrator runs script_generation step (existing, unchanged)
    AI provider returns scenes[] each with {text, searchTerms, sd_api_payload.prompt}
       │
       ▼
[4] Orchestrator runs voiceover step (existing, unchanged)
    Produces audio_path, computes scene→word timing
       │
       ▼
[5] Orchestrator enters renderWithGeminiStory(workflowId, scenes, audioPath)
       │
       ├─▶ Emit WS: step_update video_assembly=running
       ├─▶ Emit WS: bridge_status "initializing"
       │
       ▼
[6] orchestrator.runPythonScript('gemini_story.py', {...})
    Python subprocess starts.
       │
       ▼
[7] gemini_story.py: POST http://127.0.0.1:3001/gemini-bridge/enqueue
    Body: {workflowId, prompts: [{sceneIndex: 0, prompt: "..."}, ...]}
       │
       ▼
[8] geminiBridge.enqueuePrompts(workflowId, prompts)
    Populates in-memory queue. Emits WS: bridge_status "ready"
    Returns immediately.
       │
       ▼
[9] gemini_story.py: enters wait loop. Logs "waiting for N images..." to stderr.
       │
       ▼
[10] Meanwhile, in Chrome — content script (already loaded on gemini.google.com)
     "Discover" loop polls /poll?workflowId=discover.
     Server returns a job with workflowId=X in the job.workflowId field.
     Content script enters bridgeLoop(X)
       │
       ▼
[11] bridgeLoop gets {job: {sceneIndex: 0, prompt: "..."}, status: 'running'}
     Calls generateOneImage(prompt, 60000):
       - enterPrompt(prompt) → clickSend() → checkForNewImages(60000)
       - returns Blob of fetched image
       │
       ▼
[12] Content script: POST /gemini-bridge/result with multipart body
     {workflowId, sceneIndex: 0, imageBlob: <blob>}
       │
       ▼
[13] geminiBridge stores buffer keyed by sceneIndex.
     Emits WS: bridge_status "received image for scene 0 (1/N)"
       │
       ▼
[14] bridgeLoop polls again. Gets next job (sceneIndex 1).
     Repeats steps 11-13.
       │
       ▼
[15] After all N scenes received:
     gemini_story.py's GET /gemini-bridge/poll returns {job: null, status: 'complete'}
     gemini_story.py then GETs /gemini-bridge/await-images?workflowId=X
     Receives the Map<sceneIndex, Buffer>. Saves to:
       data/projects/<workflowId>/scenes/scene_0_<slug>.png
       data/projects/<workflowId>/scenes/scene_1_<slug>.png
       ...
       │
       ▼
[16] gemini_story.py invokes ffmpeg_video.py as subprocess
       │
       ▼
[17] ffmpeg_video.py returns JSON. gemini_story.py relays to stdout.
     runPythonScript resolves with the VideoResult.
       │
       ▼
[18] Orchestrator: results.video_assembly = ...
     updateStep(workflowId, 'video_assembly', 'completed')
     completeWorkflow(workflowId, results, filePath)
       │
       ▼
[19] WS: workflow_complete event. React UI shows "Done, play video".
```

### Correlation: which image is which?

Three identifiers must agree at every hop:
- `workflowId` (string, UUID) — identifies the youtubeauto workflow
- `sceneIndex` (integer, 0..N-1) — identifies which scene within the workflow
- `promptSlug` (string, derived from prompt) — used for the saved filename: `scene_<sceneIndex>_<slug>.png`

The server is the source of truth for `sceneIndex` (it assigns them when enqueueing). The extension echoes them back unchanged.

## State & lifecycle

### A. Workflow orchestrator (server)

```
idle → queued → running → completed
                  │
                  ├──→ failed
                  │
                  ├──→ awaiting_script_approval (existing)
                  │
                  └──▶ running with bridge_status="awaiting_browser" (NEW)
                              │
                              ├──→ running with bridge_status="ready" (extension pings ready)
                              │
                              └──→ failed (60s timeout)
```

`awaiting_browser` is a sub-state of the `video_assembly` step. `workflow_state.workflow_status` stays `running`. WS event: `{type: 'bridge_status', workflowId, status: 'awaiting_browser', message: '...'}`.

The 60s auto-wake timeout is in `geminiBridge.awaitImages()`:

```ts
const deadline = Date.now() + 60_000;
while (!ready && Date.now() < deadline) {
  await sleep(1000);
  const ping = await this.getReadiness();
  if (ping.ready) break;
}
if (!ready) throw new BridgeTimeoutError('Extension not ready within 60s');
```

### B. Gemini bridge (server, in-memory)

State per workflowId:

```
absent ──enqueuePrompts──▶ ready ──poll returns job──▶ active
                                  ──all results received──▶ complete
                                  ──error/timeout──▶ failed
                                  ──cleanup()──▶ absent
```

Server restart wipes state. `gemini_story.py` calling `/enqueue` after a restart creates a fresh state and the extension's next poll sees the new jobs. `gemini_story.py` calling `/poll` for a workflowId with no state gets `{job: null, status: 'running', reason: 'unknown_workflow'}` and exits non-zero after 2 consecutive unknown-workflow responses.

### C. Content script (extension)

State in module-level variable, no persistence:

```
idle ──discover poll returns job──▶ bridge_mode(workflowId)
                                       │
                                       ├───/poll returns complete──▶ idle
                                       │
                                       └───error/timeout──▶ bridge_error ──(30s)──▶ idle
```

Popup mode and bridge mode are mutually exclusive. If popup is running and a poll returns a job, the content script logs the conflict and the server's 60s timer fires.

## Error handling

### Bridge connectivity

| Failure | Detection | Response |
|---|---|---|
| Server not running when extension polls | `fetch` throws | Content script retries every 5s. No user impact. |
| Extension not running when server enqueues | `getReadiness()` returns `ready: false, reason: 'no_extension'` after 30s | Auto-wake waits 60s, then fails workflow. |
| Server restarts mid-workflow | `gemini_story.py` polls, gets `reason: 'unknown_workflow'` | Python script exits non-zero. Orchestrator fails workflow. No silent hangs. |
| Port 3001 in use | Server fails to start | Existing launcher behavior. Out of scope. |

### Extension readiness

`/ping` returns the most specific reason:

| Reason | Meaning | User-facing error |
|---|---|---|
| `no_extension` | No ping in last 30s | "Gemini Bridge extension not detected. Install from <path> and click Generate again." |
| `gemini_tab_not_open` | Content script on wrong page | "Open https://gemini.google.com in Chrome to start image generation." |
| `not_signed_in` | Profile menu absent | "Open gemini.google.com and sign in to your Google account, then click Generate again." |
| `popup_busy` | Popup-driven batch active | "Extension is busy with a manual batch. Finish or cancel it, then click Generate again." |

### Per-scene generation failures

| Failure | Detection | Response |
|---|---|---|
| Gemini never returns (timeout) | `checkForNewImages` 60s timeout → `[]` | Content script polls, gets same job, retries. After 3 retries, bridge auto-fails. |
| Gemini returns error placeholder | n/a in v1 | Pass-through. User reviews final video. |
| Gemini returns non-image | `img.naturalWidth === 0` or non-image MIME | Content script drops, polls same job, retries. 3-retry budget. |
| Image visually wrong | n/a | Pass-through. User reviews final video. (This was the original problem; the user's whole reason for switching to Gemini is that messy is the exception.) |

Retry state is `Map<sceneIndex, {attempts, lastAttemptAt}>` in the bridge. Counter resets on success.

### Python script failures

| Failure | Detection | Response |
|---|---|---|
| `ffmpeg_video.py` crashes | Non-zero exit | `gemini_story.py` returns `{success: false, error: stderr}`. Orchestrator fails workflow. |
| Disk full | `OSError` on write | Same as above. |
| Bridge connection drops while waiting | `unknown_workflow` sentinel | Python exits non-zero. Orchestrator fails workflow. |

### Out of scope (v1)

- Visual quality heuristics for "messy" images. User reviews final video.
- Resume after Chrome restart. User starts a new workflow.
- Multiple concurrent workflows. One at a time.
- Cross-browser (Firefox/Safari). Chrome MV3 only.
- Encrypted/credentialed Gemini responses. Extension fetches with browser cookies automatically.

## Testing

### Layer 1: Bridge server unit tests

**File:** `server/src/services/__tests__/geminiBridge.test.ts` (~150 LOC)

Node's built-in `node:test` + `assert/strict`. Run with `tsx --test`. Uses `@sinonjs/fake-timers` (one new dev dep) for timeout tests.

Test cases:
1. `enqueuePrompts` adds jobs to a fresh workflowId's queue.
2. `enqueuePrompts` is idempotent (re-enqueue resets).
3. `getReadiness` returns `ready: false` when no extension has pinged.
4. `getReadiness` returns `ready: true` when extension pinged within 30s reporting ready.
5. `getReadiness` returns `ready: false` when last ping was >30s ago (liveness).
6. `getReadiness` surfaces reason from most recent ping.
7. Posting a result stores the buffer keyed by `sceneIndex`.
8. `awaitImages` resolves with all expected sceneIndex → Buffer pairs.
9. `awaitImages` rejects with `BridgeTimeoutError` if extension never connects within `timeoutMs`.
10. `awaitImages` rejects if a scene's retry counter exceeds 3.
11. `cleanup(workflowId)` removes all state.
12. Two workflows in parallel don't interfere.
13. `poll('discover')` returns a job from any active workflow with `workflowId` in the job.
14. `poll('unknown_workflow')` returns `{job: null, status: 'running', reason: 'unknown_workflow'}` for an unknown workflowId.

### Layer 2: Python script smoke test

**File:** `python/test_gemini_bridge_mock.py` (~80 LOC)

Mocks the bridge server with `http.server` in-process. Runs `gemini_story.py` as subprocess with a fake `workflowId`, pre-seeds the mock bridge with 2 fake jobs and fake image bytes, verifies the script polls, posts results, calls `ffmpeg_video.py` (also mocked), and returns the expected JSON shape.

Run manually. Exit code 0 = pass. Not wired into CI.

### Layer 3: Extension content script unit tests

**File:** `geminiauto/__tests__/content.test.js` (~200 LOC)

Plain `node:test` + `assert/strict` + minimal DOM stub. **Options for DOM:**
- `linkedom` (small, fast, ~50KB, pure-JS) — preferred, one new dev dep on the extension.
- Hand-rolled `document.querySelector` stub for the 3 selectors actually used (profile menu, contenteditable, send button).

The existing `popup.html` DOM is not tested (it's pure presentation and only relevant in the manual smoke test).

Test cases:
1. `enterPrompt` sets the contenteditable's innerHTML correctly.
2. `enterPrompt` triggers `input` and `change` events.
3. `clickSend` finds the configured button by selector.
4. `clickSend` falls back to aria-label/title heuristic.
5. `checkForNewImages` resolves with new image URLs only.
6. `checkForNewImages` waits for `complete` and `naturalWidth !== 0` before resolving.
7. `checkForNewImages` times out and resolves with `[]`.
8. `bridgeLoop` exits cleanly when `/poll` returns `status: complete`.
9. `bridgeLoop` skips to next scene after posting a result.
10. `pingReadiness` returns `gemini_tab_not_open` when `location.host` doesn't match.
11. `pingReadiness` returns `not_signed_in` when profile menu selector is absent.
12. `pingReadiness` returns `popup_busy` when `batchState.isRunning` is true and not paused.
13. Bridge mode and popup mode are mutually exclusive.
14. The discover poll (`workflowId=discover`) transitions the content script to bridge mode and uses the `workflowId` from the response.

### Layer 4: End-to-end manual smoke test

**File:** `scripts/smoke-bridge.sh` (~30 LOC) + a checklist in the spec

Manual, one person, ~20 minutes. Requires real Chrome + real Gemini session.

1. `pnpm dev` — confirm server starts on 3001.
2. Load unpacked extension in Chrome → confirm popup opens → status badge "Idle".
3. Open `https://gemini.google.com` → confirm content script logs.
4. In youtubeauto UI, pick topic, set `footage_source: 'gemini_story'`, click Generate.
5. Confirm UI shows "Bridge: initializing" then "Bridge: ready" within 5s.
6. Confirm UI logs `🌉 Bridge: received scene 1/N` every 10-30s.
7. After N scenes, confirm ffmpeg step runs, output mp4 in `output/`.
8. Play the mp4 — verify correct scenes + audio.
9. **Negative:** stop the bridge, click Generate, confirm 60s timeout error.
10. **Negative:** sign out of gemini.google.com, click Generate, confirm `not_signed_in` error.

### What we explicitly do NOT test

- Real Gemini output quality. Subjective, depends on user's session.
- Cross-browser.
- Concurrent workflows.
- The React UI's `bridge_status` badge (manual smoke test only).
- The deleted SD pipeline (gone, no regression risk).

### Coverage targets

- Bridge server: 100% of branches in `geminiBridge.ts`.
- Python script: smoke test only (happy path + 1 error).
- Extension content script: 80% of branches in new bridge-related functions.
- End-to-end: manual, run before declaring done.

### New test dependencies

- Server: `@sinonjs/fake-timers` (dev only).
- Extension: none — uses `node:test` (Node 20+).
- Python: stdlib only.

## Files changed

```
NEW  server/src/services/geminiBridge.ts                  # Bridge HTTP + state machine
NEW  server/src/services/__tests__/geminiBridge.test.ts  # Unit tests
NEW  python/gemini_story.py                               # Replaces sd_api_story.py
NEW  python/test_gemini_bridge_mock.py                    # Smoke test
NEW  geminiauto/__tests__/content.test.js                 # Extension unit tests
NEW  scripts/smoke-bridge.sh                              # Manual smoke checklist

MOD  server/src/services/workflowOrchestrator.ts          # renderWithGeminiStory replaces renderWithStickmanStory
MOD  server/src/index.ts                                 # Mount bridge routes + WS hook
MOD  server/src/types.ts                                 # footage_source value, bridge_status WS event type
MOD  client/src/components/Pipeline/                      # Radio button rename + bridge_status badge

DEL  python/sd_api_story.py
DEL  python/stable_diffusion.py                           # Verify no other callers first
DEL  python/train_stickman_lora.py
DEL  python/train_stickman_lora_v2.py
DEL  python/train_v3.py
DEL  python/lora_weights/                                # 6 safetensors + metadata
DEL  python/stickman/
DEL  python/training_data/
DEL  python/training_data_synthetic/
DEL  setup_ai_model.py                                    # Verify no callers first
```

## Out of scope (first version)

- Image approval gate (user reviews each generated image before assembly).
- Auto-retry on bad generations (visual quality heuristics).
- Resume after Chrome restart.
- Multiple concurrent workflows.
- Cross-browser support (Firefox/Safari).
- Per-scene prompt engineering for Gemini (reuse existing `sd_api_payload.prompt` verbatim).
- Encrypted Gemini response handling.
