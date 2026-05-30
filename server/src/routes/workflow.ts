/**
 * Workflow Routes
 * REST API endpoints for the YouTube automation pipeline.
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { WorkflowOrchestrator } from '../services/workflowOrchestrator';
import { PipelineRequest, ApiResponse, WorkflowStep } from '../types';
import { getOutputDir } from '../services/pythonRunner';
import { getDatabase } from '../services/database';

export function createWorkflowRoutes(orchestrator: WorkflowOrchestrator): Router {
  const router = Router();

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

  return router;
}
