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
  PipelineRequest,
  PipelineResult,
  ScriptResult,
  VoiceoverResult,
  ThumbnailResult,
  VideoResult,
  UploadResult,
  WsEvent,
} from '../types';
import { getOutputDir, findPython } from './pythonRunner';
import { ShortVideoScene } from './shortVideoMaker';
import { generateStickmanStoryJson, clearFailedModels } from './aiProvider';
import { getDatabase } from './database';
import fs from 'fs';
import { WorkflowScriptGenService } from './workflowScriptGenService';
import { WorkflowAssemblyService } from './workflowAssemblyService';
import { WorkflowMediaService } from './workflowMediaService';

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

  // Extracted service modules
  readonly scriptGen: WorkflowScriptGenService;
  readonly assembly: WorkflowAssemblyService;
  readonly mediaService: WorkflowMediaService;

  constructor() {
    super();

    // Restore workflows from database on startup
    this.restoreFromDb();

    // Flush log buffer every 2 seconds
    this.flushTimer = setInterval(() => this.flushLogBuffer(), 2000);

    const ctx = {
      workflows: this.workflows,
      db: {
        updateWorkflow: (wf: WorkflowState) => this.db.updateWorkflow(wf),
        getWorkflow: (id: string) => this.db.getWorkflow(id) ?? undefined,
        insertLogs: (workflowId: string, logs: unknown[]) => this.db.insertLogs(workflowId, logs as any),
        close: () => this.db.close(),
      },
      emitEvent: (id: string, type: any, data: Record<string, unknown>) => this.emitEvent(id, type, data),
      updateStep: (id: string, step: any, status: any, result?: unknown) => this.updateStep(id, step, status, result),
      handleError: (id: string, source: string, error: string) => this.handleError(id, source, error),
      completeWorkflow: (id: string, results: any, videoPath?: string) => this.completeWorkflow(id, results, videoPath),
      generateFilename: (topic: string, username: string | undefined, workflowId: string, ext?: string) => this.generateFilename(topic, username, workflowId, ext),
      emitBridgeStatus: (id: string, status: string, message: string, progress?: number) => this.emitBridgeStatus(id, status as any, message, progress as any),
    };
    this.scriptGen = new WorkflowScriptGenService(ctx);
    this.assembly = new WorkflowAssemblyService(ctx);
    this.mediaService = new WorkflowMediaService(ctx);

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
      // Short style or manual/gemini story uses short pipeline (script approval, media upload)
      if (request.style === 'short' || request.footage_source === 'manual_story' || request.footage_source === 'gemini_story' || request.footage_source === 'stickman_story') {
        await this.executeShortPipeline(workflowId, request, results);
        return;
      }

      // Step 1: Script Generation
      this.updateStep(workflowId, 'script_generation', 'running');
      const scriptResult = await this.scriptGen.generateScript(workflowId, request, request.ai_model);
      results.script_generation = scriptResult;
      this.updateStep(workflowId, 'script_generation', 'completed', scriptResult);

      if (!scriptResult.success) {
        throw new Error('Script generation failed');
      }

      // Step 2: Voiceover Generation
      this.updateStep(workflowId, 'voiceover', 'running');
      const voiceoverResult = await this.scriptGen.generateVoiceover(
        workflowId,
        scriptResult.script,
        request.voice
      );
      results.voiceover = voiceoverResult;
      this.updateStep(workflowId, 'voiceover', 'completed', voiceoverResult);

      // Step 3: Thumbnail Generation
      this.updateStep(workflowId, 'thumbnail', 'running');
      const thumbnailResult = await this.scriptGen.generateThumbnail(
        workflowId,
        request.topic,
        request.thumbnail_style
      );
      results.thumbnail = thumbnailResult;
      this.updateStep(workflowId, 'thumbnail', 'completed', thumbnailResult);

      // Step 4: Video Assembly
      this.updateStep(workflowId, 'video_assembly', 'running');
      const videoResult = await this.assembly.assembleVideo(
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
        const uploadResult = await this.assembly.uploadVideo(
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

    // Try AI scene generation first (Groq/OpenRouter)
    const aiScenes = await this.scriptGen.generateAIScenes(workflowId, request.topic, request.tone, request.duration_minutes, request.ai_model);

    let scenes: ShortVideoScene[] = [];
    let script = '';
    let modelUsed = 'builtin-fallback';
    let stickmanMasterJson: string | undefined;

    // For gemini story, use the master JSON generator instead
    if (request.footage_source === 'gemini_story' || request.footage_source === 'stickman_story' || request.footage_source === 'manual_story') {
      // Clear any cached "failed" model state from prior rate limits
      clearFailedModels();
      this.emitEvent(workflowId, 'log', { message: 'Generating gemini story master script...' });
      const storySceneCount = request.story_scene_count || 30;
      const stickmanResult = await generateStickmanStoryJson(request.topic, request.tone, request.ai_model, storySceneCount);
      if (stickmanResult.success && stickmanResult.json) {
        try {
          const cleanJson = stickmanResult.json
            .replace(/```json\s*/gi, '')
            .replace(/```\s*$/gm, '')
            .trim();
          const parsed = JSON.parse(cleanJson);
          const pipeline = parsed.script_pipeline || [];
          if (pipeline.length > 0) {
            scenes = pipeline.map((s: any) => ({
              text: s.narration_text || '',
              searchTerms: [],
            }));
            // Use full_story from AI if available (proper paragraphs → natural TTS)
            // Fallback: join scene texts (legacy format)
            script = parsed.full_story || scenes.map((s: any) => s.text).join(' ');
            modelUsed = `gemini-ai (${stickmanResult.model})`;
            stickmanMasterJson = stickmanResult.json;
            this.emitEvent(workflowId, 'log', { message: `Gemini story generated with ${scenes.length} scenes` });
          } else {
            throw new Error('Empty script_pipeline');
          }
        } catch (e) {
          this.emitEvent(workflowId, 'log', { message: `Gemini story JSON parsing failed: ${e}`, level: 'warn' });
          stickmanMasterJson = undefined;
        }
      }
      if (!stickmanMasterJson) {
        // Fall back to normal AI scenes
        this.emitEvent(workflowId, 'log', { message: 'Gemini story generation failed, falling back to standard scenes', level: 'warn' });
      }
    }

    if (!stickmanMasterJson) {
      if (aiScenes.length > 0) {
        if (!scenes || scenes.length === 0) {
          this.emitEvent(workflowId, 'log', { message: `AI generated ${aiScenes.length} scenes successfully` });
          scenes = aiScenes;
          script = scenes.map(s => s.text).join('. ');
          modelUsed = 'ai-provider';
        }
      } else if (!scenes || scenes.length === 0) {
        this.emitEvent(workflowId, 'log', { message: 'AI scene generation returned empty — falling back to viral template', level: 'warn' });
        scenes = this.scriptGen.buildShortScenes(request.topic, request.tone, request.duration_minutes);
        script = scenes.map(s => s.text).join('. ');
        modelUsed = 'viral-template';
      }
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
      workflow.stickman_master_json = stickmanMasterJson;
      workflow.gemini_master_json = stickmanMasterJson;

      // Store full_story for natural TTS. Either AI-generated (paragraphs) or joined scenes (legacy)
      workflow.full_story = script;

      // Store request params for later continuation
      workflow.tone = request.tone;
      workflow.duration_minutes = request.duration_minutes;
      workflow.footage_source = request.footage_source;
      workflow.voice = request.voice;
      workflow.add_subtitles = request.add_subtitles;
      workflow.ai_model = request.ai_model;
      workflow.caption_position = request.caption_position;
      workflow.caption_background_color = request.caption_background_color;

      // Store aspect_ratio for manual mode
      if (request.aspect_ratio) {
        workflow.aspect_ratio = request.aspect_ratio;
      }

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

    const fullScript = workflow.full_story || scenes.map(s => s.text.trim()).join(' ');
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
      aspect_ratio: (workflow as any).aspect_ratio || '9:16',
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
    // For manual_story mode, pause for voiceover first (user can upload or generate)
    if (request.footage_source === 'manual_story') {
      await this.mediaService.pauseForVoiceover(workflowId, scenes, fullScript, request, results);
      return;
    }

    // For all other modes, auto-generate TTS
    this.updateStep(workflowId, 'voiceover', 'running');
    this.emitEvent(workflowId, 'log', { message: `Generating voiceover for ${scenes.length} scenes...` });

    const voiceoverResult = await this.scriptGen.generateVoiceover(workflowId, fullScript, request.voice);
    results.voiceover = voiceoverResult;
    this.updateStep(workflowId, 'voiceover', 'completed', voiceoverResult);

    if (!voiceoverResult.success || !voiceoverResult.file_path) {
      throw new Error('Voiceover generation failed');
    }

    if (request.footage_source === 'sidecar') {
      await this.assembly.renderWithSidecar(workflowId, scenes, voiceoverResult.file_path, request, results);
    } else if (request.footage_source === 'gemini_story' || request.footage_source === 'stickman_story') {
      await this.assembly.renderWithGeminiStory(workflowId, scenes, voiceoverResult.file_path, request, results);
    } else {
      await this.assembly.renderWithYouTubeClips(workflowId, scenes, voiceoverResult.file_path, request, results);
    }
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
  /**
   * Emit a bridge_status WebSocket event.
   * Used by the Gemini bridge service to report progress to subscribed clients.
   */
  emitBridgeStatus(
    workflowId: string,
    status: 'initializing' | 'ready' | 'active' | 'complete' | 'failed' | 'timeout' | 'absent',
    message: string,
    progress?: { received: number; total: number }
  ): void {
    this.emitEvent(workflowId, 'bridge_status', {
      status,
      message,
      progress,
    } as unknown as Record<string, unknown>);
  }

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

  emitBridgeStatus(
    workflowId: string,
    status: 'initializing' | 'ready' | 'active' | 'complete' | 'failed' | 'timeout' | 'absent',
    message: string,
    progress?: { received: number; total: number }
  ): void {
    this.emitEvent(workflowId, 'bridge_status', {
      status,
      message,
      progress,
    } as unknown as Record<string, unknown>);
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
  // ========================================
  // Scene Image Management (awaiting_images state)
  // ========================================

  /**
   * Get scene image info for a workflow paused at awaiting_images.
   */
  getSceneImages(workflowId: string): Array<{ sceneIndex: number; text: string; status: string; fileUrl?: string }> | null {
    const workflow = this.workflows.get(workflowId);
    if (!workflow || !workflow.scene_images) return null;

    // Build file URLs for images that exist
    return workflow.scene_images.map(si => ({
      sceneIndex: si.sceneIndex,
      text: si.text,
      status: si.status,
      fileUrl: si.filePath ? `/api/scene-file/${workflowId}/${String(si.sceneIndex).padStart(4, '0')}.png` : undefined,
      uploadedAt: si.uploadedAt,
    }));
  }

  /**
   * Upload an image for a specific scene in a workflow paused at awaiting_images.
   */
  async uploadSceneImage(workflowId: string, sceneIndex: number, imageBuffer: Buffer): Promise<boolean> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow || workflow.status !== 'awaiting_images') return false;
    if (!workflow.gemini_scenes_dir) return false;

    const dir = workflow.gemini_scenes_dir;
    fs.mkdirSync(dir, { recursive: true });

    const filename = `scene_${String(sceneIndex).padStart(4, '0')}.png`;
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, imageBuffer);

    // Update scene_images array
    if (!workflow.scene_images) {
      workflow.scene_images = [];
    }

    const existing = workflow.scene_images.find(si => si.sceneIndex === sceneIndex);
    if (existing) {
      existing.status = 'manual_upload';
      existing.filePath = filePath;
      existing.uploadedAt = new Date().toISOString();
    } else {
      workflow.scene_images.push({
        sceneIndex,
        text: `Scene ${sceneIndex + 1}`,
        status: 'manual_upload',
        filePath,
        uploadedAt: new Date().toISOString(),
      });
    }

    workflow.updatedAt = new Date().toISOString();
    this.workflows.set(workflowId, workflow);
    this.db.updateWorkflow(workflow);

    this.emitEvent(workflowId, 'log', {
      message: `Scene ${sceneIndex + 1} image uploaded manually`,
      level: 'info',
    });

    return true;
  }

  /**
   * Continue a workflow from awaiting_images to video assembly.
   * Assembles the video with whatever images are available (auto + manual).
   */
  async continueToVideo(workflowId: string): Promise<boolean> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow || workflow.status !== 'awaiting_images') return false;
    if (!workflow.gemini_scenes_dir) return false;

    const scenes = workflow.scenes || [];
    const audioPath = workflow.steps.voiceover?.result as { file_path?: string } | undefined;
    const audioFile = audioPath?.file_path;

    if (!audioFile || !fs.existsSync(audioFile)) {
      this.emitEvent(workflowId, 'log', {
        message: 'Voiceover audio not found — cannot assemble video',
        level: 'error',
      });
      return false;
    }

    const outputDir = getOutputDir('assets/videos');
    const outputFilename = this.generateFilename(workflow.topic, workflow.createdBy, workflowId, '.mp4');
    const outputPath = path.join(outputDir, outputFilename);

    const scenesDir = workflow.gemini_scenes_dir;

    // Check how many images we have
    const imageFiles = fs.readdirSync(scenesDir).filter(f => f.endsWith('.png'));
    this.emitEvent(workflowId, 'log', {
      message: `Continuing to video with ${imageFiles.length} scene image(s) from ${scenesDir}`,
      level: 'info',
    });

    if (imageFiles.length === 0) {
      this.emitEvent(workflowId, 'log', {
        message: 'No scene images found — cannot assemble video',
        level: 'error',
      });
      return false;
    }

    const localResults: Partial<Record<WorkflowStep, unknown>> = {};
    this.updateStep(workflowId, 'video_assembly', 'running');

    // Call ffmpeg_video.py with --images flag to use saved scene images
    // This is the same approach gemini_story.py uses for assembly.
    try {
      const pythonExe = findPython();
      const ffmpegScript = path.resolve(__dirname, '..', '..', '..', 'python', 'ffmpeg_video.py');

      const { spawn } = require('child_process');
      const ffmpegResult = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
        const proc = spawn(pythonExe, [
          ffmpegScript,
          '--images', scenesDir,
          '--audio', audioFile,
          '--output', outputPath,
          '--resolution', '768x432',
          '--fps', '10',
          '--subtitles', 'true',
        ], {
          cwd: path.dirname(ffmpegScript),
          timeout: 180000,
          windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', (code: number) => resolve({ stdout, stderr, code }));
        proc.on('error', reject);
      });

      if (ffmpegResult.code !== 0) {
        throw new Error(`ffmpeg_video.py exited ${ffmpegResult.code}: ${ffmpegResult.stderr.slice(0, 500)}`);
      }

      // Parse the last JSON line from stdout
      let videoResult: VideoResult;
      try {
        const lines = ffmpegResult.stdout.trim().split('\n');
        videoResult = JSON.parse(lines[lines.length - 1]) as VideoResult;
      } catch {
        throw new Error('Could not parse ffmpeg_video.py output');
      }

      if (!videoResult.success) {
        throw new Error(videoResult.error || 'ffmpeg_video.py reported failure');
      }

      this.emitEvent(workflowId, 'log', {
        message: `Video assembled from ${imageFiles.length} scene images`,
        level: 'info',
      });

      localResults['video_assembly'] = videoResult;
      this.updateStep(workflowId, 'video_assembly', 'completed', videoResult);

      localResults['upload'] = { success: true, message: 'Upload skipped (gemini story)', fallback: true } as unknown as UploadResult;
      this.updateStep(workflowId, 'upload', 'skipped');

      this.completeWorkflow(workflowId, localResults, videoResult.file_path || outputPath);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitEvent(workflowId, 'log', {
        message: `Video assembly failed after manual upload: ${msg}`, level: 'error',
      });
      this.updateStep(workflowId, 'video_assembly', 'failed', { error: msg });
      return false;
    }
  }





  /**
   * Continue a workflow from awaiting_voiceover to awaiting_media.
   * Called after user uploads a voiceover file or triggers TTS generation.
   */
  async continueAfterVoiceover(workflowId: string, voiceoverResult: any): Promise<boolean> {
    return this.mediaService.receiveVoiceover(workflowId, voiceoverResult);
  }

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
    if (workflow.status !== 'running' && workflow.status !== 'queued' && workflow.status !== 'awaiting_script_approval' && workflow.status !== 'awaiting_images' && workflow.status !== 'awaiting_media' && workflow.status !== 'awaiting_voiceover') return false;

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





}
