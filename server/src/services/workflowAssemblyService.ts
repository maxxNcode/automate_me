import { OrchestratorContext } from './workflowContext';
import { runPythonScript, getOutputDir, findPython } from './pythonRunner';
import {
  WorkflowState,
  WorkflowStep,
  StepStatus,
  PipelineRequest,
  VideoRequest,
  VideoResult,
  UploadRequest,
  UploadResult,
  WsEvent,
} from '../types';
import fs from 'fs';
import path from 'path';

export class WorkflowAssemblyService {
  constructor(private ctx: OrchestratorContext) {}

  async renderWithGeminiStory(
    workflowId: string,
    scenes: Array<{ text: string; searchTerms: string[] }>,
    audioPath: string,
    request: any,
    results: Partial<Record<WorkflowStep, unknown>>
  ): Promise<void> {
    this.ctx.updateStep(workflowId, 'thumbnail', 'skipped');
    this.ctx.updateStep(workflowId, 'video_assembly', 'running');

    const outputDir = getOutputDir('assets/videos');
    const outputFilename = this.ctx.generateFilename(request.topic, request.username, workflowId, '.mp4');
    const outputPath = path.join(outputDir, outputFilename);

    const workflow = this.ctx.workflows.get(workflowId);
    const masterJson = workflow?.stickman_master_json || workflow?.gemini_master_json;

    let scenePrompts: Array<{ sceneIndex: number; prompt: string; durationSeconds: number }> = [];

    if (masterJson) {
      try {
        const cleanJson = masterJson
          .replace(/```json\s*/gi, '')
          .replace(/```\s*$/gm, '')
          .trim();
        const parsed = JSON.parse(cleanJson);
        const scriptPipeline = parsed.script_pipeline || [];
        scenePrompts = scriptPipeline.map((s: any, i: number) => ({
          sceneIndex: i,
          prompt: s.image_prompt || s.sd_api_payload?.prompt || s.narration_text || s.text || '',
          durationSeconds: s.duration_seconds || 6,
        })).filter((s: any) => s.prompt);
      } catch (e) {
        this.ctx.emitEvent(workflowId, 'log', { message: `Failed to parse gemini master JSON: ${e}`, level: 'warn' });
      }
    }

    if (scenePrompts.length === 0) {
      const aiScenes = (workflow?.scenes || scenes || []).map((s: any, i: number) => ({
        sceneIndex: i,
        prompt: s.image_prompt || s.sd_api_payload?.prompt ||
          `Use the same stickman character as before. Simple black stickman with round head, ${(s.text || s.narration_text || '').substring(0, 100)}. Clean minimal background, white or simple solid color.`,
        durationSeconds: Math.max((s.text || '').split(' ').length / 3, 6),
      }));
      scenePrompts = aiScenes;
    }

    if (scenePrompts.length === 0) {
      this.ctx.emitEvent(workflowId, 'log', { message: 'No scenes to render — empty pipeline', level: 'warn' });
      const outputDir2 = getOutputDir('assets/videos');
      const outputFilename2 = path.basename(outputPath);
      const fallbackScenes = this.ctx.workflows.get(workflowId)?.scenes || [];
      await this.fallbackGradientVideo(workflowId, fallbackScenes as any, audioPath, outputFilename2, request.topic, results);
      return;
    }

    this.ctx.emitEvent(workflowId, 'log', { message: `🎨 Generating ${scenePrompts.length} scene(s) via Gemini bridge...` });

    this.ctx.emitBridgeStatus(workflowId, 'initializing', 'Initializing Gemini bridge...');

    try {
      const geminiResult = await runPythonScript<{
        success: boolean;
        partial?: boolean;
        file_path: string;
        filename: string;
        duration_seconds: number;
        file_size_bytes: number;
        resolution: string;
        fps: number;
        subtitles: boolean;
        fallback: boolean;
        error?: string;
        scenes_dir?: string;
        images_saved?: number;
        images_expected?: number;
      }>('gemini_story.py', {
        workflowId,
        scenes: scenePrompts,
        audio_path: audioPath,
        output_filename: outputPath,
        resolution: '768x432',
        fps: 10,
      }, { timeout: 1800000 });

      if (geminiResult.success && !geminiResult.partial) {
        this.ctx.emitEvent(workflowId, 'log', {
          message: `Gemini story complete: ${geminiResult.filename} (${(geminiResult.file_size_bytes / 1024 / 1024).toFixed(1)}MB, ${geminiResult.duration_seconds.toFixed(1)}s)`,
          level: 'info',
        });

        const videoResult: VideoResult = {
          success: true,
          file_path: geminiResult.file_path,
          filename: geminiResult.filename,
          duration_seconds: geminiResult.duration_seconds,
          file_size_bytes: geminiResult.file_size_bytes,
          resolution: geminiResult.resolution,
          fps: geminiResult.fps,
          subtitles: geminiResult.subtitles,
          fallback: geminiResult.fallback,
        };

        results.video_assembly = videoResult;
        this.ctx.updateStep(workflowId, 'video_assembly', 'completed', videoResult);

        if (geminiResult.scenes_dir && workflow) {
          workflow.gemini_scenes_dir = geminiResult.scenes_dir;
        }

        results.upload = { success: true, message: 'Upload skipped (gemini story)', fallback: true } as unknown as UploadResult;
        this.ctx.updateStep(workflowId, 'upload', 'skipped');

        this.ctx.emitBridgeStatus(workflowId, 'complete', 'All scenes rendered');
        this.ctx.completeWorkflow(workflowId, results, geminiResult.file_path);
        return;
      }

      const savedCount = geminiResult.images_saved || 0;
      const expectedCount = geminiResult.images_expected || scenePrompts.length;

      this.ctx.emitEvent(workflowId, 'log', {
        message: `Got ${savedCount}/${expectedCount} Gemini images — saving and pausing for manual upload.`,
        level: 'info',
      });

      if (geminiResult.scenes_dir && workflow) {
        workflow.gemini_scenes_dir = geminiResult.scenes_dir;

        const sceneImages = scenePrompts.map((sp: { sceneIndex: number; prompt: string }) => ({
          sceneIndex: sp.sceneIndex,
          text: sp.prompt,
          status: (fs.existsSync(path.join(geminiResult.scenes_dir!, `scene_${String(sp.sceneIndex).padStart(4, '0')}.png`))
            ? 'generated' : 'missing') as 'generated' | 'missing',
          filePath: fs.existsSync(path.join(geminiResult.scenes_dir!, `scene_${String(sp.sceneIndex).padStart(4, '0')}.png`))
            ? path.join(geminiResult.scenes_dir!, `scene_${String(sp.sceneIndex).padStart(4, '0')}.png`)
            : undefined,
        }));
        workflow.scene_images = sceneImages;
        this.ctx.db.updateWorkflow(workflow);

        workflow.status = 'awaiting_images';
        workflow.updatedAt = new Date().toISOString();
        this.ctx.workflows.set(workflowId, workflow);
        this.ctx.db.updateWorkflow(workflow);

        this.ctx.emitEvent(workflowId, 'log', {
          message: `Images saved to ${geminiResult.scenes_dir}. Upload missing scenes in the UI and click "Continue to Video" to proceed.`,
          level: 'info',
        });

        this.ctx.emitBridgeStatus(workflowId, 'complete', `Saved ${savedCount}/${expectedCount} images — awaiting manual upload`);
        this.ctx.emitEvent(workflowId, 'images_ready', {
          scenes_dir: geminiResult.scenes_dir,
          scene_images: sceneImages,
        } as unknown as Record<string, unknown>);

        this.ctx.updateStep(workflowId, 'video_assembly', 'pending');
      } else {
        throw new Error('Partial results but no scenes_dir — images may be lost');
      }

      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.ctx.emitEvent(workflowId, 'log', { message: `Gemini rendering failed: ${msg}`, level: 'warn' });
      this.ctx.emitBridgeStatus(workflowId, 'failed', msg);
      const fallbackScenes = this.ctx.workflows.get(workflowId)?.scenes || [];
      const outputFilename2 = path.basename(outputPath);
      await this.fallbackGradientVideo(workflowId, fallbackScenes as any, audioPath, outputFilename2, request.topic, results);
    }
  }

