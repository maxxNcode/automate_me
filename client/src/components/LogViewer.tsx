import { useState, useEffect, useRef } from 'react';
import type { EngineLogEntry } from '../api/engine';

interface LogViewerProps {
  fullScreen?: boolean;
  onClose?: () => void;
}

export function LogViewer({ fullScreen, onClose }: LogViewerProps) {
  const [logs, setLogs] = useState<EngineLogEntry[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws/engine`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'engine:log') {
          setLogs(prev => {
            const next = [...prev, data];
            if (next.length > 1000) next.splice(0, next.length - 1000);
            return next;
          });
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      setTimeout(() => {
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
      }, 100);
    };

    ws.onerror = () => {};

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className={`log-viewer ${fullScreen ? 'fullscreen' : ''}`}>
      <div className="log-header">
        <div className="log-header-left">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          <span>Engine Logs ({logs.length})</span>
        </div>
        <div className="log-header-right">
          <button className="log-clear-btn" onClick={() => setLogs([])} title="Clear logs">Clear</button>
          {onClose && (
            <button className="btn btn-ghost btn-sm" onClick={onClose}>Back to Dashboard</button>
          )}
        </div>
      </div>
      <div className={`log-body ${fullScreen ? 'fullscreen' : ''}`} ref={bodyRef}>
        {logs.length === 0 ? (
          <div className="log-empty">Waiting for engine output...</div>
        ) : (
          logs.map((log, i) => (
            <div key={i} className={`log-entry ${log.level}`}>
              <span className="log-time">{formatTime(log.timestamp)}</span>
              <span className={`log-level ${log.level}`}>{log.level.toUpperCase()}</span>
              <span className="log-source">{log.source}</span>
              <span className="log-msg">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false });
}
