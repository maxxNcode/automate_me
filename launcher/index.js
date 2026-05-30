const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 5173;
const BACKEND_PORT = 3001;
const ROOT_DIR = path.resolve(__dirname, '..');
const CLIENT_DIST = path.join(ROOT_DIR, 'client', 'dist');

const app = express();
const server = http.createServer(app);

let engineState = 'stopped';
let backendProcess = null;
let healthCheckInterval = null;
let isStarting = false;
const engineLogs = [];
const MAX_LOGS = 2000;
const logClients = new Set();

const wss = new WebSocketServer({ noServer: true, path: '/ws/engine' });

wss.on('connection', (ws) => {
  logClients.add(ws);
  ws.on('error', () => {});
  ws.send(JSON.stringify({ type: 'engine:connected', timestamp: new Date().toISOString() }));
  for (const log of engineLogs) {
    ws.send(JSON.stringify(log));
  }
  ws.on('close', () => logClients.delete(ws));
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of logClients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function addLog(level, message, source) {
  const entry = {
    type: 'engine:log',
    timestamp: new Date().toISOString(),
    level,
    message,
    source: source || 'launcher',
  };
  engineLogs.push(entry);
  if (engineLogs.length > MAX_LOGS) engineLogs.shift();
  broadcast(entry);
}

function setState(newState) {
  engineState = newState;
  broadcast({ type: 'engine:state', state: newState, timestamp: new Date().toISOString() });
}

// ---------- Engine API ----------

app.get('/api/engine/status', (_req, res) => {
  res.json({
    success: true,
    data: {
      state: engineState,
      backendPort: BACKEND_PORT,
      logs: engineLogs.slice(-100),
    },
  });
});

app.post('/api/engine/start', (_req, res) => {
  if (engineState === 'running' || engineState === 'starting' || isStarting) {
    return res.json({ success: false, error: 'Engine already running or starting' });
  }
  setState('starting');
  isStarting = true;
  addLog('info', 'Starting engine...');
  res.json({ success: true, data: { state: engineState } });
  startEngine();
});

app.post('/api/engine/stop', (_req, res) => {
  if (engineState === 'stopped') {
    return res.json({ success: false, error: 'Engine not running' });
  }
  stopEngine();
  res.json({ success: true, data: { state: engineState } });
});

// ---------- Engine Lifecycle ----------

function startEngine() {
  addLog('info', 'Starting backend server...');
  const serverDir = path.join(ROOT_DIR, 'server');

  // Kill any existing process on the backend port before starting
  try {
    require('child_process').execSync(
      `netstat -ano | findstr :${BACKEND_PORT} | findstr LISTENING`,
      { timeout: 3000, windowsHide: true, stdio: 'pipe' }
    ).toString().split('\n').forEach(line => {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && pid !== '0') {
        try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
      }
    });
  } catch {
    // No process on that port — good
  }

  backendProcess = spawn('npx tsx src/index.ts', {
    cwd: serverDir,
    env: { ...process.env, PORT: String(BACKEND_PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });

  backendProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      console.log(`[backend] ${line}`);
      addLog('info', line, 'backend');
      if (line.includes('Running on') || line.includes('FIRST-TIME ACCESS KEY')) {
        setTimeout(() => startHealthCheck(), 500);
      }
    }
  });

  backendProcess.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      if (line.includes('ExperimentalWarning') || line.includes('Custom ESM') || line.includes('(Repository)')) continue;
      console.error(`[backend] ${line}`);
      addLog(line.toLowerCase().includes('error') ? 'error' : 'warn', line, 'backend');
    }
  });

  backendProcess.on('exit', (code) => {
    isStarting = false;
    const msg = `Backend exited with code ${code}`;
    console.error(`[launcher] ${msg}`);
    addLog('warn', msg, 'launcher');
    setState(code === 0 ? 'stopped' : 'error');
    backendProcess = null;
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }
  });

  backendProcess.on('error', (err) => {
    isStarting = false;
    const msg = `Failed to start backend: ${err.message}`;
    console.error(`[launcher] ${msg}`);
    addLog('error', msg, 'launcher');
    setState('error');
    backendProcess = null;
  });
}

function startHealthCheck() {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  let attempts = 0;
  const maxAttempts = 30;
  healthCheckInterval = setInterval(() => {
    attempts++;
    http.get(`http://localhost:${BACKEND_PORT}/health`, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          isStarting = false;
          setState('running');
          addLog('info', 'Engine is ready. Backend server running.', 'launcher');
          clearInterval(healthCheckInterval);
          healthCheckInterval = null;
        }
      });
    }).on('error', () => {
      if (attempts >= maxAttempts) {
        isStarting = false;
        addLog('error', 'Backend health check failed after 30s', 'launcher');
        setState('error');
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
    });
  }, 1000);
}

function stopEngine() {
  addLog('info', 'Stopping engine...', 'launcher');
  isStarting = false;
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    setTimeout(() => {
      if (backendProcess) {
        backendProcess.kill('SIGKILL');
        backendProcess = null;
      }
    }, 5000);
  }
  setState('stopped');
  addLog('info', 'Engine stopped.', 'launcher');
}

// ---------- Proxy: forward /api/* to backend when running ----------

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/engine/')) return next();
  if (engineState !== 'running') {
    return res.status(503).json({
      success: false,
      error: 'Backend server is not running. Start the engine first.',
      engineState,
    });
  }
  const targetPath = req.originalUrl;
  const options = {
    hostname: 'localhost',
    port: BACKEND_PORT,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers },
  };
  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.on('error', () => {});
    res.on('error', () => {});
    proxyRes.pipe(res);
  });
  req.on('error', () => {});
  proxyReq.on('error', () => {});
  req.pipe(proxyReq);
});

// ---------- WebSocket proxy for /ws (backend workflow updates) ----------

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/ws/engine') {
    socket.on('error', () => {});
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on('error', () => {});
      wss.emit('connection', ws, request);
    });
    return;
  }
  if (engineState === 'running') {
    const proxyReq = http.request({
      hostname: 'localhost',
      port: BACKEND_PORT,
      path: url.pathname + url.search,
      method: 'GET',
      headers: request.headers,
    });
    proxyReq.on('upgrade', (_proxyRes, proxySocket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      proxySocket.on('error', () => {});
      socket.on('error', () => {});
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxyReq.on('error', () => {});
    socket.on('error', () => {});
    proxyReq.end();
  } else {
    socket.destroy();
  }
});

// ---------- Serve frontend ----------

app.use(express.static(CLIENT_DIST, { index: false }));
app.get('*', (_req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'));
});

// ---------- Start ----------

server.listen(PORT, () => {
  console.log('');
  console.log('  YouTube Auto Launcher');
  console.log('  ' + '-'.repeat(21));
  console.log(`  Frontend : http://localhost:${PORT}`);
  console.log(`  Backend  : http://localhost:${BACKEND_PORT}`);
  console.log('');
  console.log('  Starting backend server...');
  console.log('');

  // Start backend immediately so the access key gets seeded & printed
  setTimeout(() => startEngine(), 500);
});
