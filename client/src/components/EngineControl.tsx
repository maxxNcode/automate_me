import { useState, useEffect, useRef, useCallback } from 'react';
import { engineApi } from '../api/engine';

interface EngineControlProps {
  onStateChange?: (state: string) => void;
}

const POLL_INTERVAL = 2000;
const HEARTBEAT_INTERVAL = 10000;
const MAX_FAILURES = 3;

export function EngineControl({ onStateChange }: EngineControlProps) {
  const [state, setState] = useState<string>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const failureCount = useRef(0);
  const mountedRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    try {
      const status = await engineApi.getStatus();
      if (!mountedRef.current) return;
      failureCount.current = 0;
      setState(status.state);
      setErrorMsg(null);
      onStateChange?.(status.state);
    } catch {
      if (!mountedRef.current) return;
      failureCount.current++;
      if (failureCount.current >= MAX_FAILURES) {
        setState('error');
        setErrorMsg('Cannot reach launcher');
      }
    }
  }, [onStateChange]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(fetchStatus, POLL_INTERVAL);
    fetchStatus();
  }, [fetchStatus]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
  }, []);

  // Mount: fetch status and start polling
  useEffect(() => {
    mountedRef.current = true;
    startPolling();
    return () => { mountedRef.current = false; stopPolling(); };
  }, [startPolling, stopPolling]);

  // Heartbeat: slow retry when in error state (silent recovery)
  useEffect(() => {
    if (state === 'error') {
      failureCount.current = 0;
      heartbeatRef.current = setInterval(async () => {
        try {
          const status = await engineApi.getStatus();
          if (!mountedRef.current) return;
          failureCount.current = 0;
          setState(status.state);
          setErrorMsg(null);
          onStateChange?.(status.state);
          startPolling();
        } catch {
          failureCount.current = 0;
        }
      }, HEARTBEAT_INTERVAL);
    }
    return () => {
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    };
  }, [state, onStateChange, startPolling]);

  // Stop polling when in terminal states
  useEffect(() => {
    if (state === 'stopped' || state === 'running') {
      stopPolling();
      failureCount.current = 0;
    }
  }, [state, stopPolling]);

  const handleStart = async () => {
    setState('starting');
    setErrorMsg(null);
    failureCount.current = 0;
    try {
      await engineApi.start();
      startPolling();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      setState('error');
    }
  };

  const handleStop = async () => {
    try {
      await engineApi.stop();
      setState('stopped');
      setErrorMsg(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
    }
  };

  const handleRetry = () => {
    failureCount.current = 0;
    setState('loading');
    startPolling();
  };

  if (state === 'loading') {
    return (
      <div className="engine-control loading">
        <div className="engine-status-indicator">
          <div className="engine-spinner" />
          <div className="engine-status-text">
            <span className="engine-label">Connecting...</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`engine-control ${state}`}>
      <div className="engine-status-indicator">
        <div className={`engine-dot ${state}`} />
        <div className="engine-status-text">
          <span className="engine-label">
            {state === 'stopped' && 'Engine Offline'}
            {state === 'starting' && 'Starting Engine...'}
            {state === 'running' && 'Engine Running'}
            {state === 'error' && 'Engine Error'}
          </span>
          {errorMsg && <span className="engine-error">{errorMsg}</span>}
        </div>
      </div>
      <div className="engine-actions">
        {state === 'stopped' && (
          <button className="btn btn-primary" onClick={handleStart}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            Start Engine
          </button>
        )}
        {state === 'starting' && (
          <button className="btn btn-primary" disabled>
            <span className="spinner" />
            Starting...
          </button>
        )}
        {state === 'running' && (
          <button className="btn btn-ghost" onClick={handleStop}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
            </svg>
            Stop Engine
          </button>
        )}
        {state === 'error' && (
          <>
            <button className="btn btn-ghost" onClick={handleRetry}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              Retry
            </button>
            <button className="btn btn-primary" onClick={handleStart}>
              Restart Engine
            </button>
          </>
        )}
      </div>
    </div>
  );
}
