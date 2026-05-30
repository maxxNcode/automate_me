import { useState, useEffect, useRef, useCallback } from 'react';
import { systemApi } from '../api/workflow';
import { engineApi } from '../api/engine';
import type { AiModelInfo } from '../types';

interface ModelPickerProps {
  value: string;
  onChange: (modelKey: string) => void;
  disabled?: boolean;
}

type ModelGroup = {
  provider: string;
  label: string;
  models: AiModelInfo[];
};

export function ModelPicker({ value, onChange, disabled }: ModelPickerProps) {
  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [engineState, setEngineState] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasAttemptedLoad, setHasAttemptedLoad] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const loadModels = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await systemApi.getModels();
      setModels(data || []);
      setEngineState('running');
      setLoadError(null);
    } catch {
      setModels([]);
      try {
        const status = await engineApi.getStatus();
        if (status.state !== 'running') {
          setEngineState(status.state);
          setLoadError('Start the engine to see available AI models');
        } else {
          setLoadError('Could not load models. Check your API keys in .env');
        }
      } catch {
        setEngineState('unknown');
        setLoadError('Could not connect to the launcher');
      }
    } finally {
      setLoading(false);
      setHasAttemptedLoad(true);
    }
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleToggle = () => {
    // If dropdown is closed and models failed to load before, retry
    if (!open && hasAttemptedLoad && loadError) {
      loadModels();
    }
    setOpen(!open);
  };

  // Group models by provider
  const groups: ModelGroup[] = [
    {
      provider: 'groq',
      label: 'Groq',
      models: models.filter(m => m.provider === 'groq'),
    },
    {
      provider: 'openrouter',
      label: 'OpenRouter',
      models: models.filter(m => m.provider === 'openrouter'),
    },
  ].filter(g => g.models.length > 0);

  const selectedModel = models.find(m => m.key === value);
  const hasConfiguredKey = models.some(m => m.configured);

  const getProviderColor = (provider: string) => {
    return provider === 'groq' ? '#f97316' : '#6366f1';
  };

  return (
    <div className="model-picker" ref={ref}>
      <label className="model-picker-label">AI Model</label>

      <button
        type="button"
        className={`model-picker-trigger ${open ? 'open' : ''}`}
        onClick={handleToggle}
        disabled={disabled || loading}
      >
        {loading ? (
          <span className="model-picker-placeholder">Loading models...</span>
        ) : value === 'auto' ? (
          <span className="model-picker-selected">
            <span className="model-picker-dot auto" />
            <span className="model-picker-name">Auto (Smart Cycle)</span>
            {hasConfiguredKey && (
              <span className="model-picker-badge">Groq ￫ OpenRouter ￫ Fallback</span>
            )}
          </span>
        ) : selectedModel ? (
          <span className="model-picker-selected">
            <span
              className="model-picker-dot provider"
              style={{ background: getProviderColor(selectedModel.provider) }}
            />
            <span className="model-picker-name">{selectedModel.displayName}</span>
            {!selectedModel.configured && (
              <span className="model-picker-badge warn">No API key</span>
            )}
            {selectedModel.failed && (
              <span className="model-picker-badge error">Failed (will retry)</span>
            )}
          </span>
        ) : (
          <span className="model-picker-placeholder">No models available</span>
        )}
        <svg className="model-picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="model-picker-dropdown">
          {/* Auto option */}
          <button
            type="button"
            className={`model-picker-option ${value === 'auto' ? 'selected' : ''}`}
            onClick={() => { onChange('auto'); setOpen(false); }}
          >
            <span className="model-picker-option-icon">
              <span className="model-picker-dot auto" />
            </span>
            <span className="model-picker-option-info">
              <span className="model-picker-option-name">Auto (Smart Cycle)</span>
              <span className="model-picker-option-desc">
                Tries Groq first, falls back to OpenRouter, then templates
              </span>
            </span>
            {value === 'auto' && <span className="model-picker-check">✓</span>}
          </button>

          <div className="model-picker-divider" />

          {/* Grouped models by provider */}
          {groups.map(group => (
            <div key={group.provider} className="model-picker-group">
              <div className="model-picker-group-header">
                <span className="model-picker-group-dot" style={{ background: getProviderColor(group.provider) }} />
                {group.label}
              </div>
              {group.models.map(model => {
                const isSelected = value === model.key;
                const iconColor = model.configured
                  ? getProviderColor(model.provider)
                  : 'var(--text-muted)';
                return (
                  <button
                    key={model.key}
                    type="button"
                    className={`model-picker-option ${isSelected ? 'selected' : ''}`}
                    onClick={() => { onChange(model.key); setOpen(false); }}
                    disabled={!model.configured}
                  >
                    <span className="model-picker-option-icon">
                      <span className="model-picker-dot provider" style={{ background: iconColor }} />
                    </span>
                    <span className="model-picker-option-info">
                      <span className="model-picker-option-name">{model.displayName}</span>
                      <span className="model-picker-option-desc">
                        {!model.configured
                          ? 'No API key configured'
                          : model.failed
                            ? 'Previously failed — will retry'
                            : model.modelId}
                      </span>
                    </span>
                    {isSelected && <span className="model-picker-check">✓</span>}
                    {!model.configured && (
                      <span className="model-picker-lock" title="No API key">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}

          {!loading && models.length === 0 && (
            <div className="model-picker-empty">
              {loadError ? (
                <>
                  <p>{loadError}</p>
                  {engineState !== 'running' && (
                    <p className="model-picker-empty-detail">Use the Engine Control panel above to start it</p>
                  )}
                </>
              ) : (
                <>
                  <p>No AI models found</p>
                  <p className="model-picker-empty-detail">Set GROQ_API_KEY or OPENROUTER_API_KEY in .env</p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
