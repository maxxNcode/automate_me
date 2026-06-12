/**
 * Workflow Routes
 * REST API endpoints for the YouTube automation pipeline.
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { WorkflowOrchestrator } from '../services/workflowOrchestrator';
import { PipelineRequest, ApiResponse, WorkflowStep, VoiceoverResult } from '../types';
import { getOutputDir, runPythonScript } from '../services/pythonRunner';
import { getDatabase } from '../services/database';

const sceneUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
const voiceoverUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// ========================================
// Voice Preview Caching
// ========================================

const PREVIEW_DIR = path.resolve(__dirname, '..', '..', '..', 'output', 'assets', 'voice_previews');
const PREVIEW_BASE_URL = '/api/workflow/preview-file';

/** All 19 American English Kokoro voices */
const AMERICAN_ENGLISH_VOICES = [
  'af_heart', 'af_bella', 'af_sarah', 'af_nicole', 'af_sky',
  'af_river', 'af_nova', 'af_alloy', 'af_jessica', 'af_kore',
  'am_adam', 'am_michael', 'am_liam', 'am_echo', 'am_eric',
  'am_onyx', 'am_fenrir', 'am_puck', 'am_santa',
];

/** A meaningful preview sentence that showcases each voice's character */
const PREVIEW_TEXT =
  "Under the vast canopy of the night sky, a single star began to pulse " +
  "with a light unseen for centuries. It carried a message from a world " +
  "beyond our own \u2014 a whisper of hope across the endless void.";

/**
 * Kick off background pre-generation of all voice previews.
 * Runs on server start so previews are cached and instant later.
 */
function startPreviewPreGeneration(): void {
  // Don't await — run in background
  (async () => {
    try {
      fs.mkdirSync(PREVIEW_DIR, { recursive: true });
      
      // Check which voices are already cached
      const cached = AMERICAN_ENGLISH_VOICES.filter(v => {
        const fp = path.join(PREVIEW_DIR, `preview_${v}.wav`);
        return fs.existsSync(fp) && fs.statSync(fp).size > 1000;
      });

      if (cached.length === AMERICAN_ENGLISH_VOICES.length) {
        console.log(`[PreviewPreGen] All ${cached.length} voices already cached`);
        return;
      }

      const pending = AMERICAN_ENGLISH_VOICES.length - cached.length;
      console.log(`[PreviewPreGen] Generating ${pending} missing voice previews...`);

      // Run the batch generation script
      const result = await runPythonScript<{ success: boolean; generated: number }>(
        'generate_all_previews.py',
        {} as Record<string, unknown>,
        { timeout: 300000 } // 5 min timeout for 19 generations
      );

      console.log(`[PreviewPreGen] Complete: ${result.generated || 0} new previews generated`);
    } catch (err) {
      console.error('[PreviewPreGen] Background generation failed:', err instanceof Error ? err.message : err);
      // Individual previews will be generated on-demand when requested
    }
  })();
}

/** Get the cached preview file path for a voice */
function getPreviewFilePath(voice: string): string {
  return path.join(PREVIEW_DIR, `preview_${voice}.wav`);
}

/** Check if a preview file is cached */
function isPreviewCached(voice: string): boolean {
  const fp = getPreviewFilePath(voice);
  return fs.existsSync(fp) && fs.statSync(fp).size > 1000;
}

/** Generate a single preview and cache it (blocking, for on-demand fallback) */
async function generateAndCachePreview(voice: string): Promise<string> {
  const outputFilename = `preview_${voice}.wav`;
  const result = await runPythonScript<{ success: boolean; file_path?: string }>(
    'kokoro_tts.py',
    {
      script: PREVIEW_TEXT,
      voice,
      speed: 1.0,
      output_filename: outputFilename,
    } as Record<string, unknown>,
    { timeout: 120000 }
  );

  if (!result.success || !result.file_path) {
    throw new Error(`Preview generation failed for ${voice}`);
  }

  // Ensure it's in the previews directory
  const destPath = getPreviewFilePath(voice);
  if (result.file_path !== destPath) {
    fs.copyFileSync(result.file_path, destPath);
    try { fs.unlinkSync(result.file_path); } catch {}
  }

  return destPath;
}

