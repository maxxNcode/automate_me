export interface EngineStatus {
  state: 'stopped' | 'starting' | 'running' | 'error';
  backendPort: number;
  logs: EngineLogEntry[];
}

export interface EngineLogEntry {
  type: string;
  timestamp: string;
  level: string;
  message: string;
  source: string;
}

export const engineApi = {
  async getStatus(): Promise<EngineStatus> {
    const res = await fetch('/api/engine/status');
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to get engine status');
    return data.data;
  },

  async start(): Promise<void> {
    const res = await fetch('/api/engine/start', { method: 'POST' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to start engine');
  },

  async stop(): Promise<void> {
    const res = await fetch('/api/engine/stop', { method: 'POST' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to stop engine');
  },
};
