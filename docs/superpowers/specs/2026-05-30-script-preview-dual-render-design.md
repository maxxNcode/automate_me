# Script Preview + Dual Render Path Design

**Date:** 2026-05-30
**Status:** Approved

## Overview

Add a script preview step before video rendering, and support two parallel render paths (Docker sidecar for stock footage, YouTube clips for gameplay).

## Architecture

### Pipeline Flow

```
Generate → AI Scenes → SCRIPT PREVIEW (NEW) → Approve → Voiceover → Render
                                               → Regenerate → (loop back to AI Scenes)
```

### Script Preview

**Backend:**
- New workflow status: `awaiting_script_approval`
- After AI scene generation (`generateAIScenes`), pipeline stores scenes in workflow state and pauses
- `POST /api/workflow/:id/approve-script` — accepts edited scenes JSON, resumes pipeline to voiceover
- `POST /api/workflow/:id/re-generate-script` — re-runs AI scene generation with same topic/params
- Script preview is common to both Short and Tutorial styles (Tutorial gets full script text, Short gets scene array)

**Frontend:**
- PipelineForm submits workflow as before
- When workflow status changes to `awaiting_script_approval`, WorkflowCard shows:
  - Script preview panel with each scene text + search terms
  - Inline editing (click text to edit)
  - "Approve" button → POST approve-script with edited scenes
  - "Regenerate" button → POST re-generate-script
  - "Cancel" button → POST cancel (existing)

### Dual Render Path

**Backend types:**
- Add `footage_source: 'sidecar' | 'youtube_clips'` to `PipelineRequest`
- Add to workflow state for persistence

**Render flow after voiceover:**

```
If footage_source === 'sidecar':
    1. Send scenes to ShortVideoMaker client (Docker sidecar, port 3123)
    2. Poll for completion
    3. Download rendered video
    4. Delete video from sidecar (cleanup)
    
If footage_source === 'youtube_clips':
    1. Download YouTube gameplay clips via youtube_footage.py
    2. Assemble via ffmpeg_video.py scene assembly
```

**Frontend:**
- PipelineForm gets new dropdown: **"Footage Source"**
  - Option 1: `Stock (Pexels)` — uses Docker sidecar
  - Option 2: `Gameplay (YouTube)` — uses YouTube clips
- Default: `Stock (Pexels)` (matches current behavior for new users)
- WorkflowCard shows which source was used in results

**Sidecar re-integration:**
- `ShortVideoMaker` class already exists in `shortVideoMaker.ts` — no changes needed
- Orchestrator already imports `ShortVideoScene` type
- Re-implement sidecar render path in `executeShortPipeline`:
  - Instantiate `new ShortVideoMaker()`
  - Build `config` (music, captionPosition, orientation)
  - Call `sidecar.createVideo(scenes, config)`
  - Poll `sidecar.getStatus(videoId)` every 3s, max 120 attempts
  - Call `sidecar.downloadVideo(videoId)`
  - Call `sidecar.deleteVideo(videoId)` after download

### AI Prompt Improvement

**Script structure:**
- Remove rigid structure rules from SCENES_SYSTEM_PROMPT
- Replace with hooking technique descriptions:
  - Curiosity gaps ("What happens next?")
  - Bold claims ("This changes everything")
  - Pattern interrupts ("Stop doing X")
  - Specific data points (numbers, percentages)
  - Emotional triggers (fear of missing out, aspiration, surprise)
- Let AI decide scene arrangement naturally based on topic

**Search terms (visual control):**
- Each scene gets `searchTerms` (4-5 keywords) that describe CONCRETE, ACTION-ORIENTED visuals
- NOT generic keywords like "minecraft" or "football"
- BUT action-specific descriptions like "player mining diamond with iron pickaxe" or "crowd cheering at stadium goal celebration"
- This gives the render system better footage matches, whether using Pexels (sidecar) or YouTube clips
- Examples of good vs bad search terms included in the prompt

### Files to Change

| File | Changes |
|------|---------|
| `server/src/types.ts` | Add `awaiting_script_approval` status, `footage_source` field, `ScriptPreviewResult` type |
| `server/src/services/workflowOrchestrator.ts` | Add preview pause/resume, dual render path in executeShortPipeline, re-integrate ShortVideoMaker |
| `server/src/routes/workflow.ts` | Add POST approve-script, POST re-generate-script endpoints |
| `server/src/services/aiProvider.ts` | Rewrite SCENES_SYSTEM_PROMPT with hooking techniques |
| `client/src/types.ts` | Add footage source, script preview types |
| `client/src/api/workflow.ts` | Add approveScript, regenerateScript API calls |
| `client/src/components/PipelineForm.tsx` | Add Footage Source dropdown |
| `client/src/components/WorkflowCard.tsx` | Add script preview panel with inline editing |
| `client/src/hooks/useWorkflows.ts` | Handle awaiting_script_approval state, polling for script preview |

### Error Handling

- If sidecar is unavailable when `footage_source === 'sidecar'`, emit error with clear message ("Docker sidecar not running — start it with docker compose up -d")
- If YouTube clip download fails, fall back to audio-only gradient video (current behavior)
- Script approve with invalid JSON → 400 error
- Script approve on workflow not in awaiting_script_approval → 409 conflict
