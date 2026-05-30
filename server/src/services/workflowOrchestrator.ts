/**
 * Workflow Orchestrator
 * Manages the full pipeline: Script → Voiceover → Thumbnail → Video → Upload
 * Emits events via WebSocket for real-time status updates.
 */

import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import path from 'path';
import { execSync } from 'child_process';
import {
  WorkflowState,
  WorkflowStep,
  StepStatus,
  StepState,
  PipelineRequest,
  PipelineResult,
  ScriptResult,
  VoiceoverRequest,
  VoiceoverResult,
  ThumbnailRequest,
  ThumbnailResult,
  VideoRequest,
  VideoResult,
  UploadRequest,
  UploadResult,
  WsEvent,
} from '../types';
import { runPythonScript, getOutputDir } from './pythonRunner';
import { ShortVideoScene } from './shortVideoMaker';
import { generateScript as aiGenerateScript, generateScenes as aiGenerateScenes } from './aiProvider';
import { getDatabase } from './database';
import fs from 'fs';

interface LogBufferEntry {
  timestamp: string;
  message: string;
  level: 'info' | 'warn' | 'error';
}

interface QueueEntry {
  id: string;
  topic: string;
  username: string;
  request: PipelineRequest;
  status: 'waiting' | 'running';
  enqueuedAt: string;
  startedAt?: string;
}

export class WorkflowOrchestrator extends EventEmitter {
  private workflows: Map<string, WorkflowState> = new Map();
  private activeWorkflows: Set<string> = new Set();
  private db = getDatabase();
  private logBuffer: Map<string, LogBufferEntry[]> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  // Queue system
  private queue: QueueEntry[] = [];
  private isProcessingQueue = false;

  constructor() {
    super();

    // Restore workflows from database on startup
    this.restoreFromDb();

    // Flush log buffer every 2 seconds
    this.flushTimer = setInterval(() => this.flushLogBuffer(), 2000);

    // Flush on exit
    const flushOnExit = () => {
      this.flushLogBufferSync();
      this.db.close();
    };
    process.on('SIGTERM', flushOnExit);
    process.on('SIGINT', flushOnExit);
  }

  // ========================================
  // Queue Management
  // ========================================

  /** Get the current queue state */
  getQueueState() {
    return {
      queue: this.queue.map((e, i) => ({
        position: i + 1,
        id: e.id,
        topic: e.topic,
        username: e.username,
        status: e.status,
        enqueuedAt: e.enqueuedAt,
        startedAt: e.startedAt,
      })),
      currentlyGenerating: this.queue.find(e => e.status === 'running')?.username || null,
      queueLength: this.queue.length,
    };
  }

  /** Emit queue update event via WebSocket */
  private emitQueueEvent(): void {
    this.emit('queue-update', this.getQueueState());
  }

  /** Add a workflow to the queue and process */
  private async enqueueWorkflow(workflowId: string, request: PipelineRequest): Promise<void> {
    const entry: QueueEntry = {
      id: workflowId,
      topic: request.topic,
      username: request.username || 'unknown',
      request,
      status: 'waiting',
      enqueuedAt: new Date().toISOString(),
    };

    this.queue.push(entry);
    this.emitQueueEvent();

    // Emit a log event for the waiting user
    const position = this.queue.length;
    if (position > 1) {
      const runningUser = this.queue[0].username;
      this.emitEvent(workflowId, 'log', {
        message: `Queued at position #${position}. ${runningUser} is currently generating. Please wait...`,
        level: 'warn',
      });
    }

    // Process the queue if not already processing
    this.processQueue().catch(err => {
      console.error('[Queue] Fatal error processing queue:', err);
    });
  }

