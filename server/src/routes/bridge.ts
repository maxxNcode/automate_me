/**
 * Gemini Bridge HTTP routes.
 *
 * Exposes 5 endpoints:
 *   GET  /gemini-bridge/ping            — extension pings with readiness
 *   GET  /gemini-bridge/poll            — long-poll for next job
 *   POST /gemini-bridge/result          — extension returns image bytes
 *   POST /gemini-bridge/enqueue         — Python enqueues prompts
 *   GET  /gemini-bridge/await-images    — Python waits for all images
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { GeminiBridge, BridgeStatus } from '../services/geminiBridge';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export interface BridgeStatusUpdate {
  workflowId: string;
  status: BridgeStatus | 'timeout';
  message: string;
  progress?: { received: number; total: number };
}

export function createBridgeRoutes(
  bridge: GeminiBridge,
  onStatus: (update: BridgeStatusUpdate) => void
): Router {
  const router = Router();

  router.get('/ping', (req: Request, res: Response) => {
    const ready = req.query.ready === 'true';
    const reason = req.query.reason as string | undefined;
    bridge.recordPing(ready, reason);
    res.json({ ok: true });
  });

  router.get('/poll', (req: Request, res: Response) => {
    const workflowId = (req.query.workflowId as string) || '';
    if (!workflowId) {
      res.status(400).json({ error: 'workflowId required' });
      return;
    }
    const result = bridge.poll(workflowId);
    res.json(result);
  });

  router.post('/result', upload.single('imageBlob'), (req: Request, res: Response) => {
    const { workflowId, sceneIndex } = req.body;
    if (!workflowId || !req.file) {
      res.status(400).json({ error: 'workflowId and imageBlob required' });
      return;
    }
    const idx = parseInt(sceneIndex, 10);
    bridge.postResult(workflowId, idx, req.file.buffer);
    const progress = bridge.getProgress(workflowId);
    onStatus({
      workflowId,
      status: 'active',
      message: `Received scene ${idx + 1}${progress ? ` (${progress.received}/${progress.total})` : ''}`,
      progress: progress ?? undefined,
    });
    res.json({ ok: true });
  });

  router.post('/enqueue', (req: Request, res: Response) => {
    const { workflowId, prompts } = req.body;
    if (!workflowId || !Array.isArray(prompts)) {
      res.status(400).json({ error: 'workflowId and prompts[] required' });
      return;
    }
    bridge.enqueuePrompts(workflowId, prompts);
    onStatus({
      workflowId,
      status: 'ready',
      message: `Queued ${prompts.length} scene${prompts.length === 1 ? '' : 's'} for Gemini`,
      progress: { received: 0, total: prompts.length },
    });
    res.json({ ok: true, count: prompts.length });
  });

  router.get('/await-images', async (req: Request, res: Response) => {
    const workflowId = (req.query.workflowId as string) || '';
    const expected = parseInt((req.query.expected as string) || '0', 10);
    const timeoutMs = parseInt((req.query.timeoutMs as string) || '600000', 10);
    if (!workflowId || !expected) {
      res.status(400).json({ error: 'workflowId and expected required' });
      return;
    }
    try {
      const { images, partial } = await bridge.awaitImages(workflowId, expected, timeoutMs);
      const count = images.size;
      if (partial) {
        onStatus({
          workflowId,
          status: 'timeout',
          message: `Timeout — received ${count}/${expected} images, proceeding with partial results`,
          progress: { received: count, total: expected },
        });
      } else {
        onStatus({
          workflowId,
          status: 'complete',
          message: `All ${count} images received`,
          progress: { received: count, total: expected },
        });
      }
      const out: Array<{ sceneIndex: number; base64: string }> = [];
      images.forEach((buffer, sceneIndex) => {
        out.push({ sceneIndex, base64: buffer.toString('base64') });
      });
      res.json({ ok: true, images: out, partial });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onStatus({
        workflowId,
        status: 'failed',
        message: msg,
      });
      res.status(504).json({ ok: false, error: msg });
    }
  });

  return router;
}
