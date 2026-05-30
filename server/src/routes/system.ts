/**
 * System Routes
 * Health check, configuration status, and utility endpoints.
 */

import { Router, Request, Response } from 'express';
import { checkPythonAvailable, runPythonScript } from '../services/pythonRunner';
import { ApiResponse } from '../types';
import { ShortVideoMaker } from '../services/shortVideoMaker';
import { checkAiProviders, ALL_MODELS, modelConfigKey, isModelFailed, AiModelConfig } from '../services/aiProvider';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

export function createSystemRoutes(): Router {
  const router = Router();

  /**
   * GET /api/system/health
   * Basic health check endpoint.
   */
  router.get('/health', (_req: Request, res: Response) => {
    const response: ApiResponse = {
      success: true,
      data: {
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };
    return res.json(response);
  });

  /**
   * GET /api/system/status
   * Check the status of all external tools and dependencies.
   */
  router.get('/status', async (_req: Request, res: Response) => {
    const pythonAvailable = await checkPythonAvailable();
    const ffmpegAvailable = await checkCommand('ffmpeg');
    const sidecar = new ShortVideoMaker();
    const sidecarAvailable = await sidecar.healthCheck();

    let edgeTtsStatus = pythonAvailable ? 'ready' : 'unavailable';
    let sdStatus = 'unavailable';
    let youtubeStatus = 'unavailable';

    const pythonScriptsDir = path.resolve(__dirname, '..', '..', '..', 'python');
    const outputDir = path.resolve(__dirname, '..', '..', '..', 'output');

    // Check AI provider status (Groq + OpenRouter)
    const aiProviderStatus = await checkAiProviders();

    const response: ApiResponse = {
      success: true,
      data: {
        python: {
          available: pythonAvailable,
          scripts: readDirSafe(pythonScriptsDir).filter(f => f.endsWith('.py')).length,
        },
        ffmpeg: {
          available: ffmpegAvailable,
        },
        shortVideoMaker: {
          available: sidecarAvailable,
          status: sidecarAvailable ? 'ready' : 'unavailable',
        },
        output: {
          path: outputDir,
          exists: fs.existsSync(outputDir),
          size_mb: getDirSizeSync(outputDir),
        },
        aiProviders: {
          groq: {
            configured: aiProviderStatus.groq.configured,
            available: aiProviderStatus.groq.available,
            models: aiProviderStatus.groq.models,
          },
          openrouter: {
            configured: aiProviderStatus.openrouter.configured,
            available: aiProviderStatus.openrouter.available,
            models: aiProviderStatus.openrouter.models,
          },
        },
        tools: {
          ai_provider: {
            status: aiProviderStatus.groq.available || aiProviderStatus.openrouter.available
              ? 'ready'
              : aiProviderStatus.groq.configured || aiProviderStatus.openrouter.configured
                ? 'partial'
                : 'unconfigured',
          },
          edge_tts: { status: edgeTtsStatus },
          stable_diffusion: { status: sdStatus },
          youtube_upload: { status: youtubeStatus },
          n8n: { status: 'optional' },
        },
      },
    };
    return res.json(response);
  });

  /**
   * GET /api/system/config
   * Get configuration template info.
   */
  router.get('/config', (_req: Request, res: Response) => {
    const configDir = path.resolve(__dirname, '..', '..', '..', 'config');

    const response: ApiResponse = {
      success: true,
      data: {
        config_directory: configDir,
        client_secret_exists: fs.existsSync(path.join(configDir, 'client_secret.json')),
        token_exists: fs.existsSync(path.join(configDir, 'token.pickle')),
        env_file_exists: fs.existsSync(path.resolve(__dirname, '..', '..', '..', '.env')),
        setup_instructions: {
          youtube_upload: [
            '1. Go to https://console.cloud.google.com/',
            '2. Create a new project or select existing',
            '3. Enable YouTube Data API v3',
            '4. Create OAuth 2.0 credentials (Desktop app)',
            '5. Download client_secret.json and save to config/',
          ],
          gpt4all: [
            '1. Install GPT4All: pip install gpt4all',
            '2. The model will auto-download on first use',
          ],
          edge_tts: [
            '1. Install Edge TTS: pip install edge-tts',
            '2. No models needed — uses Microsoft Edge free cloud TTS',
          ],
        },
      },
    };
    return res.json(response);
  });

  /**
   * GET /api/system/models
   * List all available AI models with their configuration status.
   */
  router.get('/models', (_req: Request, res: Response) => {
    const models = ALL_MODELS.map((m: AiModelConfig) => ({
      key: modelConfigKey(m),
      provider: m.provider,
      modelId: m.modelId,
      displayName: m.displayName,
      configured: !!process.env[m.apiKeyEnv],
      failed: isModelFailed(m),
    }));

    const response: ApiResponse = {
      success: true,
      data: models,
    };
    return res.json(response);
  });

  /**
   * GET /api/system/logs/:workflowId
   * Get logs for a specific workflow.
   */
  router.get('/logs/:workflowId', (req: Request, res: Response) => {
    const logsDir = path.resolve(__dirname, '..', '..', '..', 'output', 'logs');
    const logFile = path.join(logsDir, `${req.params.workflowId}.log`);

    if (!fs.existsSync(logFile)) {
      return res.json({
        success: true,
        data: { logs: [], workflow_id: req.params.workflowId },
      });
    }

    const logs = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
    return res.json({
      success: true,
      data: { logs, workflow_id: req.params.workflowId },
    });
  });

  /**
   * Engine API — compatible with launcher mode.
   * In dev mode (backend running standalone), engine is always "running".
   * In launcher mode, the launcher overrides these routes.
   */
  router.get('/engine/status', (_req: Request, res: Response) => {
    const response: ApiResponse = {
      success: true,
      data: {
        state: 'running',
        backendPort: parseInt(process.env.PORT || '3001', 10),
        logs: [],
      },
    };
    return res.json(response);
  });

  router.post('/engine/start', (_req: Request, res: Response) => {
    return res.json({ success: false, error: 'Engine already running (started directly by you)' });
  });

  router.post('/engine/stop', (_req: Request, res: Response) => {
    return res.json({ success: false, error: 'Cannot stop engine via API in dev mode. Use Ctrl+C.' });
  });

  return router;
}

/**
 * Check if a command is available in the system PATH.
 */
async function checkCommand(command: string): Promise<boolean> {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    exec(`${cmd} ${command}`, (error: Error | null) => {
      resolve(!error);
    });
  });
}

/**
 * Safely read a directory.
 */
function readDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Get the total size of a directory in bytes (internal).
 */
function getDirSizeBytes(dir: string): number {
  let total = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      total += fs.statSync(fullPath).size;
    } else if (entry.isDirectory()) {
      total += getDirSizeBytes(fullPath);
    }
  }
  return total;
}

/**
 * Get the total size of a directory in MB.
 */
function getDirSizeSync(dir: string): number {
  try {
    return Math.round(getDirSizeBytes(dir) / (1024 * 1024) * 100) / 100;
  } catch {
    return 0;
  }
}