  /** Process the queue - runs one workflow at a time */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.queue.length > 0) {
      const entry = this.queue[0];
      if (!entry) break;

      // Skip if workflow was cancelled while waiting in queue
      const wf = this.workflows.get(entry.id);
      if (wf && wf.status === 'failed') {
        this.emitEvent(entry.id, 'log', { message: 'Skipping cancelled workflow in queue', level: 'warn' });
        this.queue.shift();
        this.emitQueueEvent();
        continue;
      }

      // Mark as running in the orchestrator and update the workflow status
      entry.status = 'running';
      entry.startedAt = new Date().toISOString();
      const wfToRun = this.workflows.get(entry.id);
      if (wfToRun) {
        wfToRun.status = 'running';
        wfToRun.updatedAt = new Date().toISOString();
        this.emitEvent(entry.id, 'log', { message: 'Your workflow has started generating!', level: 'info' });
      }
      this.emitQueueEvent();

      // Execute the pipeline (await blocks the loop - only one at a time)
      try {
        await this.executePipeline(entry.id, entry.request);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Queued pipeline failed';
        this.handleError(entry.id, 'queue', msg);
      }

      // Remove from queue
      this.queue.shift();
      this.emitQueueEvent();
    }

    this.isProcessingQueue = false;
  }

  /**
   * Create a new workflow and add it to the queue.
   */
  async startPipeline(request: PipelineRequest): Promise<PipelineResult> {
    const workflowId = uuidv4();
    const workflow: WorkflowState = {
      id: workflowId,
      topic: request.topic,
      status: 'queued',
      progress: 0,
      currentStep: null,
      createdBy: request.username || undefined,
      steps: {
        script_generation: { status: 'pending' },
        voiceover: { status: 'pending' },
        thumbnail: { status: 'pending' },
        video_assembly: { status: 'pending' },
        upload: { status: 'pending' },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tone: request.tone,
      duration_minutes: request.duration_minutes,
      footage_source: request.footage_source,
      voice: request.voice,
      add_subtitles: request.add_subtitles,
      ai_model: request.ai_model,
      caption_position: request.caption_position,
      caption_background_color: request.caption_background_color,
    };

    // Persist to database immediately
    try {
      this.db.insertWorkflow(workflow);
    } catch (err) {
      console.error('[DB] Failed to insert workflow:', err);
    }

    this.workflows.set(workflowId, workflow);

    // Add to queue instead of running immediately
    this.enqueueWorkflow(workflowId, request);

    return {
      workflow_id: workflowId,
      status: 'running',
      results: {},
      errors: {},
    };
  }

  /**
   * Restore workflows from SQLite on startup.
   */
  private restoreFromDb(): void {
    try {
      const saved = this.db.getAllWorkflows();
      let failedCount = 0;
      for (const wf of saved) {
        // If workflow was running or queued when server went down, mark it as failed
        // (we can't resume pipelines after restart)
        // awaiting_script_approval is preserved — user can re-approve after restart
        if (wf.status === 'running' || wf.status === 'queued') {
          failedCount++;
          wf.status = 'failed';
          wf.updatedAt = new Date().toISOString();
          // Update each running/pending step as failed too
          for (const step of Object.keys(wf.steps) as WorkflowStep[]) {
            if (wf.steps[step].status === 'running' || wf.steps[step].status === 'pending') {
              wf.steps[step].status = 'failed';
              wf.steps[step].error = 'Server was restarted while this step was in progress';
            }
          }
          this.db.updateWorkflow(wf);
        }
        this.workflows.set(wf.id, wf);
      }
      if (saved.length > 0) {
        if (failedCount > 0) {
          console.log(`[DB] Restored ${saved.length} workflows (${failedCount} running/queued → marked as failed due to restart)`);
        } else {
          console.log(`[DB] Restored ${saved.length} workflows from database`);
        }
      }
    } catch (err) {
      console.error('[DB] Failed to restore workflows:', err);
    }
  }

  /**
   * Buffer a log entry for batched database write.
   */
  private bufferLog(workflowId: string, entry: LogBufferEntry): void {
    if (!this.logBuffer.has(workflowId)) {
      this.logBuffer.set(workflowId, []);
    }
    this.logBuffer.get(workflowId)!.push(entry);
  }

  /**
   * Flush buffered logs to database.
   */
  private flushLogBuffer(): void {
    if (this.logBuffer.size === 0) return;

    const entries = new Map(this.logBuffer);
    this.logBuffer.clear();

    for (const [workflowId, logs] of entries) {
      if (logs.length > 0) {
        try {
          this.db.insertLogs(workflowId, logs);
        } catch (err) {
          console.error(`[DB] Failed to flush logs for ${workflowId}:`, err);
        }
      }
    }
  }

  /**
   * Synchronous flush (used for shutdown).
   */
  private flushLogBufferSync(): void {
    for (const [workflowId, logs] of this.logBuffer) {
      if (logs.length > 0) {
        try {
          this.db.insertLogs(workflowId, logs);
        } catch {
          // Best effort on shutdown
        }
      }
    }
    this.logBuffer.clear();
  }

  /**
   * Execute the full pipeline step by step.
   */
  private async executePipeline(workflowId: string, request: PipelineRequest): Promise<void> {
    const results: Partial<Record<WorkflowStep, unknown>> = {};
    const errors: Partial<Record<WorkflowStep, string>> = {};
    const sanitizedTopic = request.topic.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);

    try {
      // Short style uses local YouTube footage + FFmpeg instead of sidecar
      if (request.style === 'short') {
        await this.executeShortPipeline(workflowId, request, results);
        return;
      }

      // Step 1: Script Generation
      this.updateStep(workflowId, 'script_generation', 'running');
      const scriptResult = await this.generateScript(workflowId, request, request.ai_model);
      results.script_generation = scriptResult;
      this.updateStep(workflowId, 'script_generation', 'completed', scriptResult);

      if (!scriptResult.success) {
        throw new Error('Script generation failed');
      }

      // Step 2: Voiceover Generation
      this.updateStep(workflowId, 'voiceover', 'running');
      const voiceoverResult = await this.generateVoiceover(
        workflowId,
        scriptResult.script,
        request.voice
      );
      results.voiceover = voiceoverResult;
      this.updateStep(workflowId, 'voiceover', 'completed', voiceoverResult);

      // Step 3: Thumbnail Generation
      this.updateStep(workflowId, 'thumbnail', 'running');
      const thumbnailResult = await this.generateThumbnail(
        workflowId,
        request.topic,
        request.thumbnail_style
      );
      results.thumbnail = thumbnailResult;
      this.updateStep(workflowId, 'thumbnail', 'completed', thumbnailResult);

      // Step 4: Video Assembly
      this.updateStep(workflowId, 'video_assembly', 'running');
      const videoResult = await this.assembleVideo(
        workflowId,
        scriptResult.script,
        voiceoverResult.file_path,
        thumbnailResult.file_path,
        request.topic,
        request.add_subtitles,
        request.username
      );
      results.video_assembly = videoResult;
      this.updateStep(workflowId, 'video_assembly', 'completed', videoResult);

      // Step 5: Upload (optional)
      if (request.auto_upload && videoResult.success) {
        this.updateStep(workflowId, 'upload', 'running');
        const uploadResult = await this.uploadVideo(
          workflowId,
          videoResult.file_path,
          request.topic,
          request.privacy_status,
          thumbnailResult.file_path
        );
        results.upload = uploadResult;
        this.updateStep(workflowId, 'upload', 'completed', uploadResult);
      } else {
        results.upload = {
          success: true,
          message: 'Upload skipped (auto_upload not enabled)',
          fallback: true,
        } as unknown as UploadResult;
        this.updateStep(workflowId, 'upload', 'skipped');
      }

      this.completeWorkflow(workflowId, results, (videoResult as VideoResult).file_path);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.handleError(workflowId, 'pipeline', errorMsg);
    }
  }

  private async executeShortPipeline(
    workflowId: string,
    request: PipelineRequest,
    results: Partial<Record<WorkflowStep, unknown>>
  ): Promise<void> {
    // Step 1: Generate viral-style short script
    this.updateStep(workflowId, 'script_generation', 'running');
    this.emitEvent(workflowId, 'log', { message: `Starting AI scene generation for topic: "${request.topic}"` });
    this.emitEvent(workflowId, 'log', { message: `Using preferred model: ${request.ai_model || 'auto'}` });

    // Try AI scene generation first (Groq/OpenRouter + spaCy)
    const aiScenes = await this.generateAIScenes(workflowId, request.topic, request.tone, request.duration_minutes, request.ai_model);

    let scenes: ShortVideoScene[];
    let script: string;
    let modelUsed: string;

    if (aiScenes.length > 0) {
      this.emitEvent(workflowId, 'log', { message: `AI generated ${aiScenes.length} scenes successfully` });
      scenes = aiScenes;
      script = scenes.map(s => s.text).join(' ');
      modelUsed = 'ai-provider';
    } else {
      this.emitEvent(workflowId, 'log', { message: 'AI scene generation returned empty — falling back to viral template', level: 'warn' });
      script = this.generateShortFallbackScript(request.topic, request.tone);
      scenes = this.buildShortScenes(request.topic, request.tone, request.duration_minutes);
      modelUsed = 'viral-template';
    }

    const scriptResult: ScriptResult = {
      success: true,
      script,
      model: modelUsed,
      topic: request.topic,
      tone: request.tone || 'educational',
      duration_minutes: request.duration_minutes || 1,
      word_count: script.split(/\s+/).length,
      fallback: modelUsed === 'viral-template',
    };
    results.script_generation = scriptResult;
    this.updateStep(workflowId, 'script_generation', 'completed', scriptResult);

    // Store scenes in workflow state and pause for script approval
    const workflow = this.workflows.get(workflowId);
    if (workflow) {
      workflow.scenes = scenes as unknown as Array<{ text: string; searchTerms: string[] }>;
      workflow.fallback = modelUsed === 'viral-template';
      workflow.model_used = modelUsed;
      workflow.status = 'awaiting_script_approval';
      workflow.updatedAt = new Date().toISOString();

      // Store request params for later continuation
      workflow.tone = request.tone;
      workflow.duration_minutes = request.duration_minutes;
      workflow.footage_source = request.footage_source;
      workflow.voice = request.voice;
      workflow.add_subtitles = request.add_subtitles;
      workflow.ai_model = request.ai_model;
      workflow.caption_position = request.caption_position;
      workflow.caption_background_color = request.caption_background_color;

      this.workflows.set(workflowId, workflow);

      // Persist to database
      try {
        this.db.updateWorkflow(workflow);
      } catch (err) {
        console.error('[DB] Failed to update workflow for script approval:', err);
      }
    }

    // Emit script preview event to frontend
    this.emitEvent(workflowId, 'script_ready', {
      scenes: scenes.map(s => ({ text: s.text, searchTerms: s.searchTerms })),
      model: modelUsed,
      fallback: modelUsed === 'viral-template',
    });

    this.emitEvent(workflowId, 'log', {
      message: `Script generated with ${scenes.length} scenes. Waiting for your approval to continue rendering...`,
      level: 'info',
    });

    // Pause — return early, pipeline resumes after user approves
    return;
  }

  // ========================================
  // Script Preview: Approve / Re-generate
  // ========================================

  async approveScript(workflowId: string, editedScenes?: Array<{ text: string; searchTerms: string[] }>): Promise<boolean> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow || workflow.status !== 'awaiting_script_approval') return false;

    if (editedScenes && editedScenes.length > 0) {
      workflow.scenes = editedScenes;
    }

    workflow.status = 'running';
    workflow.updatedAt = new Date().toISOString();

    this.emitEvent(workflowId, 'log', { message: 'Script approved — continuing pipeline...' });

    this.activeWorkflows.add(workflowId);

    this.continuePipelineAfterApproval(workflowId).catch(err => {
      this.handleError(workflowId, 'pipeline', err instanceof Error ? err.message : 'Pipeline continuation failed');
    });

    return true;
  }

  async reGenerateScript(workflowId: string): Promise<boolean> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow || workflow.status !== 'awaiting_script_approval') return false;

    workflow.status = 'running';
    workflow.updatedAt = new Date().toISOString();

    this.emitEvent(workflowId, 'log', { message: 'Re-generating script...' });

    this.activeWorkflows.add(workflowId);

    this.executePipeline(workflowId, {
      topic: workflow.topic,
      tone: workflow.tone || 'educational',
      style: 'short',
      duration_minutes: workflow.duration_minutes || 1,
      footage_source: workflow.footage_source || 'sidecar',
      ai_model: workflow.ai_model || 'auto',
      username: workflow.createdBy,
      add_subtitles: workflow.add_subtitles ?? true,
      caption_position: workflow.caption_position,
      caption_background_color: workflow.caption_background_color,
    } as PipelineRequest).catch(err => {
      this.handleError(workflowId, 'pipeline', err instanceof Error ? err.message : 'Re-generation failed');
    });

    return true;
  }

  private async continuePipelineAfterApproval(workflowId: string): Promise<void> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return;

    const scenes = workflow.scenes;
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
      add_subtitles: workflow.add_subtitles ?? true,
      username: workflow.createdBy,
      caption_position: workflow.caption_position,
      caption_background_color: workflow.caption_background_color,
    };

    const results: Partial<Record<WorkflowStep, unknown>> = {};

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

    await this.renderAfterApproval(workflowId, scenes, fullScript, request, results);
  }

  private async renderAfterApproval(
    workflowId: string,
    scenes: Array<{ text: string; searchTerms: string[] }>,
    fullScript: string,
    request: any,
    results: Partial<Record<WorkflowStep, unknown>>
  ): Promise<void> {
    this.updateStep(workflowId, 'voiceover', 'running');
    this.emitEvent(workflowId, 'log', { message: `Generating voiceover for ${scenes.length} scenes...` });

    const voiceoverResult = await this.generateVoiceover(workflowId, fullScript, request.voice);
    results.voiceover = voiceoverResult;
    this.updateStep(workflowId, 'voiceover', 'completed', voiceoverResult);

    if (!voiceoverResult.success || !voiceoverResult.file_path) {
      throw new Error('Voiceover generation failed');
    }

    if (request.footage_source === 'sidecar') {
      await this.renderWithSidecar(workflowId, scenes, voiceoverResult.file_path, request, results);
    } else {
      await this.renderWithYouTubeClips(workflowId, scenes, voiceoverResult.file_path, request, results);
    }
  }

  private async renderWithSidecar(
    workflowId: string,
    scenes: Array<{ text: string; searchTerms: string[] }>,
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

    let status: string = 'processing';
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 3000));
      status = await sidecar.getStatus(videoId);
      this.emitEvent(workflowId, 'log', { message: `Render status: ${status}` });
      if (status === 'ready' || status === 'error') break;
    }

    if (status !== 'ready') {
      this.updateStep(workflowId, 'video_assembly', 'failed', { error: 'Render timed out' });
      throw new Error('Sidecar render did not complete in time');
    }

    const outputDir = getOutputDir('assets/videos');
    const outputFilename = `short_${workflowId.slice(0, 8)}.mp4`;
    const outputPath = path.join(outputDir, outputFilename);

    const videoBuffer = await sidecar.downloadVideo(videoId);
    fs.writeFileSync(outputPath, Buffer.from(videoBuffer));

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

  private async renderWithYouTubeClips(
    workflowId: string,
    scenes: Array<{ text: string; searchTerms: string[] }>,
    audioPath: string,
    request: any,
    results: Partial<Record<WorkflowStep, unknown>>
  ): Promise<void> {
    this.updateStep(workflowId, 'thumbnail', 'skipped');
    this.updateStep(workflowId, 'video_assembly', 'running');

    const clipDir = getOutputDir('assets/videos/clips');
    let clipPaths: string[] = [];
    try {
      const footageResult = await runPythonScript<{
        success: boolean;
        clips: { success: boolean; file_path?: string; actual_duration?: number; [key: string]: unknown }[];
        successful_clips: { file_path: string; actual_duration?: number; [key: string]: unknown }[];
        fallback: boolean;
      }>('youtube_footage.py', {
        scenes: scenes.map(s => ({ text: s.text, search_terms: s.searchTerms })),
        output_dir: clipDir,
        clip_duration: 12,
      }, { timeout: 300000 });

      if (footageResult.success && footageResult.successful_clips?.length > 0) {
        clipPaths = footageResult.successful_clips.map(c => c.file_path);
        this.emitEvent(workflowId, 'log', {
          message: `Downloaded ${clipPaths.length} gameplay clips successfully`,
          level: 'info',
        });
        for (const clip of footageResult.successful_clips) {
          this.emitEvent(workflowId, 'log', {
            message: `  Clip: ${path.basename(clip.file_path)} (${(clip.actual_duration || 0).toFixed(1)}s)`,
            level: 'info',
          });
        }
      } else {
        this.emitEvent(workflowId, 'log', {
          message: 'YouTube footage download failed — falling back to static background',
          level: 'warn',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'YouTube footage error';
      this.emitEvent(workflowId, 'log', {
        message: `YouTube footage download failed: ${msg}`,
        level: 'warn',
      });
    }

    const outputDir = getOutputDir('assets/videos');
    const outputFilename = this.generateFilename(request.topic, request.username, workflowId, '.mp4');
    const outputPath = path.join(outputDir, outputFilename);

    if (clipPaths.length > 0) {
      this.emitEvent(workflowId, 'log', { message: `Assembling video from ${clipPaths.length} gameplay clips with text overlays...` });

      const clipsForAssembly: { file_path: string; text: string }[] = [];
      for (let i = 0; i < scenes.length; i++) {
        const fp = clipPaths[i] || clipPaths[clipPaths.length - 1];
        clipsForAssembly.push({ file_path: fp, text: scenes[i].text });
      }

      try {
        const videoResult = await runPythonScript<VideoResult>('ffmpeg_video.py', {
          action: 'scene_assembly',
          clips: clipsForAssembly,
          audio_path: audioPath,
          output_filename: outputFilename,
          resolution: '1080x1920',
          crop_position: request.crop_position || 'fit',
          caption_position: request.caption_position || 'bottom',
          caption_background_color: request.caption_background_color || 'black',
        }, { timeout: 300000 });

        if (videoResult.success) {
          results.video_assembly = videoResult;
          this.updateStep(workflowId, 'video_assembly', 'completed', videoResult);

          results.upload = { success: true, message: 'Upload skipped (auto_upload not supported for short style)', fallback: true } as unknown as UploadResult;
          this.updateStep(workflowId, 'upload', 'skipped');

          this.completeWorkflow(workflowId, results, videoResult.file_path);
          return;
        } else {
          this.emitEvent(workflowId, 'log', { message: 'Scene assembly failed, falling back to audio-only video', level: 'warn' });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Scene assembly error';
        this.emitEvent(workflowId, 'log', { message: `Scene assembly error: ${msg}`, level: 'warn' });
      }
    }

    this.emitEvent(workflowId, 'log', { message: 'Generating fallback video (audio + gradient background)...' });

    const fallbackResult = await runPythonScript<VideoResult>('ffmpeg_video.py', {
      action: 'assemble',
      script: scenes.map(s => s.text).join('. '),
      audio_path: audioPath,
      output_filename: outputFilename,
      video_title: request.topic,
      add_subtitles: true,
      resolution: '1080x1920',
    }, { timeout: 120000 });

    results.video_assembly = fallbackResult;
    this.updateStep(workflowId, 'video_assembly', 'completed', fallbackResult);

    results.upload = { success: true, message: 'Upload skipped (auto_upload not supported for short style)', fallback: true } as unknown as UploadResult;
    this.updateStep(workflowId, 'upload', 'skipped');

    this.completeWorkflow(workflowId, results, fallbackResult.file_path || outputPath);
  }

  private completeWorkflow(workflowId: string, results: Partial<Record<WorkflowStep, unknown>>, videoPath?: string): void {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return;

    workflow.status = 'completed';
    workflow.progress = 100;
    workflow.updatedAt = new Date().toISOString();
    this.activeWorkflows.delete(workflowId);

    // Persist to database
    try {
      this.db.updateWorkflow(workflow);
    } catch (err) {
      console.error('[DB] Failed to update workflow on complete:', err);
    }

    // Flush any buffered logs immediately
    this.flushLogBuffer();

    this.emitEvent(workflowId, 'workflow_complete', {
      data: { results, video_path: videoPath },
    });

    this.runPostWorkflowCleanup();
  }

  private async generateAIScenes(workflowId: string, topic: string, tone?: string, durationMinutes?: number, preferredModel?: string): Promise<ShortVideoScene[]> {
    try {
      const durationSeconds = Math.round((durationMinutes || 0.5) * 60);
      this.emitEvent(workflowId, 'log', { message: `Calling AI scene generation (${durationSeconds}s target, ${preferredModel || 'auto'})...` });
      const result = await aiGenerateScenes(topic, tone || 'educational', durationSeconds, preferredModel);

      if (!result.success || !result.scenes || result.scenes.length === 0) {
        this.emitEvent(workflowId, 'log', { message: 'AI scene generation returned no scenes', level: 'warn' });
        return [];
      }

      this.emitEvent(workflowId, 'log', { message: `AI returned ${result.scenes.length} scenes, running keyword enhancement...` });
      const scenes: ShortVideoScene[] = [];
      for (const scene of result.scenes) {
        let searchTerms = scene.searchTerms || [];

        try {
          const enhanced = await runPythonScript<{ keywords: string[]; enhanced_terms: string[] }>(
            'keyword_enhancer.py',
            { text: scene.text, topic },
            { timeout: 10000 }
          );
          if (enhanced.enhanced_terms && enhanced.enhanced_terms.length > 0) {
            searchTerms = [...new Set([...enhanced.enhanced_terms, ...searchTerms])].slice(0, 5);
          }
        } catch (err) {
          this.emitEvent(workflowId, 'log', { message: 'Keyword enhancement skipped', level: 'warn' });
          // Use original search terms if keyword enhancement fails
        }

        scenes.push({ text: scene.text, searchTerms });
      }

      return scenes;
    } catch {
      return [];
    }
  }

  private buildShortScenes(topic: string, tone?: string, durationMinutes?: number): ShortVideoScene[] {
    const primaryKeywords = topic.split(' ').filter(w => w.length > 2);
    const fallbackKeywords = ['motivation', 'success', 'inspiration', 'achievement', 'growth'];
    const keywords = primaryKeywords.length >= 2 ? primaryKeywords : fallbackKeywords;

    const hooks: Record<string, string[]> = {
      educational: [
        `Most people get ${topic} completely wrong. Here's what actually works.`,
        `Here's the ${topic} strategy that 99% of people don't know about.`,
        `The truth about ${topic} that nobody tells you upfront.`,
        `Stop wasting time on ${topic}. Do this instead and thank me later.`,
        `What if I told you ${topic} is simpler than you think?`,
        `The number one reason people fail at ${topic} — and how to fix it.`,
        `You've been doing ${topic} backwards. Let me explain.`,
        `Before you spend another minute on ${topic}, watch this.`,
        `I wish I knew this about ${topic} when I started.`,
        `Three words that will change how you approach ${topic}.`,
      ],
      entertaining: [
        `You won't believe what I just found out about ${topic}. Mind blown.`,
        `Okay, so ${topic} is way more interesting than anyone tells you. Watch this.`,
        `This ${topic} secret will completely change how you see everything.`,
        `Everybody talks about ${topic}. Nobody tells you THIS part.`,
        `I went down a ${topic} rabbit hole and found something WILD.`,
        `Hold onto your seat — this ${topic} revelation changes everything.`,
        `${topic} just got a lot more interesting. Trust me on this.`,
        `You think you know ${topic}? Think again.`,
        `This ${topic} story is insane. You won't believe how it ends.`,
        `The ${topic} industry doesn't want you to know this.`,
      ],
      professional: [
        `Here's the ${topic} strategy that top performers swear by.`,
        `The ${topic} advice that actually makes you money in 2026.`,
        `Stop losing opportunities because of bad ${topic}. Fix it now.`,
        `The ROI of getting ${topic} right? Life changing. Here's how.`,
        `Here's the ${topic} framework I use with my clients.`,
        `Three ${topic} metrics that actually matter. Ignore the rest.`,
        `I analyzed 100 ${topic} case studies. Here's the common thread.`,
        `The gap between average and elite ${topic}? It's smaller than you think.`,
        `This ${topic} audit revealed a massive efficiency gap. Here's how to close it.`,
        `Your ${topic} strategy is leaking money. Here's the fix.`,
      ],
      casual: [
        `So apparently everyone is wrong about ${topic}. Here's the truth.`,
        `Real talk about ${topic} that nobody wants to admit.`,
        `If you're into ${topic}, this video is literally for you.`,
        `Before you go deeper into ${topic}, you NEED to know this.`,
        `Can we talk about ${topic}? Like, actually talk about it?`,
        `${topic} doesn't have to be this hard. Seriously.`,
        `Let's cut the BS about ${topic} and talk about what actually works.`,
        `I need to get something off my chest about ${topic}.`,
        `You're overthinking ${topic}. Here's the simple version.`,
        `Hot take: most ${topic} advice is garbage. Here's what's not.`,
      ],
    };

    const valueLines: Record<string, string[]> = {
      educational: [
        `${topic} isn't as complicated as people make it. Strip away the noise and focus on ONE core principle. Master that before anything else.`,
        `Stop trying to learn everything at once. Pick the one area of ${topic} that matters most to YOU and go deep. Depth beats breadth every time.`,
        `Consistency over intensity. Small daily progress in ${topic} compounds into massive results. 1% better every day.`,
        `Find your ${topic} community. Learning alone is 10x harder. Learn with others and you'll grow 10x faster.`,
        `Think of ${topic} like building a house. You wouldn't put on the roof before pouring the foundation. Get the basics rock solid first.`,
        `The 80/20 rule applies to ${topic}: 80% of results come from 20% of effort. Find that 20% and double down. Everything else is optional.`,
        `Instead of asking "what should I learn about ${topic}", ask "what problem am I solving". Start with the problem, work backward to the knowledge.`,
        `Deliberate practice is the difference between knowing about ${topic} and being good at it. Not just doing it, but doing it with intention.`,
        `Don't optimize everything at once. Pick one thing about ${topic}, make it a habit, then move to the next. Small wins compound.`,
        `Try explaining ${topic} to a friend in one minute. If you can't simplify it, you don't understand it well enough yet.`,
      ],
      entertaining: [
        `The more you dig into ${topic}, the weirder it gets. The things you think you know? Half of them are wrong. And the real story is way more interesting.`,
        `The biggest plot twist? The people who are best at ${topic} started out TERRIBLE. They just refused to quit. That's literally the only difference.`,
        `Most ${topic} "experts" are just people who were curious longer than everyone else. That's it. Curiosity beats talent every time.`,
        `The secret nobody tells you about ${topic}? It's supposed to be fun. If you're not enjoying it, you're doing it wrong.`,
        `The history of ${topic} is full of happy accidents that changed everything. The biggest breakthroughs happened by complete mistake.`,
        `The irony of ${topic}: the more seriously you take it, the worse you get. The best in the world treat it like a game.`,
        `Everything you think you know about ${topic} was probably designed to sell you something. The real story is way more interesting.`,
        `The most successful ${topic} stories start with embarrassing failure. The kind most people would quit over. That's the real secret.`,
      ],
      professional: [
        `Companies investing in ${topic} outperform competitors by 3x. But only if they do it right. Top performers prioritize systems over talent.`,
        `Measure what matters. Track progress in ${topic} with clear KPIs. What gets measured gets improved. Stop guessing, start knowing.`,
        `Iterate fast. The best ${topic} teams ship, learn, and improve. They don't wait for perfection. Speed of execution is the competitive advantage.`,
        `The ${topic} stack that delivers: right tooling, right process, right people. Skip any one and it falls apart.`,
        `Framework I use with clients: Assess, Prioritize, Execute, Review. Most skip straight to Execute and wonder why nothing changes.`,
        `Don't copy what successful companies do with ${topic} without understanding their context. Your situation is different. Your solution should be too.`,
        `Stop measuring activity in ${topic}. Start measuring outcomes. Hours spent means nothing. What changed as a result?`,
        `The most profitable ${topic} investment? Documentation. Every dollar spent on clarity saves ten on confusion.`,
        `The best ${topic} teams don't wait for perfect. They launch, learn, and iterate. Speed beats perfection.`,
      ],
      casual: [
        `Everyone overcomplicates ${topic}. Strip it back to basics and suddenly everything clicks.`,
        `Nobody knows what they're doing with ${topic} at first. The ones who succeed just kept showing up. That's it.`,
        `The easiest way to get started with ${topic}? Literally just start. Perfect is the enemy of done.`,
        `I tried being perfect at ${topic} for years. Nothing happened. The moment I allowed myself to be messy, everything changed.`,
        `The vibe with ${topic}: do it badly until you can do it well. There's no shortcut. Just showing up again and again.`,
        `The first six months of ${topic} will feel like you're getting nowhere. Push through. That's where the magic happens.`,
        `You don't need a detailed ${topic} plan. You need to take one step today. Tomorrow, another. That's the entire secret.`,
        `Nobody in ${topic} has it all figured out. We're all figuring it out as we go. That's the honest truth.`,
        `If ${topic} feels hard right now, good. That means you're growing. The day it feels easy is the day you stopped learning.`,
      ],
    };

    const ctas: Record<string, string[]> = {
      educational: [
        `If this helped, follow for more ${topic} insights. Save this for later.`,
        `Drop a comment with your biggest ${topic} challenge. Let's figure it out together.`,
        `Follow for daily ${topic} tips. Save this so you can come back to it.`,
        `Comment your biggest ${topic} struggle — I'll answer the best ones in my next video.`,
        `Save this as your ${topic} cheat sheet. Follow for part two.`,
        `Take ONE thing from this and apply it today. Comment what you picked.`,
      ],
      entertaining: [
        `Like if this surprised you. Follow for more. Comment your thoughts.`,
        `Save this to show your friends. They won't believe it either.`,
        `Follow for more mind-blowing content. This is just the beginning.`,
        `Comment "more" if you want a deep dive on this.`,
        `Share this with someone who needs to hear this today.`,
        `Like if you made it this far. You're part of the 1%. Respect.`,
      ],
      professional: [
        `Save this strategy. Follow for more ${topic} insights. Share with your team.`,
        `Follow for actionable ${topic} advice. This is how winners operate.`,
        `Drop a comment: what's your biggest ${topic} goal right now?`,
        `Bookmark this for your next ${topic} planning session.`,
        `Share this with a colleague who needs to level up their ${topic} game.`,
        `Like if this added value. Comment your biggest takeaway.`,
      ],
      casual: [
        `Save this for later. Follow for more real talk. Share if you agree.`,
        `Comment your hot take. I read every single one.`,
        `Like if this resonated. Follow for more. We're just getting started.`,
        `Share this with a friend who's struggling with ${topic}. They need to hear it.`,
        `Save this for days when ${topic} feels impossible. Come back to it.`,
        `Follow for unfiltered ${topic} advice. No BS, just real talk.`,
      ],
    };

    const safeTone = (tone || 'educational') as keyof typeof hooks;
    const toneHooks = hooks[safeTone] || hooks.educational;
    const toneValues = valueLines[safeTone] || valueLines.educational;
    const toneCtas = ctas[safeTone] || ctas.educational;

    const scenes: ShortVideoScene[] = [];

    // Scene 1: Hook
    const hookText = toneHooks[Math.floor(Math.random() * toneHooks.length)];
    scenes.push({
      text: hookText,
      searchTerms: [...keywords, 'inspiration', 'motivation'].slice(0, 5),
    });

    // Calculate value scene count from duration (0.25min=15s -> 1, 0.5min=30s -> 2, 1min=60s -> 3, 2min=120s -> 3)
    const maxValueScenes = Math.min(Math.max(Math.round((durationMinutes || 0.5) * 3), 1), 4);
    // Pick value scenes randomly (not sequential by index)
    const shuffledValues = [...toneValues].sort(() => Math.random() - 0.5);
    const selectedValues = shuffledValues.slice(0, Math.min(maxValueScenes, shuffledValues.length));
    for (const valueText of selectedValues) {
      scenes.push({
        text: valueText,
        searchTerms: [...keywords, 'success', 'learning', 'growth'].slice(0, 5),
      });
    }

    // Final scene: CTA
    const ctaText = toneCtas[Math.floor(Math.random() * toneCtas.length)];
    scenes.push({
      text: ctaText,
      searchTerms: [...keywords, 'community', 'together', 'future'].slice(0, 5),
    });

    return scenes;
  }

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

  /**
   * Step 1: Generate script using AI provider (Groq → OpenRouter → built-in fallback).
   */
  private async generateScript(
    workflowId: string,
    request: PipelineRequest,
    preferredModel?: string
  ): Promise<ScriptResult> {
    this.emitEvent(workflowId, 'log', { message: `Generating script for "${request.topic}" (${request.tone || 'educational'}, ${request.duration_minutes || 5}min)` });
    this.emitEvent(workflowId, 'log', { message: `AI model: ${preferredModel || 'auto (smart cycle)'}` });
    try {
      const result = await aiGenerateScript(
        request.topic,
        request.tone || 'educational',
        request.duration_minutes || 5,
        preferredModel
      );

      if (!result.fallback && result.content) {
        this.emitEvent(workflowId, 'log', { message: `Script generated successfully using ${result.model} (${result.content.split(/\s+/).length} words)` });
        return {
          success: true,
          script: result.content,
          model: result.model,
          topic: request.topic,
          tone: request.tone || 'educational',
          duration_minutes: request.duration_minutes || 5,
          word_count: result.content.split(/\s+/).length,
          fallback: false,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.emitEvent(workflowId, 'log', { message: `AI script generation failed: ${msg}`, level: 'error' });
      // Fall through to built-in fallback
    }

    return {
      success: true,
      script: this.generateFallbackScript(request.topic, request.tone),
      model: 'builtin-fallback',
      topic: request.topic,
      tone: request.tone || 'educational',
      duration_minutes: request.duration_minutes || 5,
      word_count: 300,
      fallback: true,
    };
  }

  /**
   * Step 2: Generate voiceover using Coqui TTS.
   */
  private async generateVoiceover(
    workflowId: string,
    script: string,
    voice?: string
  ): Promise<VoiceoverResult> {
    this.emitEvent(workflowId, 'log', { message: `Generating voiceover (voice: ${voice || 'default'})...` });
    this.emitEvent(workflowId, 'log', { message: `Running coqui_tts.py with ${script.split(/\s+/).length} word script` });
    const input: VoiceoverRequest = {
      script,
      voice: voice || 'en-US-JennyNeural',
    };

    try {
      const result = await runPythonScript<VoiceoverResult>('coqui_tts.py', input as unknown as Record<string, unknown>);
      this.emitEvent(workflowId, 'log', { message: `Voiceover generated: ${result.file_path} (${result.duration_seconds}s)` });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.emitEvent(workflowId, 'log', { message: `Voiceover generation failed: ${msg}`, level: 'error' });
      this.emitEvent(workflowId, 'log', { message: 'Falling back to silent voiceover', level: 'warn' });
      return {
        success: true,
        file_path: '',
        filename: 'voiceover.wav',
        duration_seconds: 0,
        segments: 0,
        voice_model: 'fallback-silent',
        fallback: true,
      };
    }
  }

  /**
   * Step 3: Generate thumbnail using Stable Diffusion.
   */
  private async generateThumbnail(
    workflowId: string,
    topic: string,
    style?: 'eye-catching' | 'minimalist' | 'educational'
  ): Promise<ThumbnailResult> {
    this.emitEvent(workflowId, 'log', { message: `Generating thumbnail (style: ${style || 'eye-catching'})...` });
    this.emitEvent(workflowId, 'log', { message: 'Running stable_diffusion.py...' });
    const input: ThumbnailRequest = {
      topic,
      style: style || 'eye-catching',
      count: 1,
    };

    try {
      const result = await runPythonScript<ThumbnailResult>('stable_diffusion.py', input as unknown as Record<string, unknown>);
      this.emitEvent(workflowId, 'log', { message: `Thumbnail generated: ${result.file_path}` });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.emitEvent(workflowId, 'log', { message: `Thumbnail generation failed: ${msg}`, level: 'error' });
      this.emitEvent(workflowId, 'log', { message: 'Falling back to server-generated thumbnail', level: 'warn' });
      // Generate a fallback thumbnail server-side
      const thumbPath = this.generateFallbackThumbnail(topic, workflowId);
      return {
        success: true,
        file_path: thumbPath,
        filename: path.basename(thumbPath),
        style: 'fallback-generated',
        dimensions: '1280x720',
        fallback: true,
      };
    }
  }

  /**
   * Step 4: Assemble video using FFmpeg.
   */
  private async assembleVideo(
    workflowId: string,
    script: string,
    audioPath: string,
    thumbnailPath: string | undefined,
    title: string,
    addSubtitles?: boolean,
    username?: string
  ): Promise<VideoResult> {
    const outputFilename = this.generateFilename(title, username, workflowId, '.mp4');
    
    this.emitEvent(workflowId, 'log', { message: `Assembling video: ${outputFilename}` });
    this.emitEvent(workflowId, 'log', { message: `Running ffmpeg_video.py with subtitles=${addSubtitles || false}` });

    const input: VideoRequest = {
      script,
      audio_path: audioPath,
      thumbnail_path: thumbnailPath,
      add_subtitles: addSubtitles || false,
      title,
    };

    try {
      const result = await runPythonScript<VideoResult>('ffmpeg_video.py', input as unknown as Record<string, unknown>);
      this.emitEvent(workflowId, 'log', { message: `Video assembly complete: ${result.file_path} (${(result.file_size_bytes / 1024 / 1024).toFixed(1)}MB)` });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.emitEvent(workflowId, 'log', { message: `Video assembly failed: ${msg}`, level: 'error' });
      this.emitEvent(workflowId, 'log', { message: 'Returning empty video result', level: 'warn' });
      return {
        success: true,
        file_path: '',
        filename: outputFilename,
        duration_seconds: 0,
        file_size_bytes: 0,
        resolution: '1920x1080',
        fps: 30,
        subtitles: false,
        fallback: true,
      };
    }
  }

  /**
   * Step 5: Upload to YouTube.
   */
  private async uploadVideo(
    workflowId: string,
    videoPath: string,
    title: string,
    privacyStatus?: 'public' | 'private' | 'unlisted',
    thumbnailPath?: string
  ): Promise<UploadResult> {
    this.emitEvent(workflowId, 'log', { message: `Uploading video to YouTube: "${title}"` });
    this.emitEvent(workflowId, 'log', { message: `Privacy: ${privacyStatus || 'unlisted'}, thumbnail: ${thumbnailPath ? 'yes' : 'no'}` });

    const input: UploadRequest = {
      video_path: videoPath,
      title,
      description: `Automatically generated video about ${title}\n\nGenerated with YouTube Automation Workflow`,
      tags: ['automation', title.toLowerCase().replace(/\s+/g, ''), 'ai-generated'],
      privacy_status: privacyStatus || 'unlisted',
      thumbnail_path: thumbnailPath,
    };

    try {
      const result = await runPythonScript<UploadResult>('youtube_uploader.py', {
        ...input as unknown as Record<string, unknown>,
        action: 'upload',
      });
      this.emitEvent(workflowId, 'log', { message: `Upload successful! Video ID: ${result.video_id || 'unknown'}` });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.emitEvent(workflowId, 'log', { message: `Upload failed: ${msg}`, level: 'error' });
      return {
        success: false,
        error: 'Upload method not configured. See config setup instructions.',
        fallback: true,
        video_path: videoPath,
        title,
        privacy_status: privacyStatus || 'unlisted',
      };
    }
  }

  /**
   * Update a step's status and emit event.
   */
  private updateStep(
    workflowId: string,
    step: WorkflowStep,
    status: StepStatus,
    result?: unknown
  ): void {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return;

    workflow.steps[step] = {
      status,
      startedAt: status === 'running' ? new Date().toISOString() : workflow.steps[step].startedAt,
      completedAt: (status === 'completed' || status === 'failed') ? new Date().toISOString() : undefined,
      result,
    };

    workflow.currentStep = status === 'running' ? step : workflow.currentStep;
    workflow.updatedAt = new Date().toISOString();
    workflow.progress = this.calculateProgress(workflow);

    this.emitEvent(workflowId, 'step_update', { step, status, result });

    // Persist to database
    try {
      this.db.updateWorkflow(workflow);
    } catch (err) {
      console.error('[DB] Failed to update workflow step:', err);
    }
  }

  /**
   * Handle workflow errors.
   */
  private handleError(workflowId: string, source: string, error: string): void {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return;

    this.emitEvent(workflowId, 'log', { message: `WORKFLOW FAILED at [${source}]: ${error}`, level: 'error' });

    workflow.status = 'failed';
    workflow.updatedAt = new Date().toISOString();
    this.activeWorkflows.delete(workflowId);

    if (source !== 'pipeline' && workflow.steps[source as WorkflowStep]) {
      workflow.steps[source as WorkflowStep].status = 'failed';
      workflow.steps[source as WorkflowStep].error = error;
    }

    // Persist to database
    try {
      this.db.updateWorkflow(workflow);
    } catch (err) {
      console.error('[DB] Failed to update workflow on error:', err);
    }

    // Flush any buffered logs immediately
    this.flushLogBuffer();

    this.emitEvent(workflowId, 'workflow_error', { source, error });

    this.runPostWorkflowCleanup();
  }

  /**
   * Emit a WebSocket-compatible event.
   */
  private emitEvent(workflowId: string, type: WsEvent['type'], data: Record<string, unknown>): void {
    const event: WsEvent = {
      type,
      workflowId,
      ...data,
      timestamp: new Date().toISOString(),
    } as unknown as WsEvent;

    this.emit('workflow-event', event);

    // Buffer log events for database persistence
    if (type === 'log' && event.message) {
      this.bufferLog(workflowId, {
        timestamp: event.timestamp,
        message: event.message,
        level: event.level || 'info',
      });
    }
  }

  /**
   * Calculate overall workflow progress.
   */
  private calculateProgress(workflow: WorkflowState): number {
    const stepOrder: WorkflowStep[] = [
      'script_generation',
      'voiceover',
      'thumbnail',
      'video_assembly',
      'upload',
    ];

    const weights = [25, 20, 15, 30, 10]; // Total: 100
    let progress = 0;

    for (let i = 0; i < stepOrder.length; i++) {
      const step = workflow.steps[stepOrder[i]];
      if (step.status === 'completed') {
        progress += weights[i];
      } else if (step.status === 'running') {
        progress += weights[i] * 0.5;
      }
    }

    return Math.round(progress);
  }

  /**
   * Get workflow state by ID.
   */
  getWorkflow(id: string): WorkflowState | undefined {
    return this.workflows.get(id);
  }

  /**
   * Get all workflows (most recent first).
   */
  getAllWorkflows(): WorkflowState[] {
    return Array.from(this.workflows.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * Get workflow logs from database.
   */
  getWorkflowLogs(id: string, limit = 500): { timestamp: string; message: string; level: string }[] {
    try {
      return this.db.getLogs(id, limit);
    } catch {
      return [];
    }
  }

  /**
   * Cancel a running workflow.
   */
  cancelWorkflow(id: string): boolean {
    const workflow = this.workflows.get(id);
    if (!workflow) return false;
    if (workflow.status !== 'running' && workflow.status !== 'queued' && workflow.status !== 'awaiting_script_approval') return false;

    workflow.status = 'failed';
    workflow.updatedAt = new Date().toISOString();
    this.activeWorkflows.delete(id);

    // Persist to database
    try {
      this.db.updateWorkflow(workflow);
    } catch (err) {
      console.error('[DB] Failed to update workflow on cancel:', err);
    }

    this.emitEvent(id, 'workflow_error', { source: 'user', error: 'Workflow cancelled by user' });

    this.runPostWorkflowCleanup();
    return true;
  }

  /**
   * Check if a workflow is currently running.
   */
  isActive(id: string): boolean {
    return this.activeWorkflows.has(id);
  }

  /**
   * Delete a workflow from the database.
   */
  deleteWorkflow(id: string): boolean {
    const removed = this.workflows.delete(id);
    this.activeWorkflows.delete(id);
    try {
      return this.db.deleteWorkflow(id);
    } catch (err) {
      console.error('[DB] Failed to delete workflow:', err);
      return false;
    }
  }

  /**
   * Generate a descriptive filename for video/output files.
   * Format: {topic-slug}_{username}_{YYYY-MM-DD}_{HHmm}_{short-id}.mp4
   */
  private generateFilename(topic: string, username: string | undefined, workflowId: string, ext: string = '.mp4'): string {
    const slug = topic
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .toLowerCase()
      .slice(0, 30);
    const user = (username || 'unknown').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 15);
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const time = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const shortId = workflowId.slice(0, 6);
    return `${slug}_${user}_${date}_${time}_${shortId}${ext}`;
  }

  /**
   * Post-workflow cleanup to reclaim disk space.
   * - Keeps only the last N generated videos
   * - Cleans system temp files from video assembly
   * - Runs Docker system prune (async) to reclaim VHDX space
   */
  private runPostWorkflowCleanup(): void {
    try {
      // Keep last 10 video files per output directory
      for (const dir of ['assets/videos', 'videos']) {
        const fullDir = getOutputDir(dir);
        if (!fs.existsSync(fullDir)) continue;
        const files = fs.readdirSync(fullDir)
          .filter(f => f.endsWith('.mp4'))
          .map(f => ({ name: f, time: fs.statSync(path.join(fullDir, f)).mtimeMs }))
          .sort((a, b) => b.time - a.time);
        if (files.length > 10) {
          for (const f of files.slice(10)) {
            fs.unlinkSync(path.join(fullDir, f.name));
          }
        }
      }
    } catch {
      // Non-critical cleanup
    }

    // Run Docker system prune asynchronously (fire-and-forget)
    this.runDockerPrune();
  }

  private runDockerPrune(): void {
    try {
      execSync('docker system prune -f --volumes 2>nul', { timeout: 30000, windowsHide: true });
    } catch {
      // Docker not available or prune failed - non-critical
    }
  }

  /**
   * Built-in fallback script generator (used when GPT4All is unavailable).
   */
  private generateShortFallbackScript(topic: string, tone?: string): string {
    const hooks: Record<string, string[]> = {
      educational: [
        `Here's what most people get WRONG about ${topic}.`,
        `The truth about ${topic} that nobody talks about.`,
        `I wish I knew THIS about ${topic} sooner.`,
        `Stop learning ${topic} the hard way. Do this instead.`,
        `One ${topic} secret that 99% of people don't know.`,
        `Ask yourself: when was the last time ${topic} actually clicked for you?`,
        `Three words that change everything about ${topic}.`,
        `The ${topic} advice everyone gives you? It's wrong. Here's why.`,
        `What if I told you ${topic} is simpler than you think?`,
        `Here's the ${topic} lesson nobody taught you in school.`,
        `The number one reason people fail at ${topic} — and how to fix it.`,
        `You've been doing ${topic} backwards. Let me explain.`,
        `This one mindset shift made ${topic} click for me.`,
        `Why do 90% of people quit ${topic} within a month? Here's the real reason.`,
        `Before you spend another minute on ${topic}, watch this.`,
      ],
      entertaining: [
        `You won't believe what I just found out about ${topic}.`,
        `They don't want you to know THIS about ${topic}.`,
        `This ${topic} fact will blow your mind.`,
        `Here's why ${topic} is more interesting than you think.`,
        `Wait until you hear this about ${topic}.`,
        `${topic} just got a whole lot weirder. And I'm here for it.`,
        `I tried the weirdest ${topic} hack so you don't have to.`,
        `This ${topic} story is WILD. You won't believe how it ends.`,
        `Okay, hear me out about ${topic}. I promise it's worth it.`,
        `The ${topic} industry doesn't want you to know this one thing.`,
        `I went down a ${topic} rabbit hole and found THIS.`,
        `Hold onto your seat — this ${topic} revelation changes everything.`,
        `Nobody talks about this side of ${topic}. Let's fix that.`,
        `This ${topic} plot twist caught me completely off guard.`,
        `You think you know ${topic}? Think again.`,
      ],
      professional: [
        `Most professionals get ${topic} completely wrong.`,
        `Stop making these ${topic} mistakes. Here's the fix.`,
        `The ${topic} strategy that actually works in 2026.`,
        `Here's your ${topic} cheat sheet. Save this.`,
        `The ROI of getting ${topic} right is massive.`,
        `Here's the ${topic} framework I use with my clients.`,
        `Three ${topic} metrics that actually matter. Ignore the rest.`,
        `The gap between average and elite ${topic}? It's smaller than you think.`,
        `What nobody tells you about scaling ${topic} in your organization.`,
        `I analyzed 100 ${topic} case studies. Here's the common thread.`,
        `The ${topic} playbook that top performers don't share publicly.`,
        `Stop guessing with ${topic}. Here's a system that works.`,
        `This ${topic} audit revealed a 40% efficiency gap. Here's how to close it.`,
        `The ${topic} advice that actually moves the needle in 2026.`,
        `Your ${topic} strategy is leaking time and money. Here's the patch.`,
      ],
      casual: [
        `So here's the thing about ${topic} that nobody mentions.`,
        `Real talk about ${topic} that you need to hear.`,
        `If you're into ${topic}, this one's for you.`,
        `Let's be real about ${topic} for a second.`,
        `Before you dive into ${topic}, watch this.`,
        `Can we talk about ${topic}? Like, actually talk about it.`,
        `I need to get something off my chest about ${topic}.`,
        `${topic} doesn't have to be this hard. Seriously.`,
        `Every ${topic} beginner makes this same mistake. Don't be them.`,
        `Here's the unfiltered truth about ${topic}. No fluff.`,
        `I wish someone had told me this about ${topic} years ago.`,
        `Let's cut the BS about ${topic} and talk about what actually works.`,
        `You're overthinking ${topic}. Here's the simple version.`,
        `The ${topic} advice I wish I could go back and give my past self.`,
        `Hot take: most ${topic} advice is garbage. Here's what's not.`,
      ],
    };

    const valuePoints: Record<string, string[]> = {
      educational: [
        `Most people jump straight into ${topic} without understanding the foundation. That's why they fail. Start with the core principles before you try anything advanced.`,
        `Here's what actually matters: focus on the one thing that makes the biggest difference in ${topic}. Everything else is just noise until you master that.`,
        `The biggest mistake? Trying to learn everything at once. Instead, pick ONE area of ${topic} and go deep. Mastery beats breadth every time.`,
        `Think about ${topic} like building a house. You wouldn't put on the roof before pouring the foundation. Same principle applies here — get the basics rock solid first.`,
        `One concept that changed how I think about ${topic}: the 80/20 rule. 80% of your results come from 20% of your effort. Find that 20% and double down.`,
        `Here's a mental model for ${topic}: instead of asking "what should I learn", ask "what problem am I solving". Start with the problem, work backward to the knowledge.`,
        `The difference between knowing about ${topic} and being good at it? Deliberate practice. Not just doing it, but doing it with intention and feedback.`,
        `Most tutorials skip the WHY behind ${topic}. Understanding the why makes the how 10x easier to remember and apply.`,
        `I see people burn out on ${topic} because they try to optimize everything at once. Pick one thing, make it a habit, then move to the next.`,
        `Fun experiment: explain ${topic} to a friend in one minute. If you can't simplify it, you don't understand it well enough yet.`,
      ],
      entertaining: [
        `Here's the crazy part about ${topic} — the more you dig, the weirder it gets. The things you think you know? Half of them are wrong.`,
        `The biggest flex in ${topic}? Knowing the one weird trick that 99% of people overlook. It's the difference between being good and being great.`,
        `Funny thing about ${topic} — the people who actually succeed at it do the exact opposite of what everyone else is doing.`,
        `This is going to sound insane, but the history of ${topic} is full of accidents that changed everything. Serendipity is more powerful than strategy.`,
        `Here's the irony of ${topic}: the more seriously you take it, the worse you get. The best in the world treat it like a game.`,
        `You know what's wild about ${topic}? The biggest breakthroughs came from people who had NO idea what they were doing. They just got curious and refused to stop.`,
        `Plot twist: everything you think you know about ${topic} was probably designed to make you buy something. The real story is way more interesting.`,
        `The most successful ${topic} stories start with failure. Like, spectacular, embarrassing failure. The kind most people would quit over. That's the secret.`,
        `I found this ${topic} fact so weird I had to triple-check it. It's true. And it changes everything.`,
        `The universe has a weird sense of humor with ${topic}. The things you stress about? They almost never matter. The things you ignore? They end up being everything.`,
      ],
      professional: [
        `The data is clear: teams that invest in ${topic} see 3x better results. But only if they do it right. Here's what the top performers have in common.`,
        `Stop treating ${topic} like an afterthought. The companies winning in 2026 have made it their #1 priority. Here's their playbook.`,
        `The most underrated ${topic} strategy? Consistency over intensity. Small daily actions compound into massive results over time.`,
        `Let's talk about the ${topic} stack that delivers. First, you need the right tooling. Second, you need the right process. Third, you need the right people. Skip any one and it falls apart.`,
        `Here's a framework I use with every ${topic} client: Assess, Prioritize, Execute, Review. Most teams skip straight to Execute and wonder why nothing changes.`,
        `The biggest ${topic} mistake I see in organizations: they copy what successful companies do without understanding the context. Your situation is different. Your solution should be too.`,
        `Stop measuring activity. Start measuring outcomes. Hours spent on ${topic} means nothing. What changed as a result of those hours? That's what matters.`,
        `The most profitable ${topic} investment you can make? Documentation. I know it sounds boring. But every dollar spent on clarity saves ten dollars on confusion.`,
        `If you're not tracking these three ${topic} KPIs, you're flying blind: input quality, process efficiency, and outcome impact. Measure what matters.`,
        `The best ${topic} teams ship fast and iterate faster. They don't wait for perfect — they launch, learn, and improve. Speed is your competitive advantage.`,
      ],
      casual: [
        `The thing about ${topic} is that everyone overcomplicates it. Strip it back to basics and suddenly everything clicks.`,
        `Here's the real tea about ${topic}: nobody knows what they're doing at first. The ones who succeed just kept showing up.`,
        `The easiest way to get started with ${topic}? Literally just start. Perfect is the enemy of done.`,
        `I tried being perfect at ${topic} for years. Know what happened? Nothing. The moment I allowed myself to be messy, everything changed.`,
        `The vibe with ${topic} is simple: do it badly until you can do it well. There's no shortcut. There's no cheat code. Just showing up again and again.`,
        `Here's what nobody tells you about ${topic}: the first six months are going to feel like you're getting nowhere. Push through. That's where the magic happens.`,
        `You don't need a detailed ${topic} plan. You need to take one step today. Tomorrow, take another. That's literally the entire secret.`,
        `I've never met someone who regretted starting ${topic} earlier. But I've met hundreds who wished they started sooner. Don't be the person who waits.`,
        `The ${topic} community is full of people pretending they have it all figured out. Nobody does. We're all figuring it out as we go.`,
        `If ${topic} feels hard right now, good. That means you're growing. The day it feels easy is the day you stopped learning.`,
      ],
    };

    const transitions: Record<string, string[]> = {
      educational: [
        `Here's what I mean by that.`,
        `Let me break this down.`,
        `Think about it this way:`,
        `And here's the important part:`,
        `Now here's something most people miss:`,
        `But here's the catch:`,
        `This is where it gets interesting:`,
      ],
      entertaining: [
        `Here's where it gets crazy:`,
        `But wait — there's more.`,
        `And this is the best part:`,
        `You're not gonna believe this part:`,
        `Here's the kicker:`,
        `This next part is WILD:`,
        `And THEN this happened:`,
      ],
      professional: [
        `Here's the execution layer:`,
        `Now let's look at the numbers:`,
        `Here's what this means in practice:`,
        `The key insight:`,
        `Let me give you a concrete example:`,
        `Here's how to implement this:`,
        `The bottom line:`,
      ],
      casual: [
        `So here's the deal:`,
        `And honestly?`,
        `Here's the thing though:`,
        `Like, think about it:`,
        `The reality is:`,
        `Here's what I mean:`,
        `But seriously though:`,
      ],
    };

    const ctas: Record<string, string[]> = {
      educational: [
        `Save this for later. Follow for more ${topic} insights. Drop a comment if this helped.`,
        `Follow for more. Save this video so you don't forget.`,
        `Like if you learned something. Share with someone who needs to hear this.`,
        `Comment your biggest ${topic} struggle. I read every single one and I'll make a video answering the best questions.`,
        `Save this — it's your ${topic} cheat sheet. Follow for part two where I go deeper.`,
        `If you got value, share this with someone starting their ${topic} journey. We rise together.`,
        `Here's my challenge to you: take ONE thing from this video and apply it today. Comment what you picked.`,
        `Follow for daily ${topic} insights. The algorithm only shows my content to people who engage, so like and comment to stay in the loop.`,
      ],
      entertaining: [
        `Like if this surprised you. Share it with a friend. Follow for more mind-blowing facts.`,
        `Comment what you think. I know you have an opinion on this.`,
        `Save this. You'll want to show your friends later. Follow for more crazy facts.`,
        `Follow for more ${topic} content that'll blow your mind. Trust me, this is just the tip of the iceberg.`,
        `Comment "more" if you want a deep dive on this. I'll make it if enough people ask.`,
        `Share this with someone who needs a mind-blowing fact today. You'll make their day.`,
        `Like if you made it this far. You're part of the 1% who actually finishes videos. Respect.`,
        `Drop a 🧠 in the comments if your brain is as fried as mine right now.`,
      ],
      professional: [
        `Save this cheat sheet. Follow for more ${topic} strategies. Share with your team.`,
        `Follow for actionable insights. Save this for your next ${topic} meeting.`,
        `Drop a comment with your biggest takeaway. Let's learn from each other.`,
        `Bookmark this video. Reference it next time you're planning your ${topic} strategy. Share it with a colleague who needs it.`,
        `Follow for weekly ${topic} frameworks. I break down complex topics into actionable playbooks.`,
        `What's the one ${topic} challenge you're facing right now? Comment below and I'll address it in my next video.`,
        `Share this with your team lead. Good ${topic} practices start with the whole team being aligned.`,
        `Like if this added value. Comment your insights. Follow for more. Let's build better systems together.`,
      ],
      casual: [
        `Save this for later. Follow for more real talk. Share with someone who needs to hear it.`,
        `Comment your hot take. I want to hear what you think.`,
        `Like if you agree. Follow for more. Save this — you'll thank me later.`,
        `Follow for unfiltered ${topic} advice. No BS, no fluff, just real talk from someone who's been there.`,
        `Comment if this hit home. I want to hear your story. We're all in this together.`,
        `Share this with a friend who's struggling with ${topic}. They probably need to hear it today.`,
        `Like if you're tired of people overcomplicating ${topic}. Let's keep it real.`,
        `Save this for those days when ${topic} feels impossible. Come back to it. You've got this.`,
      ],
    };

    const safeTone = (tone || 'educational') as keyof typeof hooks;
    const hooksList = hooks[safeTone] || hooks.educational;
    const valueList = valuePoints[safeTone] || valuePoints.educational;
    const transList = transitions[safeTone] || transitions.educational;
    const ctaList = ctas[safeTone] || ctas.educational;

    const hook = hooksList[Math.floor(Math.random() * hooksList.length)];

    // Pick 1-2 value points randomly (never all)
    const valueCount = Math.min(1 + Math.floor(Math.random() * 2), valueList.length);
    const shuffledValues = [...valueList].sort(() => Math.random() - 0.5);
    const selectedValues = shuffledValues.slice(0, valueCount);

    // Interleave value points with random transitions
    const valueText = selectedValues.map((v, i) => {
      const trans = i > 0 ? (transList[Math.floor(Math.random() * transList.length)] + ' ') : '';
      return trans + v;
    }).join(' ');

    const cta = ctaList[Math.floor(Math.random() * ctaList.length)];

    // Vary structure: sometimes hook first, sometimes question first, sometimes hook+value interleaved
    const patterns = [
      () => `[HOOK] ${hook} [VALUE] ${valueText} [CTA] ${cta}`,
      () => `[HOOK] ${hook} [VALUE] Here's what you need to know. ${valueText} [CTA] ${cta}`,
      () => `[VALUE] ${valueText} [HOOK] ${hook} [CTA] ${cta}`,
      () => `[HOOK] ${hook} [VALUE] ${valueText} Here's the bottom line: ${selectedValues.length > 0 ? selectedValues[selectedValues.length - 1] : ''} [CTA] ${cta}`,
    ];
    const chosen = patterns[Math.floor(Math.random() * patterns.length)];

    return chosen();
  }

  private generateFallbackScript(topic: string, tone?: string): string {
    const tones = tone || 'educational';
    return `In this video, we explore ${topic} from a ${tones} perspective. 
    
First, let's understand the fundamentals. ${topic} is a fascinating subject that has gained significant attention in recent years. The key concepts revolve around understanding how different components work together.

Let me walk you through the most important aspects. When you break it down, there are three main areas to focus on:

1. The core principles that define ${topic}
2. Real-world applications and use cases
3. Best practices for implementation

What makes ${topic} particularly interesting is how it continues to evolve. New developments emerge regularly, and staying up to date is crucial.

In practice, you'll find that mastering ${topic} opens up numerous opportunities. Whether you're a beginner or an experienced professional, there's always something new to learn.

To summarize what we've covered: understanding ${topic} requires patience, practice, and a willingness to explore. Start with the basics, build your knowledge gradually, and don't be afraid to experiment.

Thanks for watching! If you found this helpful, please like and subscribe for more content. Let me know in the comments what you'd like to learn about next.`;
  }

  /**
   * Generate a fallback thumbnail image (server-side).
   */
  private generateFallbackThumbnail(topic: string, workflowId: string): string {
    const { createCanvas } = require('canvas') || {};
    const thumbDir = getOutputDir('assets/thumbnails');
    const filename = this.generateFilename(topic, 'fallback', workflowId, '.png');
    const filePath = path.join(thumbDir, filename);

    try {
      // Try using canvas if available
      const canvas = createCanvas?.(1280, 720);
      if (canvas) {
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 720);
        gradient.addColorStop(0, '#1a1a2e');
        gradient.addColorStop(1, '#16213e');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 1280, 720);

        ctx.fillStyle = '#e94560';
        ctx.fillRect(0, 300, 1280, 6);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 48px Arial';
        ctx.textAlign = 'center';
        
        const words = topic.split(' ');
        const lines: string[] = [];
        let currentLine = '';
        for (const word of words) {
          if ((currentLine + ' ' + word).length > 25) {
            lines.push(currentLine);
            currentLine = word;
          } else {
            currentLine += (currentLine ? ' ' : '') + word;
          }
        }
        if (currentLine) lines.push(currentLine);

        const startY = 360 - ((lines.length - 1) * 30);
        lines.forEach((line, i) => {
          ctx.fillText(line, 640, startY + i * 60);
        });

        ctx.fillStyle = '#e94560';
        ctx.font = 'bold 28px Arial';
        ctx.fillText('▶ WATCH NOW', 640, 620);

        const buffer = canvas.toBuffer('image/png');
        require('fs').writeFileSync(filePath, buffer);
      }
    } catch {
      // Canvas not available - skip server-side thumbnail
    }

    return filePath;
  }
}
