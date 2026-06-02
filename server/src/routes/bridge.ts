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
import { GeminiBridge } from '../services/geminiBridge';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export function createBridgeRoutes(bridge: GeminiBridge): Router {
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

  router.post('/result', (req, res, next) => {
    upload.single('imageBlob')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: 'File too large (max 50MB)' });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      next();
    });
  }, (req: Request, res: Response) => {
    const { workflowId, sceneIndex } = req.body;
    if (!workflowId || !req.file || sceneIndex === undefined || sceneIndex === null || sceneIndex === '' || Number.isNaN(parseInt(sceneIndex, 10))) {
      res.status(400).json({ error: 'workflowId, sceneIndex, and imageBlob required' });
      return;
    }
    bridge.postResult(workflowId, parseInt(sceneIndex, 10), req.file.buffer);
    res.json({ ok: true });
  });

  router.post('/enqueue', (req: Request, res: Response) => {
    const { workflowId, prompts } = req.body;
    if (!workflowId || !Array.isArray(prompts)) {
      res.status(400).json({ error: 'workflowId and prompts[] required' });
      return;
    }
    bridge.enqueuePrompts(workflowId, prompts);
    res.json({ ok: true, count: prompts.length });
  });

  router.get('/await-images', async (req: Request, res: Response) => {
    const workflowId = (req.query.workflowId as string) || '';
    const expected = parseInt((req.query.expected as string) || '0', 10);
    const timeoutMs = parseInt((req.query.timeoutMs as string) || '600000', 10);
    if (!workflowId || !Number.isFinite(expected) || expected <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      res.status(400).json({ error: 'workflowId, expected (>0), and timeoutMs (>0) required' });
      return;
    }
    try {
      const images = await bridge.awaitImages(workflowId, expected, timeoutMs);
      const out: Array<{ sceneIndex: number; base64: string }> = [];
      images.forEach((buffer, sceneIndex) => {
        out.push({ sceneIndex, base64: buffer.toString('base64') });
      });
      res.json({ ok: true, images: out });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(504).json({ ok: false, error: msg });
    }
  });

  return router;
}
