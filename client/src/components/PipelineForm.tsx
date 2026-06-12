import { useState } from 'react';
import type { PipelineRequest } from '../types';
import { CaptionControls } from './CaptionControls';

interface PipelineFormProps {
  onSubmit: (topic: string, options: Partial<PipelineRequest>) => Promise<unknown>;
  disabled?: boolean;
}

export function PipelineForm({ onSubmit, disabled }: PipelineFormProps) {
  const [topic, setTopic] = useState('');
  const [aspectRatio, setAspectRatio] = useState<'9:16' | '16:9'>('9:16');
  const [footageSource, setFootageSource] = useState<'sidecar' | 'youtube_clips' | 'gemini_story' | 'manual_story'>('sidecar');
  const [captionPosition, setCaptionPosition] = useState<'top' | 'center' | 'bottom'>('bottom');
  const [captionBgColor, setCaptionBgColor] = useState<string>('black');
  const [cropPosition, setCropPosition] = useState<'fit' | 'center' | 'top' | 'bottom' | 'left' | 'right'>('center');
  const [storySceneCount, setStorySceneCount] = useState(15);
  const [tone, setTone] = useState<string>('educational');
  const [duration, setDuration] = useState(5);
  const [style, setStyle] = useState<string>('eye-catching');
  const [autoUpload, setAutoUpload] = useState(false);
  const [addSubtitles, setAddSubtitles] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim() || submitting) return;

    setSubmitting(true);
    try {
      await onSubmit(topic.trim(), {
        style: aspectRatio === '9:16' ? 'short' : 'tutorial',
        footage_source: footageSource,
        manual_mode: footageSource === 'manual_story',
        aspect_ratio: aspectRatio,
        story_scene_count: storySceneCount,
        tone: aspectRatio === '16:9' ? tone as PipelineRequest['tone'] : undefined,
        duration_minutes: aspectRatio === '16:9' ? duration : undefined,
        thumbnail_style: aspectRatio === '16:9' ? style as PipelineRequest['thumbnail_style'] : undefined,
        add_subtitles: aspectRatio === '16:9' ? addSubtitles : true,
        auto_upload: aspectRatio === '16:9' ? autoUpload : false,
        caption_position: aspectRatio === '9:16' ? captionPosition : undefined,
        caption_background_color: aspectRatio === '9:16' ? captionBgColor : undefined,
        crop_position: aspectRatio === '9:16' && footageSource === 'youtube_clips' ? cropPosition : undefined,
      });
      setTopic('');
    } catch (err) {
      console.error('Failed to start pipeline:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const isPortrait = aspectRatio === '9:16';

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

      <div className="form-group">
        <label>Aspect Ratio</label>
        <div className="style-toggle">
          <button
            type="button"
            className={`style-btn ${aspectRatio === '9:16' ? 'active' : ''}`}
            onClick={() => { setAspectRatio('9:16'); setFootageSource('youtube_clips'); }}
            disabled={disabled || submitting}
          >
            <svg className="style-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="2" width="18" height="20" rx="2" />
              <line x1="12" y1="18" x2="12" y2="18" />
            </svg>
            <span>Portrait 9:16</span>
            <span className="style-desc">Short / Reel</span>
          </button>
          <button
            type="button"
            className={`style-btn ${aspectRatio === '16:9' ? 'active' : ''}`}
            onClick={() => { setAspectRatio('16:9'); setFootageSource('sidecar'); }}
            disabled={disabled || submitting}
          >
            <svg className="style-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <polygon points="10 8 16 12 10 16 10 8" />
            </svg>
            <span>Landscape 16:9</span>
            <span className="style-desc">Widescreen</span>
          </button>
        </div>
      </div>

      <div className="form-group">
        <label>Footage Source</label>
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
          <button
            className={`toggle-btn ${footageSource === 'gemini_story' ? 'active' : ''}`}
            onClick={() => setFootageSource('gemini_story')}
            type="button"
            disabled={disabled || submitting}
            title="AI generates images via Gemini web interface"
          >
            🎨 Create Stickman Story
          </button>
          <button
            className={`toggle-btn ${footageSource === 'manual_story' ? 'active' : ''}`}
            onClick={() => setFootageSource('manual_story')}
            type="button"
            disabled={disabled || submitting}
            title="AI generates script + image prompts, you upload media per scene"
          >
            📤 Manual Media
          </button>
        </div>
      </div>

      {isPortrait ? (
        <>
          {footageSource === 'youtube_clips' && (
            <div className="form-group">
              <label>Crop Position</label>
              <div className="toggle-group">
                {(['fit', 'center', 'top', 'bottom', 'left', 'right'] as const).map(p => (
                  <button
                    key={p}
                    className={`toggle-btn ${cropPosition === p ? 'active' : ''}`}
                    onClick={() => setCropPosition(p)}
                    type="button"
                    disabled={disabled || submitting}
                  >
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
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
      ) : (
        <>
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
              <label htmlFor="duration">Duration (min)</label>
              <input
                id="duration"
                type="range"
                min={1}
                max={15}
                step={1}
                value={duration}
                onChange={e => setDuration(Number(e.target.value))}
                disabled={disabled || submitting}
                className="form-range"
              />
              <span className="range-value">{duration} min</span>
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
        </>
      )}

      {(footageSource === 'gemini_story' || footageSource === 'manual_story') && (
        <div className="form-group">
          <label htmlFor="storySceneCount">
            Story Length: <strong>{storySceneCount} scenes</strong>
          </label>
          <input
            id="storySceneCount"
            type="range"
            min={5}
            max={40}
            step={1}
            value={storySceneCount}
            onChange={e => setStorySceneCount(Number(e.target.value))}
            disabled={disabled || submitting}
            className="form-range"
          />
          <span className="range-value">{storySceneCount} scenes</span>
        </div>
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
