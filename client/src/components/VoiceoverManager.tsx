import { useState, useRef, useCallback } from 'react';
import { workflowApi } from '../api/workflow';

interface VoiceoverManagerProps {
  workflowId: string;
  onContinue: () => void;
  onCancel: () => void;
}

const AMERICAN_ENGLISH_VOICES = [
  // Female voices
  { id: 'af_heart', label: 'Heart', gender: 'female', desc: 'Warm, expressive — best all-rounder' },
  { id: 'af_bella', label: 'Bella', gender: 'female', desc: 'Friendly, natural' },
  { id: 'af_sarah', label: 'Sarah', gender: 'female', desc: 'Calm, clear' },
  { id: 'af_nicole', label: 'Nicole', gender: 'female', desc: 'Energetic' },
  { id: 'af_sky', label: 'Sky', gender: 'female', desc: 'Soft, gentle' },
  { id: 'af_river', label: 'River', gender: 'female', desc: 'Smooth, flowing' },
  { id: 'af_nova', label: 'Nova', gender: 'female', desc: 'Bright, modern' },
  { id: 'af_alloy', label: 'Alloy', gender: 'female', desc: 'Deep, rich' },
  { id: 'af_jessica', label: 'Jessica', gender: 'female', desc: 'Casual' },
  { id: 'af_kore', label: 'Kore', gender: 'female', desc: 'Neutral' },
  // Male voices
  { id: 'am_adam', label: 'Adam', gender: 'male', desc: 'Natural, balanced' },
  { id: 'am_michael', label: 'Michael', gender: 'male', desc: 'Deep, authoritative' },
  { id: 'am_liam', label: 'Liam', gender: 'male', desc: 'Friendly' },
  { id: 'am_echo', label: 'Echo', gender: 'male', desc: 'Warm' },
  { id: 'am_eric', label: 'Eric', gender: 'male', desc: 'Clear' },
  { id: 'am_onyx', label: 'Onyx', gender: 'male', desc: 'Deep, resonant' },
  { id: 'am_fenrir', label: 'Fenrir', gender: 'male', desc: 'Low, gravelly' },
  { id: 'am_puck', label: 'Puck', gender: 'male', desc: 'Playful' },
  { id: 'am_santa', label: 'Santa', gender: 'male', desc: 'Jolly, deep' },
];

const FEMALE_VOICES = AMERICAN_ENGLISH_VOICES.filter(v => v.gender === 'female');
const MALE_VOICES = AMERICAN_ENGLISH_VOICES.filter(v => v.gender === 'male');