  async renderWithSidecar(
    workflowId: string,
    scenes: Array<{ text: string; searchTerms: string[] }>,
    audioPath: string,
    request: any,
    results: Partial<Record<WorkflowStep, unknown>>
  ): Promise<void> {
    const { ShortVideoMaker } = require('./shortVideoMaker');
    const sidecar = new ShortVideoMaker();

    this.ctx.updateStep(workflowId, 'thumbnail', 'skipped');
    this.ctx.updateStep(workflowId, 'video_assembly', 'running');
    this.ctx.emitEvent(workflowId, 'log', { message: 'Sending scenes to sidecar for rendering...' });

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

    const isLandscape = request.aspect_ratio === '16:9';
    const config: any = {
      music: musicMap[request.tone || 'educational'],
      captionPosition: captionPosMap[request.thumbnail_style || 'eye-catching'],
      orientation: isLandscape ? 'landscape' : 'portrait',
      musicVolume: 'medium',
    };

    let videoId: string;
    try {
      videoId = await sidecar.createVideo(scenes, config);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Sidecar unavailable';
      this.ctx.updateStep(workflowId, 'voiceover', 'failed', { error: msg });
      this.ctx.updateStep(workflowId, 'video_assembly', 'failed', { error: msg });
      throw new Error(msg);
    }

    this.ctx.emitEvent(workflowId, 'log', { message: `Sidecar video ID: ${videoId}` });

    let status: string = 'processing';
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 3000));
      status = await sidecar.getStatus(videoId);
      this.ctx.emitEvent(workflowId, 'log', { message: `Render status: ${status}` });
      if (status === 'ready' || status === 'error') break;
    }

    if (status !== 'ready') {
      this.ctx.updateStep(workflowId, 'video_assembly', 'failed', { error: 'Render timed out' });
      throw new Error('Sidecar render did not complete in time');
    }

    const outputDir = getOutputDir('assets/videos');
    const outputFilename = `short_${workflowId.slice(0, 8)}.mp4`;
    const outputPath = path.join(outputDir, outputFilename);

    const videoBuffer = await sidecar.downloadVideo(videoId);
    fs.writeFileSync(outputPath, Buffer.from(videoBuffer));

    sidecar.deleteVideo(videoId).catch(() => {});

    const outResolution = isLandscape ? '1920x1080' : '1080x1920';
    const videoResult: VideoResult = {
      success: true,
      file_path: outputPath,
      filename: outputFilename,
      duration_seconds: 0,
      file_size_bytes: videoBuffer.byteLength,
      resolution: outResolution,
      fps: 30,
      subtitles: true,
      fallback: false,
    };

    results.video_assembly = videoResult;
    this.ctx.updateStep(workflowId, 'video_assembly', 'completed', videoResult);

    results.upload = { success: true, message: 'Upload skipped (auto_upload not supported for short style)', fallback: true } as unknown as UploadResult;
    this.ctx.updateStep(workflowId, 'upload', 'skipped');

    this.ctx.completeWorkflow(workflowId, results, outputPath);
  }

  async renderWithYouTubeClips(
    workflowId: string,
    scenes: Array<{ text: string; searchTerms: string[] }>,
    audioPath: string,
    request: any,
    results: Partial<Record<WorkflowStep, unknown>>
  ): Promise<void> {
    this.ctx.updateStep(workflowId, 'thumbnail', 'skipped');
    this.ctx.updateStep(workflowId, 'video_assembly', 'running');

    const clipDir = getOutputDir('assets/videos/clips');
    let clipPaths: string[] = [];
    let footageResult: {
      success: boolean;
      failed_count: number;
      clips: { success: boolean; file_path?: string; actual_duration?: number; scene_index?: number; [key: string]: unknown }[];
      successful_clips: { file_path: string; actual_duration?: number; scene_index?: number; [key: string]: unknown }[];
      fallback: boolean;
    } | null = null;
    try {
      footageResult = await runPythonScript<{
        success: boolean;
        failed_count: number;
        clips: { success: boolean; file_path?: string; actual_duration?: number; scene_index?: number; [key: string]: unknown }[];
        successful_clips: { file_path: string; actual_duration?: number; scene_index?: number; [key: string]: unknown }[];
        fallback: boolean;
      }>('youtube_footage.py', {
        scenes: scenes.map(s => ({ text: s.text, search_terms: s.searchTerms })),
        output_dir: clipDir,
        clip_duration: 12,
      }, { timeout: 300000 });

      if (footageResult.success && footageResult.successful_clips?.length > 0) {
        clipPaths = footageResult.successful_clips.map(c => c.file_path);
        this.ctx.emitEvent(workflowId, 'log', {
          message: `Downloaded ${clipPaths.length}/${scenes.length} gameplay clips successfully`,
          level: 'info',
        });

        const textOverlayCount = (footageResult as any).text_overlay_flagged || 0;
        if (textOverlayCount > 0) {
          this.ctx.emitEvent(workflowId, 'log', {
            message: `⚠ ${textOverlayCount} clip(s) have suspected text overlays — placed last in assembly`,
            level: 'warn',
          });
        }

        for (const clip of footageResult.successful_clips) {
          const textRisk = (clip as any).text_overlay_risk;
          const label = textRisk ? '⚠' : '✓';
          this.ctx.emitEvent(workflowId, 'log', {
            message: `  ${label} ${path.basename(clip.file_path)} (${(clip.actual_duration || 0).toFixed(1)}s)`,
            level: textRisk ? 'warn' : 'info',
          });
        }
      } else {
        this.ctx.emitEvent(workflowId, 'log', {
          message: 'YouTube footage download failed — falling back to static background',
          level: 'warn',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'YouTube footage error';
      this.ctx.emitEvent(workflowId, 'log', {
        message: `YouTube footage download failed: ${msg}`,
        level: 'warn',
      });
    }

    const outputDir = getOutputDir('assets/videos');
    const outputFilename = this.ctx.generateFilename(request.topic, request.username, workflowId, '.mp4');
    const outputPath = path.join(outputDir, outputFilename);

    if (clipPaths.length > 0) {
      this.ctx.emitEvent(workflowId, 'log', { message: `Assembling video from ${clipPaths.length} gameplay clips with text overlays...` });

      let clipsForAssembly: { file_path: string; text: string }[];
      if (footageResult && footageResult.failed_count > 0) {
        const clipByIndex = new Map<number, string>();
        for (const clip of footageResult.successful_clips) {
          const si = clip.scene_index as number | undefined;
          if (si !== undefined) {
            clipByIndex.set(si - 1, clip.file_path);
          }
        }
        clipsForAssembly = [];
        let lastGoodPath = clipPaths[0] || '';
        for (let i = 0; i < scenes.length; i++) {
          const fp = clipByIndex.get(i) || lastGoodPath;
          if (fp) lastGoodPath = fp;
          clipsForAssembly.push({ file_path: fp || clipPaths[0] || '', text: scenes[i].text });
        }
        this.ctx.emitEvent(workflowId, 'log', {
          message: `${footageResult.failed_count} scene(s) had no matching clip — reused previous clip as fallback`,
          level: 'warn',
        });
      } else {
        clipsForAssembly = scenes.map((s, i) => ({
          file_path: clipPaths[i] || clipPaths[clipPaths.length - 1] || '',
          text: s.text,
        }));
      }

      const clipAspectRatio = request.aspect_ratio || '9:16';
      const clipResolution = clipAspectRatio === '16:9' ? '1920x1080' : '1080x1920';
      try {
        const videoResult = await runPythonScript<VideoResult>('ffmpeg_video.py', {
          action: 'scene_assembly',
          clips: clipsForAssembly,
          audio_path: audioPath,
          output_filename: outputFilename,
          resolution: clipResolution,
          crop_position: request.crop_position || 'fit',
          caption_position: request.caption_position || 'bottom',
          caption_background_color: request.caption_background_color || 'black',
        }, { timeout: 300000 });

        if (videoResult.success) {
          results.video_assembly = videoResult;
          this.ctx.updateStep(workflowId, 'video_assembly', 'completed', videoResult);

          results.upload = { success: true, message: 'Upload skipped (auto_upload not supported for short style)', fallback: true } as unknown as UploadResult;
          this.ctx.updateStep(workflowId, 'upload', 'skipped');

          this.ctx.completeWorkflow(workflowId, results, videoResult.file_path);
          return;
        } else {
          this.ctx.emitEvent(workflowId, 'log', { message: `Scene assembly failed: ${videoResult.error || 'Unknown error'}`, level: 'warn' });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Scene assembly error';
        this.ctx.emitEvent(workflowId, 'log', { message: `Scene assembly error: ${msg}`, level: 'warn' });
      }
    }

    this.ctx.emitEvent(workflowId, 'log', { message: 'Generating fallback video (audio + gradient background)...' });

    const fallbackResolution = request.aspect_ratio === '16:9' ? '1920x1080' : '1080x1920';
    const fallbackResult = await runPythonScript<VideoResult>('ffmpeg_video.py', {
      action: 'assemble',
      script: scenes.map(s => s.text).join('. '),
      audio_path: audioPath,
      output_filename: outputFilename,
      video_title: request.topic,
      add_subtitles: true,
      resolution: fallbackResolution,
    }, { timeout: 120000 });

    results.video_assembly = fallbackResult;
    this.ctx.updateStep(workflowId, 'video_assembly', 'completed', fallbackResult);

    results.upload = { success: true, message: 'Upload skipped (auto_upload not supported for short style)', fallback: true } as unknown as UploadResult;
    this.ctx.updateStep(workflowId, 'upload', 'skipped');

    this.ctx.completeWorkflow(workflowId, results, fallbackResult.file_path || outputPath);
  }

  async assembleVideo(
    workflowId: string,
    script: string,
    audioPath: string,
    thumbnailPath: string | undefined,
    title: string,
    addSubtitles?: boolean,
    username?: string
  ): Promise<VideoResult> {
    const outputFilename = this.ctx.generateFilename(title, username, workflowId, '.mp4');

    this.ctx.emitEvent(workflowId, 'log', { message: `Assembling video: ${outputFilename}` });
    this.ctx.emitEvent(workflowId, 'log', { message: `Running ffmpeg_video.py with subtitles=${addSubtitles || false}` });

    const input: VideoRequest = {
      script,
      audio_path: audioPath,
      thumbnail_path: thumbnailPath,
      add_subtitles: addSubtitles || false,
      title,
    };

    try {
      const result = await runPythonScript<VideoResult>('ffmpeg_video.py', input as unknown as Record<string, unknown>);
      this.ctx.emitEvent(workflowId, 'log', { message: `Video assembly complete: ${result.file_path} (${(result.file_size_bytes / 1024 / 1024).toFixed(1)}MB)` });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.ctx.emitEvent(workflowId, 'log', { message: `Video assembly failed: ${msg}`, level: 'error' });
      this.ctx.emitEvent(workflowId, 'log', { message: 'Returning empty video result', level: 'warn' });
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

  async uploadVideo(
    workflowId: string,
    videoPath: string,
    title: string,
    privacyStatus?: 'public' | 'private' | 'unlisted',
    thumbnailPath?: string
  ): Promise<UploadResult> {
    this.ctx.emitEvent(workflowId, 'log', { message: `Uploading video to YouTube: "${title}"` });
    this.ctx.emitEvent(workflowId, 'log', { message: `Privacy: ${privacyStatus || 'unlisted'}, thumbnail: ${thumbnailPath ? 'yes' : 'no'}` });

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
      this.ctx.emitEvent(workflowId, 'log', { message: `Upload successful! Video ID: ${result.video_id || 'unknown'}` });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.ctx.emitEvent(workflowId, 'log', { message: `Upload failed: ${msg}`, level: 'error' });
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

  private async fallbackGradientVideo(
    workflowId: string,
    scenes: Array<{ text: string; searchTerms: string[] }>,
    audioPath: string,
    outputFilename: string,
    topic: string,
    results: Partial<Record<WorkflowStep, unknown>>
  ): Promise<void> {
    const outputDir = getOutputDir('assets/videos');
    const outputPath = path.join(outputDir, outputFilename);

    this.ctx.emitEvent(workflowId, 'log', { message: 'Falling back to gradient background video...' });

    try {
      const fallbackResult = await runPythonScript<VideoResult>('ffmpeg_video.py', {
        action: 'assemble',
        script: scenes.map(s => s.text).join('. '),
        audio_path: audioPath,
        output_filename: outputFilename,
        video_title: topic,
        add_subtitles: true,
        resolution: '768x432',
      }, { timeout: 120000 });

      results.video_assembly = fallbackResult;
      this.ctx.updateStep(workflowId, 'video_assembly', 'completed', fallbackResult);

      results.upload = { success: true, message: 'Upload skipped (gemini story fallback)', fallback: true } as unknown as UploadResult;
      this.ctx.updateStep(workflowId, 'upload', 'skipped');

      this.ctx.completeWorkflow(workflowId, results, fallbackResult.file_path || outputPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Fallback error';
      throw new Error(`Gemini story and fallback both failed: ${msg}`);
    }
  }
}
