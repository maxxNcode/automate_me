import { OrchestratorContext } from './workflowContext';
import { runPythonScript, getOutputDir, findPython } from './pythonRunner';
import {
  WorkflowState,
  WorkflowStep,
  StepStatus,
  ManualMediaInfo,
  WsEvent,
  VideoResult,
  UploadResult,
} from '../types';
import fs from 'fs';
import path from 'path';

export class WorkflowMediaService {
  constructor(private ctx: OrchestratorContext) {}

  /**
   * Pause the pipeline for voiceover (manual_story mode).
   * Sets awaiting_voiceover state instead of auto-generating TTS.
   * When user uploads or generates, call receiveVoiceover().
   */
  async pauseForVoiceover(
    workflowId: string,
    scenes: Array<{ text: string; searchTerms: string[] }>,
    fullScript: string,
    request: any,
    results: Partial<Record<WorkflowStep, unknown>>
  ): Promise<void> {
    const workflow = this.ctx.workflows.get(workflowId);
    if (!workflow) throw new Error('Workflow not found');

    this.ctx.updateStep(workflowId, 'thumbnail', 'skipped');
    this.ctx.updateStep(workflowId, 'voiceover', 'pending');
    this.ctx.updateStep(workflowId, 'video_assembly', 'pending');

    // Store all the data we'll need for media stage on the workflow
    workflow.full_story = fullScript;
    workflow.status = 'awaiting_voiceover';
    workflow.updatedAt = new Date().toISOString();
    this.ctx.workflows.set(workflowId, workflow);
    this.ctx.db.updateWorkflow(workflow);

    this.ctx.emitEvent(workflowId, 'voiceover_pending', {
      scenes_count: scenes.length,
    } as unknown as Record<string, unknown>);

    this.ctx.emitEvent(workflowId, 'log', {
      message: `Voiceover needed for ${scenes.length} scenes. You can generate with AI TTS (Edge TTS / Kokoro) or upload your own recording.`,
      level: 'info',
    });
  }

  /**
   * Receive voiceover (user uploaded or generated) and transition
   * from awaiting_voiceover to awaiting_media.
   */
  async receiveVoiceover(workflowId: string, voiceoverResult: any): Promise<boolean> {
    const workflow = this.ctx.workflows.get(workflowId);
    if (!workflow || workflow.status !== 'awaiting_voiceover') return false;

    const scenes = workflow.scenes;
    if (!scenes || scenes.length === 0) {
      this.ctx.emitEvent(workflowId, 'log', {
        message: 'No scenes found — cannot continue after voiceover',
        level: 'error',
      });
      return false;
    }

    // Store voiceover result and emit step update event
    workflow.steps.voiceover = {
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: voiceoverResult,
    };
    this.ctx.updateStep(workflowId, 'voiceover', 'completed', voiceoverResult);
    workflow.updatedAt = new Date().toISOString();
    this.ctx.workflows.set(workflowId, workflow);

    this.ctx.emitEvent(workflowId, 'voiceover_ready', {} as unknown as Record<string, unknown>);

    this.ctx.emitEvent(workflowId, 'log', {
      message: `Voiceover ready (${voiceoverResult.duration_seconds?.toFixed(1) || '?'}s). Proceeding to media upload...`,
      level: 'info',
    });

    // Now transition to awaiting_media
    const request = {
      topic: workflow.topic,
      tone: workflow.tone || 'educational',
      duration_minutes: workflow.duration_minutes || 1,
      footage_source: workflow.footage_source || 'manual_story',
      voice: workflow.voice,
      add_subtitles: workflow.add_subtitles ?? true,
      username: workflow.createdBy,
      caption_position: workflow.caption_position,
      caption_background_color: workflow.caption_background_color,
      aspect_ratio: (workflow as any).aspect_ratio || '9:16',
    };

    await this.pauseForManualMedia(workflowId, scenes, voiceoverResult.file_path, request, {});
    return true;
  }

