import type { WorkflowState } from '../types';
import type { WorkflowLog } from '../hooks/useWorkflow';
import { WorkflowCard } from './WorkflowCard';

interface WorkflowListProps {
  workflows: WorkflowState[];
  loading: boolean;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  workflowLogs?: Record<string, WorkflowLog[]>;
  isAdmin?: boolean;
}

export function WorkflowList({ workflows, loading, onCancel, onDelete, workflowLogs, isAdmin }: WorkflowListProps) {
  if (loading) {
    return (
      <div className="workflow-list-empty">
        <div className="loading-spinner" />
        <p>Loading workflows...</p>
      </div>
    );
  }

  if (workflows.length === 0) {
    return (
      <div className="workflow-list-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
        <h3>No workflows yet</h3>
        <p>Start a new pipeline above to generate your first video.</p>
      </div>
    );
  }

  // Show running first, then queued, then by date
  const sorted = [...workflows].sort((a, b) => {
    const order = { running: 0, awaiting_script_approval: 1, queued: 2, completed: 3, failed: 3, idle: 4 };
    const diff = (order[a.status] ?? 2) - (order[b.status] ?? 2);
    if (diff !== 0) return diff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return (
    <div className="workflow-list">
      {sorted.map(workflow => (
        <WorkflowCard
          key={workflow.id}
          workflow={workflow}
          onCancel={onCancel}
          onDelete={onDelete}
          logs={workflowLogs?.[workflow.id]}
          isAdmin={isAdmin}
        />
      ))}
    </div>
  );
}
