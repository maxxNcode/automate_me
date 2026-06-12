/**
 * YouTube Automation Workflow - Server Entry Point
 * Express server with WebSocket support for real-time workflow updates.
 */

import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import dotenv from 'dotenv';

import { createWorkflowRoutes } from './routes/workflow';
import { createSystemRoutes } from './routes/system';
import { createAuthRoutes } from './routes/auth';
import { WorkflowOrchestrator } from './services/workflowOrchestrator';
import { createBridgeRoutes } from './routes/bridge';
import { GeminiBridge } from './services/geminiBridge';
import { WsEvent } from './types';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

// Initialize app
const app = express();
const server = http.createServer(app);

// Middleware
// Allow dynamic origins (ngrok, localtunnel, etc.) while still validating in development
const allowedOrigins = [
  CLIENT_ORIGIN,
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:3001',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, etc.) or from allowed list
    if (!origin || allowedOrigins.includes(origin) || origin.includes('ngrok') || origin.includes('loca.lt') || origin.includes('trycloudflare.com')) {
      callback(null, true);
    } else {
      // For any other origin (ngrok, etc.), be permissive
      callback(null, true);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve generated assets statically
const outputDir = path.resolve(__dirname, '..', '..', 'output');
app.use('/assets', express.static(path.join(outputDir, 'assets')));

// Scene image files — serve PNGs from scenes directories
// URL: /api/scene-file/:workflowId/:filename
app.get('/api/scene-file/:workflowId/:filename', (req, res) => {
  const scenesDir = path.resolve(outputDir, 'assets', 'scenes', req.params.workflowId);
  const filePath = path.join(scenesDir, req.params.filename);
  // Prevent directory traversal
  if (!filePath.startsWith(scenesDir)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!require('fs').existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.sendFile(filePath);
});

// Initialize workflow orchestrator
const orchestrator = new WorkflowOrchestrator();

// Initialize Gemini bridge and mount its HTTP routes
const geminiBridge = new GeminiBridge();
app.use('/gemini-bridge', createBridgeRoutes(geminiBridge, (update) => {
  orchestrator.emitBridgeStatus(update.workflowId, update.status, update.message, update.progress);
}));

// Seed initial access keys on startup, or show existing ones
import { getDatabase } from './services/database';
const db = getDatabase();
const seedKeys = db.seedFirstKeys();

if (seedKeys) {
  // Freshly generated — show both keys
  console.log(`
╔═══════════════════════════════════════════════╗
║         🗝️  ACCESS KEYS GENERATED             ║
║                                               ║
║   [ADMIN]  ${seedKeys.admin.padEnd(35)}║
║                                               ║
║   [USER]   ${seedKeys.user.padEnd(35)}║
║                                               ║
║   Admin key → grants engine + key management  ║
║   User key  → create & watch pipelines only   ║
╚═══════════════════════════════════════════════╝
  `);
} else {
  // Keys already exist — show the first admin key and first user key
  const allKeys = db.listAccessKeys();
  const adminKey = allKeys.find(k => k.role === 'admin');
  let userKey = allKeys.find(k => k.role === 'user');

  // If no user key exists (upgraded from old single-key system), generate one
  if (!userKey) {
    const newKey = db.createAccessKey('auto-user', 'user');
    userKey = { key: newKey, label: 'auto-user', role: 'user', created_at: new Date().toISOString(), used_by: null, used_at: null };
  }

  if (adminKey || userKey) {
    console.log(`
╔═══════════════════════════════════════════════╗
║         🗝️  ACCESS KEYS (existing)            ║
║                                               ║
${adminKey ? `║   [ADMIN]  ${(adminKey.key).padEnd(35)}║` : ''}
${userKey ? `║   [USER]   ${(userKey.key).padEnd(35)}║` : ''}
║                                               ║
║   Admin key → grants engine + key management  ║
║   User key  → create & watch pipelines only   ║
╚═══════════════════════════════════════════════╝
  `);
  }
}

// API Routes
app.use('/api/workflow', createWorkflowRoutes(orchestrator));
app.use('/api/system', createSystemRoutes(geminiBridge));
app.use('/api/auth', createAuthRoutes());

// WebSocket Server for real-time updates
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Map<string, Set<WebSocket>>();

wss.on('connection', (ws: WebSocket, req) => {
  const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  console.log(`[WS] Client connected: ${clientId}`);
  
  // Add to general broadcast
  if (!clients.has('broadcast')) {
    clients.set('broadcast', new Set());
  }
  clients.get('broadcast')!.add(ws);

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    clientId,
    timestamp: new Date().toISOString(),
  }));

  // Handle incoming messages (e.g., subscribing to specific workflows)
  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type === 'subscribe' && message.workflowId) {
        // Add to workflow-specific subscription
        if (!clients.has(message.workflowId)) {
          clients.set(message.workflowId, new Set());
        }
        clients.get(message.workflowId)!.add(ws);
        
        ws.send(JSON.stringify({
          type: 'subscribed',
          workflowId: message.workflowId,
          timestamp: new Date().toISOString(),
        }));
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${clientId}`);
    // Clean up from all subscriptions
    for (const [, clientSet] of clients) {
      clientSet.delete(ws);
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] Client error (${clientId}):`, err.message);
  });
});

// Listen for workflow events and broadcast via WebSocket
orchestrator.on('workflow-event', (event: WsEvent) => {
  const payload = JSON.stringify(event);

  // Clients subscribed to this specific workflow
  const subscribed = clients.get(event.workflowId);

  // Broadcast to general listeners EXCEPT those subscribed to this workflow
  // (subscribed clients receive events via their dedicated subscription below)
  clients.get('broadcast')?.forEach(client => {
    if (client.readyState === WebSocket.OPEN && (!subscribed || !subscribed.has(client))) {
      client.send(payload);
    }
  });

  // Send to workflow-specific subscribers only
  subscribed?.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
});

// Engine API — compatible with launcher mode.
// In dev mode (standalone backend), engine is always "running".
// In launcher mode, the launcher overrides these via its proxy.
app.get('/api/engine/status', (_req, res) => {
  res.json({
    success: true,
    data: { state: 'running', backendPort: PORT, logs: [] },
  });
});
app.post('/api/engine/start', (_req, res) => {
  res.json({ success: false, error: 'Engine already running (started directly)' });
});
app.post('/api/engine/stop', (_req, res) => {
  res.json({ success: false, error: 'Stop via Ctrl+C, not the API' });
});

// API info endpoint
app.get('/api', (_req, res) => {
  res.json({
    name: 'YouTube Automation Workflow API',
    version: '1.0.0',
    endpoints: ['/api/workflow', '/api/system', '/health', '/ws'],
  });
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║   YouTube Automation Workflow Server         ║
║   Running on http://localhost:${String(PORT).padEnd(5)}            ║
║   WebSocket on ws://localhost:${String(PORT).padEnd(5)}/ws        ║
║   API Docs: http://localhost:${String(PORT).padEnd(5)}/api        ║
╚═══════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n[Server] Shutting down gracefully...');
  wss.close();
  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down gracefully...');
  wss.close();
  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });
});