  async pauseForManualMedia(
    workflowId: string,
    scenes: Array<{ text: string; searchTerms: string[] }>,
    audioPath: string,
    request: any,
    results: Partial<Record<WorkflowStep, unknown>>
  ): Promise<void> {
    const workflow = this.ctx.workflows.get(workflowId);
    if (!workflow) throw new Error('Workflow not found');

    this.ctx.updateStep(workflowId, 'thumbnail', 'skipped');
    this.ctx.updateStep(workflowId, 'video_assembly', 'pending');

    const masterJson = workflow?.stickman_master_json || workflow?.gemini_master_json;
    let imagePrompts: string[] = [];
    let basePrompt = '';

    if (masterJson) {
      try {
        const cleanJson = masterJson
          .replace(/```json\s*/gi, '')
          .replace(/```\s*$/gm, '')
          .trim();
        const parsed = JSON.parse(cleanJson);
        const scriptPipeline = parsed.script_pipeline || [];
        imagePrompts = scriptPipeline.map((s: any) => s.image_prompt || s.sd_api_payload?.prompt || s.narration_text || '');
        basePrompt = parsed.setup_guide?.base_prompt || '';
      } catch (e) {
        this.ctx.emitEvent(workflowId, 'log', { message: `Failed to parse master JSON for prompts: ${e}`, level: 'warn' });
      }
    }

    if (imagePrompts.length === 0) {
      imagePrompts = scenes.map((s, i) =>
        (s as any).image_prompt || `Stickman scene ${i + 1}: ${s.text.substring(0, 100)}. Simple black stickman on white background.`
      );
    }

    const aspectRatio = request.aspect_ratio || '9:16';
    workflow.manual_media = scenes.map((s, i) => ({
      sceneIndex: i,
      sceneText: s.text,
      imagePrompt: imagePrompts[i] || s.text,
      mediaStatus: 'missing' as const,
    }));
    workflow.aspect_ratio = aspectRatio;
    workflow.base_prompt = basePrompt;
    workflow.status = 'awaiting_media';
    workflow.updatedAt = new Date().toISOString();
    this.ctx.workflows.set(workflowId, workflow);
    this.ctx.db.updateWorkflow(workflow);

    this.ctx.emitEvent(workflowId, 'log', {
      message: `Manual media mode: ${scenes.length} scenes ready. Upload your media in the UI then click "Assemble Final Video".`,
      level: 'info',
    });

    this.ctx.emitEvent(workflowId, 'media_ready', {
      manual_media: workflow.manual_media,
      aspect_ratio: aspectRatio,
      base_prompt: basePrompt,
    } as unknown as Record<string, unknown>);
  }

  async uploadManualMedia(workflowId: string, sceneIndex: number, fileBuffer: Buffer, originalName: string): Promise<boolean> {
    const workflow = this.ctx.workflows.get(workflowId);
    if (!workflow || workflow.status !== 'awaiting_media') return false;

    const ext = path.extname(originalName).toLowerCase();
    const imageExts = ['.png', '.jpg', '.jpeg'];
    const videoExts = ['.mp4', '.mov', '.webm', '.avi', '.mkv'];
    const isVideo = videoExts.includes(ext);

    if (!imageExts.includes(ext) && !videoExts.includes(ext)) {
      this.ctx.emitEvent(workflowId, 'log', {
        message: `Unsupported file format: ${ext}. Accepted: .png/.jpg (images) or .mp4/.mov/.webm (videos)`,
        level: 'error',
      });
      return false;
    }

    const mediaDir = getOutputDir(`assets/manual_media/${workflowId}`);
    fs.mkdirSync(mediaDir, { recursive: true });

    const destExt = isVideo ? '.mp4' : '.png';
    const filename = `scene_${String(sceneIndex).padStart(4, '0')}${destExt}`;
    const filePath = path.join(mediaDir, filename);
    fs.writeFileSync(filePath, fileBuffer);

    if (!workflow.manual_media) workflow.manual_media = [];

    const existing = workflow.manual_media.find(m => m.sceneIndex === sceneIndex);
    const mediaInfo: ManualMediaInfo = {
      sceneIndex,
      sceneText: existing?.sceneText || `Scene ${sceneIndex + 1}`,
      imagePrompt: existing?.imagePrompt || '',
      mediaStatus: 'uploaded',
      mediaType: isVideo ? 'video' : 'image',
      mediaFilePath: filePath,
      mediaFileUrl: `/api/workflow/media-file/${workflowId}/${filename}`,
      uploadedAt: new Date().toISOString(),
    };

    if (existing) {
      Object.assign(existing, mediaInfo);
    } else {
      workflow.manual_media.push(mediaInfo);
    }

    workflow.updatedAt = new Date().toISOString();
    this.ctx.workflows.set(workflowId, workflow);
    this.ctx.db.updateWorkflow(workflow);

    this.ctx.emitEvent(workflowId, 'log', {
      message: `Scene ${sceneIndex + 1} ${isVideo ? 'video' : 'image'} uploaded`,
      level: 'info',
    });

    return true;
  }

