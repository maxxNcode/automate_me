import { useEffect, useRef } from 'react';
import type { WorkflowLog } from '../hooks/useWorkflow';

interface WorkflowLogPanelProps {
  logs: WorkflowLog[];
  expanded: boolean;
  onToggle: () => void;
  workflowId: string;
  workflowStatus: string;
}

export function WorkflowLogPanel({ logs, expanded, onToggle, workflowId, workflowStatus }: WorkflowLogPanelProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (expanded && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs, expanded]);

  const errorCount = logs.filter(l => l.level === 'error').length;
  const warnCount = logs.filter(l => l.level === 'warn').length;

  return (
    <div className={`workflow-log-panel ${expanded ? 'expanded' : ''}`}>
      <button className="workflow-log-toggle" onClick={onToggle}>
        <div className="workflow-log-toggle-left">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          <span>Workflow Logs</span>
          {logs.length > 0 && (
            <span className="log-count-badge">{logs.length}</span>
          )}
          {errorCount > 0 && (
            <span className="log-error-badge">{errorCount} error{errorCount !== 1 ? 's' : ''}</span>
          )}
          {warnCount > 0 && errorCount === 0 && (
            <span className="log-warn-badge">{warnCount} warn{warnCount !== 1 ? 's' : ''}</span>
          )}
        </div>
        <svg
          className={`chevron ${expanded ? 'open' : ''}`}
          width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && (
        <div className="workflow-log-body" ref={bodyRef}>
          {logs.length === 0 ? (
            <div className="workflow-log-empty">
              {workflowStatus === 'running'
                ? 'Waiting for log output...'
                : 'No log output for this workflow.'}
            </div>
          ) : (
            logs.map((log, i) => (
              <div key={i} className={`workflow-log-entry ${log.level}`}>
                <span className="workflow-log-time">{formatLogTime(log.timestamp)}</span>
                <span className={`workflow-log-level ${log.level}`}>
                  {log.level === 'info' ? 'INFO' : log.level === 'warn' ? 'WARN' : 'ERROR'}
                </span>
                <span className="workflow-log-msg">{log.message}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function formatLogTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false });
}
