import { useState } from 'react';
import { useWorkflows } from '../hooks/useWorkflow';
import { useAuth } from '../auth/AuthContext';
import { workflowApi } from '../api/workflow';
import { PipelineForm } from './PipelineForm';
import { WorkflowList } from './WorkflowList';
import { SystemStatus } from './SystemStatus';
import { EngineControl } from './EngineControl';
import { LogViewer } from './LogViewer';
import { QueueStatus } from './QueueStatus';
import { AdminKeyManager } from './AdminKeyManager';
import { BridgeStatusBadge } from './BridgeStatusBadge';

type Page = 'dashboard' | 'logs';

export function PipelineDashboard() {
  const { user, logout, isAdmin } = useAuth();
  const { workflows, workflowLogs, loading, startWorkflow, cancelWorkflow, refresh } = useWorkflows();
  const hasRunningWorkflow = workflows.some(w => w.status === 'running');
  const [engineState, setEngineState] = useState<string>('loading');
  const [page, setPage] = useState<Page>('dashboard');

  const handleDelete = async (id: string) => {
    try {
      await workflowApi.deleteWorkflow(id, user?.accessKey);
      refresh();
    } catch (err) {
      console.error('Failed to delete workflow:', err);
    }
  };

  const handleStartWorkflow = async (topic: string, options?: Record<string, unknown>) => {
    await startWorkflow(topic, { ...options, username: user?.username });
  };

  if (page === 'logs') {
    return (
      <div className="dashboard">
        <LogViewer fullScreen onClose={() => setPage('dashboard')} />
      </div>
    );
  }

  return (
    <div className="dashboard">
      {/* Engine Control (admin only) */}
      {isAdmin && <EngineControl onStateChange={setEngineState} />}

      {/* Header */}
      <header className="dashboard-header">
        <div className="header-left">
          <h1 className="app-title">YouTube Auto</h1>
          <p className="app-subtitle">AI-Powered Video Generation Pipeline</p>
        </div>
        <div className="header-right">
          <span className="header-user">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            {user?.username}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={logout} title="Sign out">
            Sign Out
          </button>
          <button className="btn btn-ghost btn-icon" onClick={refresh} title="Refresh">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>
      </header>

      {/* Main Layout */}
      <div className="dashboard-content">
        {/* Left Column - Form */}
        <div className="dashboard-main">
          <PipelineForm onSubmit={handleStartWorkflow} />

          {/* Queue Status */}
          <QueueStatus />

          {/* Active Workflow Notice */}
          {hasRunningWorkflow && (
            <div className="notice">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
              <span>A workflow is currently generating. Your new workflow will be queued and start automatically when it's its turn.</span>
            </div>
          )}

          {/* Engine Offline Notice (admin only — friends don't see engine controls) */}
          {isAdmin && engineState !== 'running' && engineState !== 'loading' && (
            <div className="notice engine-offline">
              <span>Engine is {engineState}. Start the engine above to enable video generation.</span>
            </div>
          )}

          {/* Workflow List */}
          <section className="workflows-section">
            <div className="section-header">
              <h2>History</h2>
              <span className="workflow-count">{workflows.length} workflow{workflows.length !== 1 ? 's' : ''}</span>
            </div>
            <WorkflowList
              workflows={workflows}
              loading={loading}
              onCancel={cancelWorkflow}
              onDelete={handleDelete}
              workflowLogs={workflowLogs}
              isAdmin={isAdmin}
            />
          </section>
        </div>

        {/* Right Column - System Status & Logs */}
        <div className="dashboard-sidebar">
          {/* Bridge Status */}
          <BridgeStatusBadge />

          {/* Access Keys (admin only) */}
          {isAdmin && <AdminKeyManager />}

          <SystemStatus />
          <LogViewer />
          <button className="sidebar-nav-btn" onClick={() => setPage('logs')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            Open Full Logs
          </button>

          {/* Quick Info */}
          <div className="info-card">
            <h3>Pipeline Steps</h3>
            <ul className="info-steps">
              <li><strong>1. Script</strong> - AI generates viral script</li>
              <li><strong>2. Voiceover</strong> - TTS creates audio</li>
              <li><strong>3. Thumbnail</strong> - AI renders thumbnail</li>
              <li><strong>4. Video</strong> - FFmpeg assembles</li>
              <li><strong>5. Upload</strong> - Publish to YouTube</li>
            </ul>
          </div>

          <div className="info-card">
            <h3>Fallback Mode</h3>
            <p className="info-text">
              All tools gracefully degrade when dependencies aren't installed.
              The pipeline generates template scripts, silent audio, styled thumbnails,
              and simple background videos — no API keys required.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
