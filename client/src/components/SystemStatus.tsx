import { useState, useEffect } from 'react';
import { systemApi } from '../api/workflow';
import type { SystemStatus as SystemStatusType } from '../types';

export function SystemStatus() {
  const [status, setStatus] = useState<SystemStatusType | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    loadStatus();
  }, []);

  const loadStatus = async () => {
    setLoading(true);
    try {
      const data = await systemApi.getStatus();
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="system-status-card loading">
        <div className="status-header">
          <h3>System Status</h3>
          <div className="status-loading">Loading...</div>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="system-status-card">
        <div className="status-header" onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer' }}>
          <h3>System Status</h3>
          <div className="status-summary">
            <span className="status-dot yellow" />
            <span className="status-toggle">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </span>
          </div>
        </div>
        <div className="status-body">
          <div className="status-loading">Start the engine to check system status.</div>
        </div>
      </div>
    );
  }

  const aiProviderStatus = status.aiProviders;
  const groqReady = aiProviderStatus?.groq?.available;
  const orReady = aiProviderStatus?.openrouter?.available;
  const groqConfigured = aiProviderStatus?.groq?.configured;
  const orConfigured = aiProviderStatus?.openrouter?.configured;

  const tools = [
    { name: 'Python', available: status.python?.available, detail: `${status.python?.scripts || 0} scripts` },
    { name: 'FFmpeg', available: status.ffmpeg?.available },
    { name: 'Short Video Maker', status: status.shortVideoMaker?.status || 'unavailable' },
    {
      name: 'AI Provider',
      status: groqReady || orReady
        ? 'ready'
        : groqConfigured || orConfigured
          ? 'partial'
          : 'unconfigured',
      detail: groqReady && orReady
        ? 'Groq + OpenRouter'
        : groqReady
          ? 'Groq only'
          : orReady
            ? 'OpenRouter only'
            : groqConfigured || orConfigured
              ? 'Configured (check keys)'
              : 'No API key set',
    },
    { name: 'Edge TTS', status: status.tools?.edge_tts?.status || 'unavailable' },
    { name: 'Stable Diffusion', status: status.tools?.stable_diffusion?.status || 'unavailable' },
    { name: 'YouTube Upload', status: status.tools?.youtube_upload?.status || 'unavailable' },
  ];

  return (
    <div className={`system-status-card ${expanded ? 'expanded' : ''}`}>
      <div className="status-header" onClick={() => setExpanded(!expanded)}>
        <h3>System Status</h3>
        <div className="status-summary">
          <span className="status-dot-container">
            {status.python.available && status.ffmpeg.available ? (
              <span className="status-dot green" />
            ) : (
              <span className="status-dot yellow" />
            )}
          </span>
          <button className="status-toggle">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      </div>

      {expanded && (
        <div className="status-body">
          <div className="tools-grid">
            {tools.map(tool => (
              <div key={tool.name} className="tool-item">
                <div className="tool-info">
                  <span className="tool-name">{tool.name}</span>
                  {tool.detail && <span className="tool-detail">{tool.detail}</span>}
                </div>
                <span className={`tool-status ${getToolStatusClass(tool)}`}>
                  {getToolStatusLabel(tool)}
                </span>
              </div>
            ))}
          </div>

          <button className="btn btn-ghost btn-sm btn-block" onClick={loadStatus}>
            Refresh Status
          </button>
        </div>
      )}
    </div>
  );
}

function getToolStatusClass(tool: { available?: boolean; status?: string }): string {
  if (tool.available === true) return 'ready';
  if (tool.available === false) return 'unavailable';
  if (tool.status === 'ready') return 'ready';
  if (tool.status === 'unavailable' || !tool.status) return 'unavailable';
  return 'optional';
}

function getToolStatusLabel(tool: { available?: boolean; status?: string }): string {
  if (tool.available === true) return 'Ready';
  if (tool.available === false) return 'Not Found';
  if (tool.status === 'ready') return 'Ready';
  if (tool.status === 'unavailable' || !tool.status) return 'Unavailable';
  if (tool.status === 'optional') return 'Optional';
  return 'Unknown';
}