  async assembleManualVideo(workflowId: string): Promise<boolean> {
    const workflow = this.ctx.workflows.get(workflowId);
    if (!workflow || workflow.status !== 'awaiting_media') return false;

    const scenes = workflow.scenes || [];
    const manualMedia = workflow.manual_media || [];
    const audioResult = workflow.steps.voiceover?.result as { file_path?: string } | undefined;
    const audioFile = audioResult?.file_path;

    if (!audioFile || !fs.existsSync(audioFile)) {
      this.ctx.emitEvent(workflowId, 'log', {
        message: 'Voiceover audio not found — cannot assemble video',
        level: 'error',
      });
      return false;
    }

    const aspectRatio = workflow.aspect_ratio || '9:16';
    const resolution = aspectRatio === '9:16' ? '1080x1920' : '1920x1080';

    const outputDir = getOutputDir('assets/videos');
    const outputFilename = this.ctx.generateFilename(workflow.topic, workflow.createdBy, workflowId, '.mp4');

    const fullStory = workflow.full_story || scenes.map(s => s.text.trim()).join(' ');
    const normalizedStory = fullStory.replace(/\s+/g, ' ');
    const totalChars = normalizedStory.length;

    let runningCharOffset = 0;
    const sceneTimings = scenes.map((s, i) => {
      const sceneText = s.text.trim();
      const charLen = sceneText.length;
      const startTime = totalChars > 0 ? (runningCharOffset / totalChars) : (i / scenes.length);
      const duration = totalChars > 0 ? (charLen / totalChars) : (1 / scenes.length);
      runningCharOffset += charLen + (i < scenes.length - 1 ? 1 : 0);
      return { startTime, duration };
    });

    const sceneMediaList = scenes.map((s, i) => {
      const media = manualMedia.find(m => m.sceneIndex === i);
      if (media && media.mediaFilePath && fs.existsSync(media.mediaFilePath)) {
        return {
          file_path: media.mediaFilePath,
          text: s.text,
          is_video: media.mediaType === 'video',
          is_placeholder: false,
          start_time: sceneTimings[i].startTime,
          duration: sceneTimings[i].duration,
        };
      }
      return {
        file_path: '',
        text: s.text,
        is_video: false,
        is_placeholder: true,
        start_time: sceneTimings[i].startTime,
        duration: sceneTimings[i].duration,
      };
    });

    const uploadedCount = sceneMediaList.filter(s => !s.is_placeholder).length;

    if (uploadedCount === 0) {
      this.ctx.emitEvent(workflowId, 'log', {
        message: 'No media files uploaded — cannot assemble video',
        level: 'error',
      });
      return false;
    }

    this.ctx.updateStep(workflowId, 'video_assembly', 'running');
    this.ctx.emitEvent(workflowId, 'log', {
      message: `Assembling final video from ${uploadedCount}/${scenes.length} scene(s) with media (${aspectRatio})...`,
      level: 'info',
    });

    try {
      const videoResult = await runPythonScript<any>('ffmpeg_video.py', {
        action: 'manual_assembly',
        scenes: sceneMediaList,
        audio_path: audioFile,
        output_filename: outputFilename,
        resolution,
        add_subtitles: workflow.add_subtitles ?? true,
        full_script: fullStory,
      }, { timeout: 600000 });

      if (!videoResult.success) {
        throw new Error(videoResult.error || 'Manual assembly failed');
      }

      this.ctx.emitEvent(workflowId, 'log', {
        message: `Final video assembled: ${videoResult.filename}`,
        level: 'info',
      });

      // IMPORTANT: Mark video_assembly as completed BEFORE completeWorkflow
      // otherwise the step result is never persisted to the database
      this.ctx.updateStep(workflowId, 'video_assembly', 'completed', videoResult);

      const results: Partial<Record<WorkflowStep, unknown>> = {};
      results.video_assembly = videoResult;
      results.upload = { success: true, message: 'Upload skipped (manual story)', fallback: true } as unknown as UploadResult;
      this.ctx.updateStep(workflowId, 'upload', 'skipped');

      this.ctx.completeWorkflow(workflowId, results, videoResult.file_path);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.emitEvent(workflowId, 'log', {
        message: `Manual assembly failed: ${msg}`,
        level: 'error',
      });
      this.ctx.updateStep(workflowId, 'video_assembly', 'failed', { error: msg });
      return false;
    }
  }