export function VoiceoverManager({ workflowId, onContinue, onCancel }: VoiceoverManagerProps) {
  const [generating, setGenerating] = useState<'kokoro' | 'edge-tts' | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedVoice, setSelectedVoice] = useState('af_heart');
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [playBlocked, setPlayBlocked] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playingRef = useRef(false);

  const handlePlayClick = useCallback(() => {
    // Called directly from user click on the retry button
    // User gesture is fresh here — play() will work
    if (!audioRef.current?.src) return;
    audioRef.current.play().then(() => {
      playingRef.current = true;
      setPreviewState('playing');
      setPlayBlocked(false);
    }).catch(() => {
      // Still blocked — keep the button visible
    });
  }, []);

  const handlePreview = useCallback(async () => {
    if (previewState === 'loading') return;

    // Stop any current playback
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
    playingRef.current = false;
    setPlayBlocked(false);
    setPreviewUrl(null);

    // ═══════════════════════════════════════════════
    // Create Audio element HERE (synchronous in click handler)
    // BEFORE any async/await. This consumes the user gesture
    // so the browser grants audio playback permission.
    // ═══════════════════════════════════════════════
    const audio = new Audio();
    audio.preload = 'auto';
    audioRef.current = audio;

    setPreviewState('loading');
    setError(null);

    try {
      const result = await workflowApi.previewVoice(selectedVoice);

      if (!result.url) {
        setPreviewState('error');
        setError('Preview returned no URL');
        return;
      }

      audio.src = result.url;
      setPreviewUrl(result.url);

      audio.onended = () => {
        playingRef.current = false;
        setPreviewState('idle');
      };

      audio.onerror = () => {
        playingRef.current = false;
        setPreviewState('error');
        setError('Failed to play audio preview');
      };

      // Safety timeout: reset after 15s (preview is ~6-8s)
      previewTimeoutRef.current = setTimeout(() => {
        if (playingRef.current) {
          playingRef.current = false;
          setPreviewState('idle');
        }
      }, 15000);

      await audio.play();
      playingRef.current = true;
      setPreviewState('playing');
    } catch (err) {
      playingRef.current = false;
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        // Pre-warming failed or browser still blocked — show retry button
        setPreviewState('error');
        setPlayBlocked(true);
      } else {
        setPreviewState('error');
        setError(`Preview failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }
  }, [selectedVoice, previewState]);

  const selectedVoiceData = AMERICAN_ENGLISH_VOICES.find(v => v.id === selectedVoice);

  const handleGenerate = async (engine: 'kokoro' | 'edge-tts') => {
    setGenerating(engine);
    setError(null);
    try {
      const result = engine === 'kokoro'
        ? await workflowApi.generateVoiceover(workflowId, 'kokoro', selectedVoice)
        : await workflowApi.generateVoiceover(workflowId, 'edge-tts');

      if (result.success) {
        onContinue();
      } else {
        setError(result.error || 'Voiceover generation failed');
      }
    } catch (err) {
      setError(`Generation failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setGenerating(null);
    }
  };

  const handleUpload = async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith('audio/')) {
      setError('Please upload an audio file (.wav, .mp3, .m4a)');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const result = await workflowApi.uploadVoiceover(workflowId, file);
      if (result.success) {
        onContinue();
      } else {
        setError(result.error || 'Upload failed');
      }
    } catch (err) {
      setError(`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="voiceover-manager">
      <div className="vm-header">
        <h4>🎤 Voiceover — Choose your option</h4>
        <p className="vm-subtitle">
          Generate a voiceover with AI text-to-speech, or upload your own recording.
        </p>
      </div>

      {error && <div className="vm-error">{error}</div>}
      {playBlocked && previewUrl && (
        <div className="vm-blocked-banner">
          <span>🔇 Browser blocked autoplay —</span>
          <button className="vm-retry-btn" onClick={handlePlayClick}>
            ▶ Click to Play Preview
          </button>
        </div>
      )}

      <div className="vm-options">
        {/* Generate with Kokoro */}
        <div className="vm-card vm-card-kokoro">
          <div className="vm-card-header">
            <span className="vm-card-icon">🎙️</span>
            <span className="vm-card-title">Kokoro-82M AI</span>
            <span className="vm-card-badge">Best quality</span>
          </div>
          <p className="vm-card-desc">
            Natural-sounding AI voiceover using Kokoro-82M model. Warm, expressive narration — great for storytelling.
          </p>

          {/* Voice Picker */}
          <div className="vp-picker">
            <label className="vp-label">Select Voice</label>
            <div className="vp-dropdown-wrapper">
              <select
                className="vp-select"
                value={selectedVoice}
                onChange={(e) => {
                  setSelectedVoice(e.target.value);
                  // Stop any playing preview
                  if (audioRef.current) {
                    audioRef.current.pause();
                    audioRef.current = null;
                  }
                  if (previewTimeoutRef.current) {
                    clearTimeout(previewTimeoutRef.current);
                    previewTimeoutRef.current = null;
                  }
                  setPreviewState('idle');
                  setPlayBlocked(false);
                  setPreviewUrl(null);
                }}
                disabled={generating !== null}
              >
                <optgroup label="— Female Voices —">
                  {FEMALE_VOICES.map(v => (
                    <option key={v.id} value={v.id}>
                      {v.label} ({v.id}) — {v.desc}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="— Male Voices —">
                  {MALE_VOICES.map(v => (
                    <option key={v.id} value={v.id}>
                      {v.label} ({v.id}) — {v.desc}
                    </option>
                  ))}
                </optgroup>
              </select>
              <div className="vp-voice-badge" data-gender={selectedVoiceData?.gender}>
                {selectedVoiceData?.gender === 'female' ? '♀' : '♂'} {selectedVoiceData?.label || selectedVoice}
              </div>
            </div>

            {/* Preview + Generate row */}
            <div className="vp-actions-row">
              <button
                className="vp-preview-btn"
                onClick={handlePreview}
                disabled={generating !== null || previewState === 'loading'}
                title="Play a short preview of this voice"
              >
                {previewState === 'loading' ? (
                  <><span className="spinner" style={{ width: 14, height: 14 }} /> Loading...</>
                ) : previewState === 'playing' ? (
                  <><span className="vp-pulse-icon" /> Playing...</>
                ) : (
                  <><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg> Preview</>
                )}
              </button>
              <button
                className="btn btn-primary btn-sm vp-generate-btn"
                onClick={() => handleGenerate('kokoro')}
                disabled={generating !== null}
              >
                {generating === 'kokoro' ? (
                  <span className="btn-loading">
                    <span className="spinner" />
                    Generating...
                  </span>
                ) : (
                  'Generate with Kokoro'
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Generate with Edge TTS */}
        <div className="vm-card">
          <div className="vm-card-header">
            <span className="vm-card-icon">🔊</span>
            <span className="vm-card-title">Edge TTS</span>
            <span className="vm-card-badge vm-badge-fallback">Fallback</span>
          </div>
          <p className="vm-card-desc">
            Microsoft Edge cloud TTS — fast, free. No model download needed.
            Good fallback if Kokoro fails.
          </p>
          <div className="vm-card-voices">
            <small>Voice: en-US-AriaNeural (female)</small>
          </div>
          <button
            className="btn btn-secondary btn-block btn-sm"
            onClick={() => handleGenerate('edge-tts')}
            disabled={generating !== null}
          >
            {generating === 'edge-tts' ? (
              <span className="btn-loading">
                <span className="spinner" />
                Generating Edge TTS...
              </span>
            ) : (
              'Generate with Edge TTS'
            )}
          </button>
        </div>

        {/* Upload */}
        <div className="vm-card vm-upload-card">
          <div className="vm-card-header">
            <span className="vm-card-icon">📤</span>
            <span className="vm-card-title">Upload Recording</span>
            <span className="vm-card-badge vm-badge-custom">Custom</span>
          </div>
          <p className="vm-card-desc">
            Record your own voiceover or use a professional recording.
            .wav, .mp3, .m4a (max 100MB).
          </p>
          <label className="vm-upload-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            {uploading ? 'Uploading...' : 'Choose Audio File'}
            <input
              type="file"
              accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac"
              hidden
              disabled={uploading}
              onChange={(e) => handleUpload(e.target.files?.[0] || null)}
            />
          </label>
        </div>
      </div>

      <div className="vm-actions">
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel Workflow
        </button>
      </div>
    </div>
  );
}
