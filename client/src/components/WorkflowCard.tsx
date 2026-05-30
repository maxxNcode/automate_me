import { useState, useEffect, useRef } from 'react';
import type { WorkflowState } from '../types';
import type { WorkflowLog } from '../hooks/useWorkflow';
import { StepProgress } from './StepProgress';
import { WorkflowLogPanel } from './WorkflowLogPanel';
import { workflowApi } from '../api/workflow';

interface WorkflowCardProps {
  workflow: WorkflowState;
  onCancel?: (id: string) => void;
  onDelete?: (id: string) => void;
  logs?: WorkflowLog[];
  isAdmin?: boolean;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function WorkflowCard({ workflow, onCancel, onDelete, logs, isAdmin }: WorkflowCardProps) {
  const isQueued = workflow.status === 'queued';
  const isRunning = workflow.status === 'running';
  const isFailed = workflow.status === 'failed';
  const isWaitingApproval = workflow.status === 'awaiting_script_approval';
  const startTime = useRef(new Date(workflow.createdAt).getTime());
  const [elapsed, setElapsed] = useState<string>('');
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [editedScenes, setEditedScenes] = useState<Array<{ text: string; searchTerms: string[] }>>([]);
  const [isEditing, setIsEditing] = useState<number | null>(null);
  const [approving, setApproving] = useState(false);

  const handleApprove = async () => {
    if (approving) return;
    setApproving(true);
    try {
      const finalScenes = (workflow.scenes || []).map((s, i) => editedScenes[i] || s);
      await workflowApi.approveScript(workflow.id, finalScenes);
    } catch (err) {
      console.error('Failed to approve script:', err);
    } finally {
      setApproving(false);
    }
  };

  const handleRegenerate = async () => {
    if (approving) return;
    setApproving(true);
    try {
      await workflowApi.regenerateScript(workflow.id);
    } catch (err) {
      console.error('Failed to regenerate script:', err);
    } finally {
      setApproving(false);
    }
  };

  // Auto-expand logs when workflow fails
  useEffect(() => {
    if (isFailed) {
      setLogsExpanded(true);
    }
  }, [isFailed]);

  useEffect(() => {
    if (!isRunning && !isQueued) {
      const end = workflow.updatedAt ? new Date(workflow.updatedAt).getTime() : Date.now();
      setElapsed(formatElapsed(end - startTime.current));
      return;
    }
    const update = () => setElapsed(formatElapsed(Date.now() - startTime.current));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [isRunning, workflow.updatedAt]);

  return (
    <div className={`workflow-card ${workflow.status}`}>
      <div className="workflow-card-header">
        <div className="workflow-title-section">
          <h3 className="workflow-title">{workflow.topic}</h3>
          <span className={`workflow-status-badge ${workflow.status}`}>
            {workflow.status === 'idle' && 'Idle'}
            {workflow.status === 'queued' && 'Queued'}
            {workflow.status === 'running' && 'Running'}
            {workflow.status === 'completed' && 'Completed'}
            {workflow.status === 'failed' && 'Failed'}
            {workflow.status === 'awaiting_script_approval' && 'Awaiting Approval'}
          </span>
        </div>
        <div className="workflow-meta">
          <span className="workflow-time">
            {isQueued && `Queued`}
            {isRunning && `Processing ${elapsed}`}
            {!isQueued && !isRunning && `${elapsed}`}
          </span>
          <span className="workflow-id" title={workflow.id}>
            #{workflow.id.slice(0, 8)}
          </span>
          {workflow.createdBy && (
            <span className="workflow-creator">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              {workflow.createdBy}
            </span>
          )}
        </div>
      </div>

      <div className="workflow-progress-bar">
        <div
          className={`workflow-progress-fill ${workflow.status}`}
          style={{ width: `${workflow.progress}%` }}
        />
      </div>

      <div className="workflow-progress-text">
        {isQueued && 'Waiting in queue...'}
        {!isQueued && `${workflow.progress}% complete`}
        {isRunning && workflow.currentStep && ` · Processing ${workflow.currentStep.replace(/_/g, ' ')}`}
        {isFailed && ' · Failed'}
      </div>

      <StepProgress
        steps={workflow.steps}
        currentStep={workflow.currentStep}
      />

      {isWaitingApproval && workflow.scenes && workflow.scenes.length > 0 && (
        <div className="script-preview-panel">
          <h4>Script Preview — Review before rendering</h4>
          {workflow.scenes.map((scene, i) => (
            <div key={i} className="scene-card">
              <div className="scene-number">Scene {i + 1}{i === 0 ? ' (Hook)' : ''}{i === (workflow.scenes!.length - 1) ? ' (CTA)' : ''}</div>
              {isEditing === i ? (
                <textarea
                  value={editedScenes[i]?.text || scene.text}
                  onChange={(e) => {
                    const updated = [...editedScenes];
                    updated[i] = { ...(updated[i] || scene), text: e.target.value };
                    setEditedScenes(updated);
                  }}
                  className="scene-text-input"
                  rows={3}
                />
              ) : (
                <p className="scene-text" onClick={() => { setIsEditing(i); setEditedScenes(prev => { const n = [...prev]; n[i] = n[i] || scene; return n; }); }}>
                  {scene.text}
                </p>
              )}
              <div className="scene-keywords">
                <small>Keywords: {scene.searchTerms?.join(', ')}</small>
              </div>
              {isEditing === i && (
                <button className="btn btn-small" onClick={() => setIsEditing(null)}>Done</button>
              )}
            </div>
          ))}
          <div className="script-actions">
            <button className="btn btn-primary" onClick={handleApprove} disabled={approving}>
              {approving ? 'Approving...' : 'Approve & Render'}
            </button>
            <button className="btn btn-secondary" onClick={handleRegenerate} disabled={approving}>
              Regenerate
            </button>
          </div>
        </div>
      )}

      {(logs || isRunning || isQueued) && (
        <WorkflowLogPanel
          logs={logs || []}
          expanded={logsExpanded}
          onToggle={() => setLogsExpanded(!logsExpanded)}
          workflowId={workflow.id}
          workflowStatus={workflow.status}
        />
      )}

      <div className="workflow-card-actions">
        {(isRunning || isQueued || isWaitingApproval) && onCancel && (
          <button className="btn btn-danger btn-sm" onClick={() => onCancel(workflow.id)}>
            {isWaitingApproval ? 'Cancel & Discard' : 'Cancel'}
          </button>
        )}
        {workflow.status === 'completed' && (
          <a
            className="btn btn-primary btn-sm"
            href={`/api/workflow/${workflow.id}/download`}
            download
            onClick={(e) => {
              // If no file path available, prevent download and show info
              const output = workflow.steps.video_assembly?.result as { file_path?: string; resolution?: string } | undefined;
              if (!output?.file_path) {
                e.preventDefault();
                const format = output?.resolution === '1080x1920' ? 'Short/Reel (9:16)' : 'Tutorial (16:9)';
                alert(`[${format}] Workflow completed successfully!\n\nWorkflow ID: ${workflow.id}\nTopic: ${workflow.topic}`);
              }
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download
          </a>
        )}
        {!isRunning && isAdmin && onDelete && (
          <button className="btn btn-ghost btn-sm" onClick={() => onDelete(workflow.id)}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}