  /**
   * Re-render a completed (or failed) workflow's video with a different aspect ratio.
   * Strategy 1: If manual_media exists, re-assemble from original audio + scene media.
   * Strategy 2: If original output video exists, re-encode it at the new resolution.
   */
  async reRenderVideo(workflowId: string, newAspectRatio: '9:16' | '16:9'): Promise<boolean> {
    const workflow = this.ctx.workflows.get(workflowId);
    if (!workflow) return false;
    if (workflow.status !== 'completed' && workflow.status !== 'failed') return false;

    const resolution = newAspectRatio === '9:16' ? '1080x1920' : '1920x1080';

    // Strategy 1: manual_media-based re-assembly (original scene files available in DB)
    const manualMedia = workflow.manual_media || [];
    const hasMediaOnDisk = manualMedia.length > 0 && manualMedia.some(m => m.mediaFilePath && fs.existsSync(m.mediaFilePath));

    if (hasMediaOnDisk) {
      return this.reRenderFromMedia(workflowId, newAspectRatio, resolution, manualMedia);
    }

    // Strategy 2: Scan filesystem for scene media files (manual_media not in DB but files on disk)
    const mediaDir = path.resolve(getOutputDir(), 'assets', 'manual_media', workflowId);
    if (fs.existsSync(mediaDir)) {
      const sceneFiles = fs.readdirSync(mediaDir)
        .filter(f => /^scene_(\d{4})\.(png|jpg|jpeg|mp4|mov|webm)$/i.test(f))
        .sort();
      if (sceneFiles.length > 0 && workflow.scenes && workflow.scenes.length > 0) {
        const reconstructedMedia: ManualMediaInfo[] = sceneFiles.map((f) => {
          const match = f.match(/^scene_(\d{4})\./);
          const sceneIndex = match ? parseInt(match[1], 10) : 0;
          const isVideo = /\.(mp4|mov|webm)$/i.test(f);
          return {
            sceneIndex,
            sceneText: workflow.scenes![sceneIndex]?.text || `Scene ${sceneIndex + 1}`,
            imagePrompt: '',
            mediaStatus: 'uploaded' as const,
            mediaType: isVideo ? 'video' as const : 'image' as const,
            mediaFilePath: path.join(mediaDir, f),
            mediaFileUrl: `/api/workflow/media-file/${workflowId}/${f}`,
          };
        });

        this.ctx.emitEvent(workflowId, 'log', {
          message: `Found ${sceneFiles.length} scene media files on disk — re-rendering from original media as ${newAspectRatio === '9:16' ? 'Portrait' : 'Landscape'}`,
          level: 'info',
        });

        return this.reRenderFromMedia(workflowId, newAspectRatio, resolution, reconstructedMedia);
      }
    }

    // Strategy 3: Try the step result (even if step status is 'running')
    const stepResult = workflow.steps.video_assembly?.result as { file_path?: string } | undefined;
    if (stepResult?.file_path && fs.existsSync(stepResult.file_path)) {
      return this.reEncodeExistingVideo(workflowId, stepResult.file_path, newAspectRatio, resolution);
    }

    // Strategy 4: Scan output directories for any video file matching this workflow
    const shortId = workflowId.slice(0, 6);
    const searchDirs = [getOutputDir('assets/videos'), getOutputDir('videos')];
    for (const dir of searchDirs) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => f.includes(shortId) && f.endsWith('.mp4'));
        if (files.length > 0) {
          return this.reEncodeExistingVideo(workflowId, path.join(dir, files[0]), newAspectRatio, resolution);
        }
      }
    }

    // Strategy 5: Check if the step result has a file_path even if it doesn't exist —
    // maybe the path is relative or was moved. Try common locations.
    if (stepResult?.file_path) {
      const basename = path.basename(stepResult.file_path);
      for (const dir of searchDirs) {
        const candidate = path.join(dir, basename);
        if (fs.existsSync(candidate)) {
          return this.reEncodeExistingVideo(workflowId, candidate, newAspectRatio, resolution);
        }
      }
    }

    this.ctx.emitEvent(workflowId, 'log', {
      message: `Re-render failed: No video file found on disk for workflow ${workflowId.slice(0, 8)}. The original video may have been cleaned up.`,
      level: 'error',
    });
    return false;
  }

  /** Re-render using original scene media (images/videos per scene) */
  private async reRenderFromMedia(
    workflowId: string,
    newAspectRatio: '9:16' | '16:9',
    resolution: string,
    manualMedia: ManualMediaInfo[]
  ): Promise<boolean> {
    const workflow = this.ctx.workflows.get(workflowId);
    if (!workflow) return false;

    const scenes = workflow.scenes || [];
    if (scenes.length === 0) {
      this.ctx.emitEvent(workflowId, 'log', { message: 'Re-render: No scenes found', level: 'error' });
      return false;
    }

    // Find the voiceover audio file
    let audioFile: string | undefined;
    const audioResult = workflow.steps.voiceover?.result as { file_path?: string } | undefined;

    // Log the DB-stored path for debugging
    this.ctx.emitEvent(workflowId, 'log', {
      message: `Audio DB path: ${audioResult?.file_path || 'none'} | exists: ${audioResult?.file_path ? fs.existsSync(audioResult.file_path) : false}`,
      level: 'info',
    });

    if (audioResult?.file_path && fs.existsSync(audioResult.file_path)) {
      const size = fs.statSync(audioResult.file_path).size;
      if (size > 1000) {
        audioFile = audioResult.file_path;
        this.ctx.emitEvent(workflowId, 'log', {
          message: `Using DB-stored audio: ${audioResult.file_path} (${(size / 1024).toFixed(1)} KB)`,
          level: 'info',
        });
      } else {
        this.ctx.emitEvent(workflowId, 'log', {
          message: `DB audio file too small (${size} bytes), scanning for real audio...`,
          level: 'warn',
        });
      }
    }

    // Fallback: scan audio directory for workflow-matching files
    if (!audioFile) {
      const audioDir = path.resolve(getOutputDir(), 'assets', 'audio');
      this.ctx.emitEvent(workflowId, 'log', {
        message: `Scanning audio dir: ${audioDir} (exists: ${fs.existsSync(audioDir)})`,
        level: 'info',
      });

      if (fs.existsSync(audioDir)) {
        const shortId = workflowId.slice(0, 8);
        const files = fs.readdirSync(audioDir);
        this.ctx.emitEvent(workflowId, 'log', {
          message: `Found ${files.length} audio file(s)`,
          level: 'info',
        });

        const matches = files.filter(f =>
          f.includes(shortId) && (f.endsWith('.wav') || f.endsWith('.mp3') || f.endsWith('.m4a'))
        );

        if (matches.length > 0) {
          audioFile = path.join(audioDir, matches[0]);
          this.ctx.emitEvent(workflowId, 'log', {
            message: `Found voiceover audio: ${matches[0]}`,
            level: 'info',
          });
        }
      }
    }

    if (!audioFile || !fs.existsSync(audioFile)) {
      this.ctx.emitEvent(workflowId, 'log', { message: 'Re-render: Voiceover audio not found on disk', level: 'error' });
      return false;
    }

    workflow.aspect_ratio = newAspectRatio;

    const fullStory = workflow.full_story || scenes.map(s => s.text.trim()).join(' ');
    const normalizedStory = fullStory.replace(/\s+/g, ' ');
    const totalChars = normalizedStory.length;

    let runningCharOffset = 0;
    const sceneTimings = scenes.map((s, i) => {
      const text = s.text.trim();
      const charLen = text.length;
      const startTime = totalChars > 0 ? (runningCharOffset / totalChars) : (i / scenes.length);
      const dur = totalChars > 0 ? (charLen / totalChars) : (1 / scenes.length);
      runningCharOffset += charLen + (i < scenes.length - 1 ? 1 : 0);
      return { startTime, duration: dur };
    });

    const sceneMediaList = scenes.map((s, i) => {
      const media = manualMedia.find(m => m.sceneIndex === i);
      if (media && media.mediaFilePath && fs.existsSync(media.mediaFilePath)) {
        return {
          file_path: media.mediaFilePath,
          text: s.text,
          is_video: media.mediaType === 'video',
          is_placeholder: false,
          start_time: sceneTimings[i].startTime,
          duration: sceneTimings[i].duration,
        };
      }
      return {
        file_path: '',
        text: s.text,
        is_video: false,
        is_placeholder: true,
        start_time: sceneTimings[i].startTime,
        duration: sceneTimings[i].duration,
      };
    });

    const outputDir = getOutputDir('assets/videos');
    const outputFilename = this.ctx.generateFilename(workflow.topic, workflow.createdBy, workflowId, '.mp4');

    this.ctx.emitEvent(workflowId, 'log', {
      message: `Re-rendering (media) as ${newAspectRatio === '9:16' ? 'Portrait' : 'Landscape'} (${resolution})...`,
      level: 'info',
    });

    try {
      const videoResult = await runPythonScript<any>('ffmpeg_video.py', {
        action: 'manual_assembly',
        scenes: sceneMediaList,
        audio_path: audioFile,
        output_filename: outputFilename,
        resolution,
        add_subtitles: workflow.add_subtitles ?? true,
        full_script: fullStory,
      }, { timeout: 600000 });

      if (!videoResult.success) {
        throw new Error(videoResult.error || 'Re-render assembly failed');
      }

      this.ctx.emitEvent(workflowId, 'log', {
        message: `✅ Re-rendered as ${newAspectRatio === '9:16' ? 'Portrait' : 'Landscape'}: ${videoResult.filename}`,
        level: 'info',
      });

      workflow.steps.video_assembly = {
        status: 'completed',
        startedAt: workflow.steps.video_assembly?.startedAt,
        completedAt: new Date().toISOString(),
        result: videoResult,
      };
      workflow.progress = 100;
      workflow.status = 'completed';
      workflow.updatedAt = new Date().toISOString();
      this.ctx.workflows.set(workflowId, workflow);
      this.ctx.db.updateWorkflow(workflow);

      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.emitEvent(workflowId, 'log', { message: `Re-render failed: ${msg}`, level: 'error' });
      return false;
    }
  }

  /** Re-encode existing video at new resolution (letterbox/pillarbox) */
  private async reEncodeExistingVideo(
    workflowId: string,
    sourceVideoPath: string,
    newAspectRatio: '9:16' | '16:9',
    resolution: string
  ): Promise<boolean> {
    const workflow = this.ctx.workflows.get(workflowId);
    if (!workflow) return false;

    const outputFilename = this.ctx.generateFilename(workflow.topic, workflow.createdBy, workflowId, '.mp4');

    this.ctx.emitEvent(workflowId, 'log', {
      message: `Re-encoding video as ${newAspectRatio === '9:16' ? 'Portrait' : 'Landscape'} (${resolution})...`,
      level: 'info',
    });

    try {
      const videoResult = await runPythonScript<any>('ffmpeg_video.py', {
        action: 'reencode',
        source_video_path: sourceVideoPath,
        output_filename: outputFilename,
        resolution,
      }, { timeout: 300000 });

      if (!videoResult.success) {
        throw new Error(videoResult.error || 'Re-encode failed');
      }

      this.ctx.emitEvent(workflowId, 'log', {
        message: `✅ Re-encoded as ${newAspectRatio === '9:16' ? 'Portrait' : 'Landscape'}: ${outputFilename}`,
        level: 'info',
      });

      workflow.aspect_ratio = newAspectRatio;
      workflow.steps.video_assembly = {
        status: 'completed',
        startedAt: workflow.steps.video_assembly?.startedAt,
        completedAt: new Date().toISOString(),
        result: videoResult,
      };
      workflow.progress = 100;
      workflow.status = 'completed';
      workflow.updatedAt = new Date().toISOString();
      this.ctx.workflows.set(workflowId, workflow);
      this.ctx.db.updateWorkflow(workflow);

      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.emitEvent(workflowId, 'log', { message: `Re-encode failed: ${msg}`, level: 'error' });
      return false;
    }
  }
}
