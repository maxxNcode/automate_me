import { useState } from 'react';
import type { PipelineRequest } from '../types';
import { ModelPicker } from './ModelPicker';
import { CaptionControls } from './CaptionControls';

interface PipelineFormProps {
  onSubmit: (topic: string, options: Partial<PipelineRequest>) => Promise<unknown>;
  disabled?: boolean;
}

export function PipelineForm({ onSubmit, disabled }: PipelineFormProps) {
  const [topic, setTopic] = useState('');
  const [tone, setTone] = useState<string>('educational');
  const [duration, setDuration] = useState(5);
  const [style, setStyle] = useState<string>('eye-catching');
  const [autoUpload, setAutoUpload] = useState(false);
  const [addSubtitles, setAddSubtitles] = useState(true);
  const [videoStyle, setVideoStyle] = useState<string>('short');
  const [aiModel, setAiModel] = useState<string>('auto');
  const [captionPosition, setCaptionPosition] = useState<'top' | 'center' | 'bottom'>('bottom');
  const [captionBgColor, setCaptionBgColor] = useState<string>('black');
  const [footageSource, setFootageSource] = useState<'sidecar' | 'youtube_clips'>('youtube_clips');
  const [cropPosition, setCropPosition] = useState<'fit' | 'center' | 'top' | 'bottom' | 'left' | 'right'>('center');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim() || submitting) return;

    setSubmitting(true);
    try {
      await onSubmit(topic.trim(), {
        tone: tone as PipelineRequest['tone'],
        duration_minutes: videoStyle === 'short' ? duration / 60 : duration,
        thumbnail_style: style as PipelineRequest['thumbnail_style'],
        add_subtitles: addSubtitles,
        auto_upload: autoUpload,
        style: videoStyle as PipelineRequest['style'],
        ai_model: aiModel,
        caption_position: videoStyle === 'short' ? captionPosition : undefined,
        caption_background_color: videoStyle === 'short' ? captionBgColor : undefined,
        footage_source: videoStyle === 'short' ? footageSource : undefined,
        crop_position: videoStyle === 'short' && footageSource === 'youtube_clips' ? cropPosition : undefined,
      });
      setTopic('');
    } catch (err) {
      console.error('Failed to start pipeline:', err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="pipeline-form" onSubmit={handleSubmit}>
      <div className="form-header">
        <h2>New Pipeline</h2>
        <p className="form-subtitle">Configure your video generation workflow</p>
      </div>

      <div className="form-group">
        <label htmlFor="topic">Video Topic</label>
        <input
          id="topic"
          type="text"
          value={topic}
          onChange={e => setTopic(e.target.value)}
          placeholder="e.g., Introduction to Machine Learning"
          disabled={disabled || submitting}
          className="form-input"
          autoFocus
        />
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="tone">Tone</label>
          <select id="tone" value={tone} onChange={e => setTone(e.target.value)} disabled={disabled || submitting} className="form-select">
            <option value="educational">Educational</option>
            <option value="entertaining">Entertaining</option>
            <option value="professional">Professional</option>
            <option value="casual">Casual</option>
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="duration">Duration ({videoStyle === 'short' ? 'sec' : 'min'})</label>
          <input
            id="duration"
            type="range"
            min={videoStyle === 'short' ? 15 : 1}
            max={videoStyle === 'short' ? 60 : 15}
            step={videoStyle === 'short' ? 5 : 1}
            value={duration}
            onChange={e => setDuration(Number(e.target.value))}
            disabled={disabled || submitting}
            className="form-range"
          />
          <span className="range-value">{duration} {videoStyle === 'short' ? 'sec' : 'min'}</span>
        </div>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="style">Thumbnail Style</label>
          <select id="style" value={style} onChange={e => setStyle(e.target.value)} disabled={disabled || submitting} className="form-select">
            <option value="eye-catching">Eye-catching</option>
            <option value="minimalist">Minimalist</option>
            <option value="educational">Educational</option>
          </select>
        </div>

        <div className="form-group">
          <label>Options</label>
          <div className="form-checkboxes">
            <label className="checkbox-label">
              <input type="checkbox" checked={addSubtitles} onChange={e => setAddSubtitles(e.target.checked)} disabled={disabled || submitting} />
              <span>Subtitles</span>
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={autoUpload} onChange={e => setAutoUpload(e.target.checked)} disabled={disabled || submitting} />
              <span>Auto-upload</span>
            </label>
          </div>
        </div>
      </div>

      <div className="form-row">
      <ModelPicker value={aiModel} onChange={setAiModel} disabled={disabled || submitting} />

      <div className="form-group">
        <label>Video Style</label>
        <div className="style-toggle">
            <button
              type="button"
              className={`style-btn ${videoStyle === 'short' ? 'active' : ''}`}
              onClick={() => { setVideoStyle('short'); setDuration(30); }}
              disabled={disabled || submitting}
            >
              <svg className="style-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="2" width="18" height="20" rx="2" />
                <line x1="12" y1="18" x2="12" y2="18" />
              </svg>
              <span>Short / Reel</span>
              <span className="style-desc">9:16 portrait</span>
            </button>
            <button
              type="button"
              className={`style-btn ${videoStyle === 'tutorial' ? 'active' : ''}`}
              onClick={() => { setVideoStyle('tutorial'); setDuration(5); }}
              disabled={disabled || submitting}
            >
              <svg className="style-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <polygon points="10 8 16 12 10 16 10 8" />
              </svg>
              <span>Tutorial</span>
              <span className="style-desc">16:9 landscape</span>
            </button>
          </div>
        </div>
      </div>

      {videoStyle === 'short' && (
        <>
          <div className="form-group">
            <label className="form-label">Footage Source</label>
            <div className="toggle-group">
              <button
                className={`toggle-btn ${footageSource === 'sidecar' ? 'active' : ''}`}
                onClick={() => setFootageSource('sidecar')}
                type="button"
                disabled={disabled || submitting}
              >
                Stock (Pexels)
              </button>
              <button
                className={`toggle-btn ${footageSource === 'youtube_clips' ? 'active' : ''}`}
                onClick={() => setFootageSource('youtube_clips')}
                type="button"
                disabled={disabled || submitting}
              >
                Gameplay (YouTube)
              </button>
            </div>
          </div>
          {footageSource === 'youtube_clips' && (
            <div className="form-group" style={{ marginTop: '8px' }}>
              <label className="form-label">Crop Position</label>
              <div className="toggle-group">
                <button className={`toggle-btn ${cropPosition === 'fit' ? 'active' : ''}`}
                  onClick={() => setCropPosition('fit')} type="button"
                  disabled={disabled || submitting}>Fit</button>
                <button className={`toggle-btn ${cropPosition === 'center' ? 'active' : ''}`}
                  onClick={() => setCropPosition('center')} type="button"
                  disabled={disabled || submitting}>Center</button>
                <button className={`toggle-btn ${cropPosition === 'top' ? 'active' : ''}`}
                  onClick={() => setCropPosition('top')} type="button"
                  disabled={disabled || submitting}>Top</button>
                <button className={`toggle-btn ${cropPosition === 'bottom' ? 'active' : ''}`}
                  onClick={() => setCropPosition('bottom')} type="button"
                  disabled={disabled || submitting}>Bottom</button>
                <button className={`toggle-btn ${cropPosition === 'left' ? 'active' : ''}`}
                  onClick={() => setCropPosition('left')} type="button"
                  disabled={disabled || submitting}>Left</button>
                <button className={`toggle-btn ${cropPosition === 'right' ? 'active' : ''}`}
                  onClick={() => setCropPosition('right')} type="button"
                  disabled={disabled || submitting}>Right</button>
              </div>
              <span className="style-desc">
                {cropPosition === 'fit' ? 'Black bars, full video visible' :
                 cropPosition === 'center' ? 'Zoom from center, fills screen' :
                 cropPosition === 'top' ? 'Zoom from top edge, fills screen' :
                 cropPosition === 'bottom' ? 'Zoom from bottom edge, fills screen' :
                 cropPosition === 'left' ? 'Zoom from left edge, fills screen' :
                 'Zoom from right edge, fills screen'}
              </span>
            </div>
          )}
          <CaptionControls
            position={captionPosition}
            bgColor={captionBgColor}
            onPositionChange={setCaptionPosition}
            onBgColorChange={setCaptionBgColor}
            disabled={disabled || submitting}
          />
        </>
      )}

      <button
        type="submit"
        className="btn btn-primary btn-block"
        disabled={disabled || submitting || !topic.trim()}
      >
        {submitting ? (
          <span className="btn-loading">
            <span className="spinner" />
            Starting...
          </span>
        ) : (
          'Generate Video'
        )}
      </button>
    </form>
  );
}