export function createWorkflowRoutes(orchestrator: WorkflowOrchestrator): Router {
  const router = Router();

  // Start background pre-generation of all voice previews
  startPreviewPreGeneration();

  /**
   * POST /api/workflow/start
   * Start a new full pipeline workflow.
   */
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
        username: request.username,
        tone: request.tone || 'educational',
        duration_minutes: Math.min(Math.max(request.duration_minutes || (request.style === 'short' ? 0.5 : 5), 0.25), 30),
        voice: request.voice,
        thumbnail_style: request.thumbnail_style || 'eye-catching',
        add_subtitles: request.add_subtitles ?? true,
        privacy_status: request.privacy_status || 'unlisted',
        auto_upload: request.auto_upload ?? false,
        style: request.style || 'tutorial',
        ai_model: request.ai_model,
        caption_position: request.caption_position,
        caption_background_color: request.caption_background_color,
        footage_source: request.footage_source || (request.style === 'short' ? 'youtube_clips' : undefined),
        aspect_ratio: request.aspect_ratio,
        manual_mode: request.manual_mode,
        story_scene_count: request.story_scene_count,
      });

      const response: ApiResponse = {
        success: true,
        data: result,
        message: 'Workflow started',
      };
      return res.status(201).json(response);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to start workflow';
      const response: ApiResponse = { success: false, error: errorMsg };
      return res.status(500).json(response);
    }
  });

  /**
   * POST /api/workflow/preview-voice
   * Returns a cached preview URL for a Kokoro voice.
   * Previews are pre-generated in the background on server start.
   * If not yet cached, generates on-demand (first request slow, subsequent instant).
   */
  router.post('/preview-voice', async (req: Request, res: Response) => {
    try {
      const voice = req.body.voice || 'af_heart';

      // Ensure the previews directory exists
      fs.mkdirSync(PREVIEW_DIR, { recursive: true });

      // Check cache
      if (!isPreviewCached(voice)) {
        // Generate on-demand (first time for this voice)
        await generateAndCachePreview(voice);
      }

      const url = `${PREVIEW_BASE_URL}/preview_${voice}.wav`;

      return res.json({
        success: true,
        data: {
          url,
          voice,
          cached: true,
          mimeType: 'audio/wav',
        },
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Preview failed' });
    }
  });

  /**
   * GET /api/workflow/preview-file/:voice.wav
   * Serve a cached preview WAV file.
   */
  router.get('/preview-file/:filename', (req: Request, res: Response) => {
    const filename = req.params.filename;

    // Validate filename to prevent path traversal
    if (!filename.endsWith('.wav') || !filename.startsWith('preview_')) {
      return res.status(400).json({ success: false, error: 'Invalid filename' });
    }

    const filePath = path.join(PREVIEW_DIR, filename);
    const normalized = path.resolve(filePath);
    const normalizedDir = path.resolve(PREVIEW_DIR);

    if (!normalized.startsWith(normalizedDir)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    if (!fs.existsSync(normalized)) {
      return res.status(404).json({ success: false, error: 'Preview not found' });
    }

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(normalized);
  });

  /**
   * POST /api/workflow/script
   * Generate a script only (standalone).
   */
  router.post('/script', async (req: Request, res: Response) => {
    try {
      const { topic, tone, duration_minutes } = req.body;
      if (!topic) {
        return res.status(400).json({ success: false, error: 'Topic is required' });
      }

      const result = await orchestrator.startPipeline({
        topic,
        tone: tone || 'educational',
        duration_minutes: Math.min(Math.max(duration_minutes || 5, 0.25), 30),
        auto_upload: false,
        style: 'tutorial',
      });

      // Return the script result from the workflow (poll for it)
      const response: ApiResponse = {
        success: true,
        data: result,
        message: 'Script generation started',
      };
      return res.json(response);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to generate script';
      return res.status(500).json({ success: false, error: errorMsg });
    }
  });

  /**
   * GET /api/workflow/:id/download
   * Download the generated video file for a completed workflow.
   * Available to all authenticated users (not just admin).
   */
  router.get('/:id/download', (req: Request, res: Response) => {
    const workflow = orchestrator.getWorkflow(req.params.id);
    if (!workflow) {
      return res.status(404).json({ success: false, error: 'Workflow not found' });
    }

    if (workflow.status !== 'completed') {
      return res.status(400).json({ success: false, error: 'Workflow is not completed yet' });
    }

    const videoResult = workflow.steps.video_assembly?.result as { file_path?: string; filename?: string } | undefined;
    const filePath = videoResult?.file_path;

    if (!filePath) {
      return res.status(404).json({ success: false, error: 'No video file available for this workflow' });
    }

    // Check if the file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Video file not found on disk (may have been cleaned up)' });
    }

    const filename = videoResult?.filename || path.basename(filePath);
    res.download(filePath, filename, (err) => {
      if (err) {
        console.error('[Download] Error sending file:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: 'Failed to send file' });
        }
      }
    });
  });

  /**
   * GET /api/workflow/:id
   * Get the current state of a workflow.
   */
  router.get('/:id', (req: Request, res: Response) => {
    const workflow = orchestrator.getWorkflow(req.params.id);
    if (!workflow) {
      const response: ApiResponse = {
        success: false,
        error: 'Workflow not found',
      };
      return res.status(404).json(response);
    }

    const response: ApiResponse = {
      success: true,
      data: workflow,
    };
    return res.json(response);
  });

  /**
   * GET /api/workflow/queue
   * Get the current queue state (position, who's generating, etc.)
   * IMPORTANT: This must come BEFORE /:id routes to avoid Express catching 'queue' as :id
   */
  router.get('/queue', (_req: Request, res: Response) => {
    const queueState = orchestrator.getQueueState();
    const response: ApiResponse = {
      success: true,
      data: queueState,
    };
    return res.json(response);
  });

  /**
   * GET /api/workflow
   * List all workflows.
   */
  router.get('/', (_req: Request, res: Response) => {
    const workflows = orchestrator.getAllWorkflows();
    const response: ApiResponse = {
      success: true,
      data: workflows,
    };
    return res.json(response);
  });

  /**
   * POST /api/workflow/:id/approve-script
   * Approve the generated script and continue the pipeline.
   */
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

  /**
   * POST /api/workflow/:id/re-generate-script
   * Re-generate the script for a workflow awaiting approval.
   */
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

  /**
   * POST /api/workflow/:id/cancel
   * Cancel a running workflow.
   */
  router.post('/:id/cancel', (req: Request, res: Response) => {
    const cancelled = orchestrator.cancelWorkflow(req.params.id);
    if (!cancelled) {
      const response: ApiResponse = {
        success: false,
        error: 'Workflow not found or not running',
      };
      return res.status(404).json(response);
    }

    const response: ApiResponse = {
      success: true,
      message: 'Workflow cancelled',
    };
    return res.json(response);
  });

  /**
   * DELETE /api/workflow/:id
   * Delete (clean up) a workflow record and its output files.
   * Only accessible with admin access key.
   */
  router.delete('/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    const accessKey = req.headers['x-access-key'] as string | undefined;

    // Validate admin access
    if (!accessKey) {
      return res.status(403).json({ success: false, error: 'Access key required' });
    }

    const db = getDatabase();
    const keyInfo = db.validateAccessKey(accessKey);
    if (!keyInfo || keyInfo.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required to delete workflows' });
    }

    // Clean up database first
    orchestrator.deleteWorkflow(id);

    // Clean up output files matching this workflow (scan directories for the short ID)
    const searchDirs = [getOutputDir('videos'), getOutputDir('assets/videos')];
    const shortId = id.slice(0, 6);

    for (const dir of searchDirs) {
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (f.includes(shortId)) {
            try { fs.unlinkSync(path.join(dir, f)); } catch {}
          }
        }
      }
    }

    const response: ApiResponse = {
      success: true,
      message: 'Workflow and output files cleaned up',
    };
    return res.json(response);
  });

  /**
   * GET /api/workflow/:id/logs
   * Get persisted logs for a workflow.
   */
  router.get('/:id/logs', (req: Request, res: Response) => {
    const id = req.params.id;
    const limit = parseInt(req.query.limit as string) || 500;
    const logs = orchestrator.getWorkflowLogs(id, limit);
    const response: ApiResponse = {
      success: true,
      data: { workflow_id: id, logs },
    };
    return res.json(response);
  });

  // ========================================
  // Scene Image Management (awaiting_images state)
  // ========================================

  /**
   * GET /api/workflow/:id/scenes
   * Get scene image info for a workflow paused at awaiting_images.
   */
  router.get('/:id/scenes', (req: Request, res: Response) => {
    const scenes = orchestrator.getSceneImages(req.params.id);
    if (!scenes) {
      return res.status(404).json({ success: false, error: 'No scene images found or workflow not in awaiting_images state' });
    }
    return res.json({ success: true, data: scenes });
  });

  /**
   * POST /api/workflow/:id/scenes/:sceneIndex/upload
   * Upload a manual image for a specific scene.
   * Accepts multipart/form-data with field 'image' or JSON with 'image_base64'.
   */
  router.post('/:id/scenes/:sceneIndex/upload', sceneUpload.single('image'), async (req: Request, res: Response) => {
    try {
      const workflowId = req.params.id;
      const sceneIndex = parseInt(req.params.sceneIndex, 10);

      let imageBuffer: Buffer | null = null;

      // Multipart upload via multer
      if (req.file) {
        imageBuffer = req.file.buffer;
      }
      // JSON fallback with base64
      else if (req.body && req.body.image_base64) {
        imageBuffer = Buffer.from(req.body.image_base64, 'base64');
      }

      if (!imageBuffer) {
        return res.status(400).json({ success: false, error: 'No image data provided — send as multipart/form-data with field "image" or JSON with "image_base64"' });
      }

      const ok = await orchestrator.uploadSceneImage(workflowId, sceneIndex, imageBuffer);
      if (!ok) {
        return res.status(409).json({ success: false, error: 'Workflow is not in awaiting_images state or scenes_dir missing' });
      }

      return res.json({ success: true, message: `Scene ${sceneIndex + 1} image uploaded` });
    } catch (err) {
      return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Upload failed' });
    }
  });

  /**
   * POST /api/workflow/:id/continue-to-video
   * Continue a paused workflow from awaiting_images to video assembly.
   */
  router.post('/:id/continue-to-video', async (req: Request, res: Response) => {
    try {
      const ok = await orchestrator.continueToVideo(req.params.id);
      if (!ok) {
        return res.status(409).json({ success: false, error: 'Cannot continue — workflow not in awaiting_images state or missing audio/scenes' });
      }
      return res.json({ success: true, message: 'Continuing to video assembly' });
    } catch (err) {
      return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Continue failed' });
    }
  });

  // ========================================
  // Manual Media Management (manual_story mode)
  // ========================================

  /**
   * POST /api/workflow/:id/upload-media
   * Upload a media file (image or video) for a specific scene in manual mode.
   * Accepts multipart/form-data with fields 'media' (file) and 'sceneIndex' (int).
   */
  router.post('/:id/upload-media', mediaUpload.single('media'), async (req: Request, res: Response) => {
    try {
      const workflowId = req.params.id;
      const sceneIndex = parseInt(req.body.sceneIndex as string, 10);

      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No media file provided' });
      }

      if (isNaN(sceneIndex) || sceneIndex < 0) {
        return res.status(400).json({ success: false, error: 'Invalid sceneIndex' });
      }

      const ok = await orchestrator.mediaService.uploadManualMedia(workflowId, sceneIndex, req.file.buffer, req.file.originalname);
      if (!ok) {
        const workflow = orchestrator.getWorkflow(workflowId);
        if (workflow && workflow.status !== 'awaiting_media') {
          return res.status(409).json({ success: false, error: 'Workflow is not awaiting media upload' });
        }
        return res.status(400).json({ success: false, error: 'Unsupported file format. Accepted: .png, .jpg, .jpeg (images) or .mp4, .mov, .webm, .avi, .mkv (videos)' });
      }

      return res.json({ success: true, message: `Scene ${sceneIndex + 1} media uploaded` });
    } catch (err) {
      return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Upload failed' });
    }
  });

  /**
   * POST /api/workflow/:id/assemble
   * Assemble the final video from uploaded media in manual mode.
   */
  router.post('/:id/assemble', async (req: Request, res: Response) => {
    try {
      const ok = await orchestrator.mediaService.assembleManualVideo(req.params.id);
      if (!ok) {
        return res.status(409).json({ success: false, error: 'Cannot assemble — workflow not in awaiting_media state or missing audio/media' });
      }
      return res.json({ success: true, message: 'Final video assembly started' });
    } catch (err) {
      return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Assembly failed' });
    }
  });

  /**
   * GET /api/workflow/media-file/:workflowId/:filename
   * Serve uploaded media files for manual mode.
   */
  router.get('/media-file/:workflowId/:filename', (req: Request, res: Response) => {
    const { workflowId, filename } = req.params;
    const mediaDir = getOutputDir(`assets/manual_media/${workflowId}`);
    const filePath = path.join(mediaDir, filename);

    const normalized = path.resolve(filePath);
    const normalizedDir = path.resolve(mediaDir);
    if (!normalized.startsWith(normalizedDir)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    res.sendFile(filePath);
  });

  // ========================================
  // Voiceover Management (awaiting_voiceover state)
  // ========================================

  /**
   * POST /api/workflow/:id/upload-voiceover
   * Upload a recorded voiceover file for a workflow awaiting voiceover.
   * Accepts multipart/form-data with field 'audio' (.wav, .mp3).
   */
  router.post('/:id/upload-voiceover', voiceoverUpload.single('audio'), async (req: Request, res: Response) => {
    try {
      const workflowId = req.params.id;

      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No audio file provided — send as multipart/form-data with field "audio"' });
      }

      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!['.wav', '.mp3', '.m4a', '.ogg', '.flac'].includes(ext)) {
        return res.status(400).json({ success: false, error: 'Unsupported audio format. Accepted: .wav, .mp3, .m4a, .ogg, .flac' });
      }

      const workflow = orchestrator.getWorkflow(workflowId);
      if (!workflow || workflow.status !== 'awaiting_voiceover') {
        return res.status(409).json({ success: false, error: 'Workflow is not awaiting voiceover' });
      }

      // Save audio file
      const audioDir = getOutputDir('assets/audio');
      const filename = `voiceover_upload_${workflowId.slice(0, 8)}${ext}`;
      const filePath = path.join(audioDir, filename);
      fs.writeFileSync(filePath, req.file.buffer);

      const voiceoverResult: VoiceoverResult = {
        success: true,
        file_path: filePath,
        filename,
        duration_seconds: 0, // Will be measured during assembly
        segments: 1,
        voice_model: 'user-upload',
        fallback: false,
      };

      const ok = await orchestrator.continueAfterVoiceover(workflowId, voiceoverResult);
      if (!ok) {
        return res.status(409).json({ success: false, error: 'Failed to process voiceover — workflow not in awaiting_voiceover state' });
      }

      return res.json({ success: true, message: 'Voiceover uploaded successfully, proceeding to media stage' });
    } catch (err) {
      return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Upload failed' });
    }
  });

  /**
   * POST /api/workflow/:id/re-render
   * Re-render a completed/failed workflow's video with a different aspect ratio.
   * Uses existing audio + uploaded media, just re-assembles at the new resolution.
   */
  router.post('/:id/re-render', async (req: Request, res: Response) => {
    try {
      const workflowId = req.params.id;
      const newAspectRatio = req.body.aspect_ratio as '9:16' | '16:9';

      if (!newAspectRatio || !['9:16', '16:9'].includes(newAspectRatio)) {
        return res.status(400).json({ success: false, error: 'aspect_ratio must be "9:16" or "16:9"' });
      }

      const ok = await orchestrator.mediaService.reRenderVideo(workflowId, newAspectRatio);
      if (!ok) {
        return res.status(409).json({ success: false, error: 'Cannot re-render — workflow not completed/failed or missing audio/media' });
      }

      return res.json({ success: true, message: `Re-rendering as ${newAspectRatio}` });
    } catch (err) {
      return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Re-render failed' });
    }
  });

  /**
   * POST /api/workflow/:id/generate-voiceover
   * Generate voiceover using AI TTS (Edge TTS or Kokoro) for a workflow awaiting voiceover.
   * Accepts JSON body with optional "engine" ("kokoro" or "edge-tts") and "voice" fields.
   */
  router.post('/:id/generate-voiceover', async (req: Request, res: Response) => {
    try {
      const workflowId = req.params.id;
      const engine = req.body.engine || 'edge-tts'; // 'kokoro' or 'edge-tts'
      const voice = req.body.voice;

      const workflow = orchestrator.getWorkflow(workflowId);
      if (!workflow || workflow.status !== 'awaiting_voiceover') {
        return res.status(409).json({ success: false, error: 'Workflow is not awaiting voiceover' });
      }

      const fullScript = workflow.full_story || (workflow.scenes || []).map(s => s.text.trim()).join(' ');

      let voiceoverResult: VoiceoverResult;
      if (engine === 'kokoro') {
        voiceoverResult = await orchestrator.scriptGen.generateVoiceoverKokoro(workflowId, fullScript, voice || 'af_heart');
      } else {
        voiceoverResult = await orchestrator.scriptGen.generateVoiceover(workflowId, fullScript, voice || (workflow.voice || 'en-US-AriaNeural'));
      }

      if (!voiceoverResult.success || !voiceoverResult.file_path) {
        return res.status(500).json({ success: false, error: 'Voiceover generation failed' });
      }

      const ok = await orchestrator.continueAfterVoiceover(workflowId, voiceoverResult);
      if (!ok) {
        return res.status(409).json({ success: false, error: 'Failed to continue after voiceover generation' });
      }

      return res.json({
        success: true,
        message: `Voiceover generated with ${engine} (${voiceoverResult.voice_model}), proceeding to media stage`,
        data: voiceoverResult,
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Generation failed' });
    }
  });

  return router;
}
