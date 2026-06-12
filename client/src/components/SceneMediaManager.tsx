import { useState, useEffect, useCallback } from 'react';
import { workflowApi } from '../api/workflow';
import type { ManualMediaInfo, WorkflowState } from '../types';

interface SceneMediaManagerProps {
  workflowId: string;
  scenes: Array<{ text: string; searchTerms: string[] }>;
  imagePrompts: string[];
  aspectRatio: '9:16' | '16:9';
  basePrompt: string;
  onContinue: () => void;
  onCancel: () => void;
}

function CopyBtn({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard not available */ }
  };
  return (
    <button className="smm-copy-btn" onClick={handleCopy} title="Copy to clipboard">
      {copied ? 'Copied!' : label}
    </button>
  );
}

export function SceneMediaManager({ workflowId, scenes, imagePrompts, aspectRatio, basePrompt, onContinue, onCancel }: SceneMediaManagerProps) {
  const [mediaItems, setMediaItems] = useState<ManualMediaInfo[]>([]);
  const [uploading, setUploading] = useState<number | null>(null);
  const [assembling, setAssembling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initItems = useCallback((): ManualMediaInfo[] =>
    scenes.map((s, i) => ({
      sceneIndex: i,
      sceneText: s.text,
      imagePrompt: imagePrompts[i] || s.text,
      mediaStatus: 'missing' as const,
    })),
  [scenes, imagePrompts]);

  const fetchMedia = useCallback(async () => {
    try {
      const wf = await workflowApi.getWorkflow(workflowId);
      if (wf.manual_media && wf.manual_media.length > 0) {
        setMediaItems(wf.manual_media);
      } else {
        setMediaItems(initItems());
      }
    } catch {
      setMediaItems(initItems());
    }
  }, [workflowId, initItems]);

  useEffect(() => {
    fetchMedia();
  }, [fetchMedia]);

  const handleUpload = async (sceneIndex: number, file: File | null) => {
    if (!file) return;
    setUploading(sceneIndex);
    setError(null);
    try {
      await workflowApi.uploadMedia(workflowId, sceneIndex, file);
      await fetchMedia();
    } catch (err) {
      setError(`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setUploading(null);
    }
  };

  const handleAssemble = async () => {
    setAssembling(true);
    setError(null);
    try {
      await workflowApi.assemble(workflowId);
      onContinue();
    } catch (err) {
      setError(`Assembly failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setAssembling(false);
    }
  };

  const uploadedCount = mediaItems.filter(m => m.mediaStatus === 'uploaded').length;
  const totalCount = mediaItems.length || scenes.length;

  const items = mediaItems.length > 0 ? mediaItems : initItems();

  return (
    <div className="scene-media-manager">
      <div className="smm-header">
        <h4>Upload Media Per Scene</h4>
        <p className="smm-summary">
          <strong>{uploadedCount}/{totalCount}</strong> scene(s) have media
          {uploadedCount < totalCount && (
            <span className="smm-hint"> — Upload an image (.png, .jpg) or video (.mp4, .mov, .webm) for each scene</span>
          )}
        </p>
        <p className="smm-aspect">Aspect Ratio: <strong>{aspectRatio === '9:16' ? '9:16 Reels (1080x1920)' : '16:9 Landscape (1920x1080)'}</strong></p>
      </div>

      {basePrompt && (
        <div className="smm-base-prompt-box">
          <div className="smm-base-prompt-header">
            <strong>Step 1 — Character Base Prompt</strong>
            <CopyBtn text={basePrompt} label="Copy Base Prompt" />
          </div>
          <p className="smm-base-prompt-text">{basePrompt}</p>
          <p className="smm-base-prompt-hint">Paste this into your AI image generator first to create your consistent stickman character.</p>
        </div>
      )}

      {error && <div className="smm-error">{error}</div>}

      <div className="smm-scenes-grid">
        {items.map((item) => {
          const isReady = item.mediaStatus === 'uploaded';
          const isVideo = item.mediaType === 'video';
          return (
            <div key={item.sceneIndex} className={`smm-scene-card ${isReady ? 'ready' : 'missing'}`}>
              <div className="smm-scene-header">
                <span className="smm-scene-number">Scene {item.sceneIndex + 1}</span>
                <span className={`smm-scene-status ${isReady ? 'status-ready' : 'status-missing'}`}>
                  {isReady ? (item.mediaType === 'video' ? 'Video' : 'Image') : 'Missing'}
                </span>
              </div>
              <div className="smm-scene-prompt">
                <div className="smm-scene-prompt-header">
                  <strong>Image Prompt:</strong>
                  <CopyBtn text={item.imagePrompt} label="Copy" />
                </div>
                <p className="smm-scene-prompt-text">{item.imagePrompt}</p>
              </div>
              <div className={`smm-scene-preview ${aspectRatio === '16:9' ? 'landscape' : ''}`}>
                {isReady && item.mediaFileUrl ? (
                  isVideo ? (
                    <video
                      src={item.mediaFileUrl}
                      className="smm-thumbnail"
                      controls
                      preload="metadata"
                    />
                  ) : (
                    <img
                      src={item.mediaFileUrl}
                      alt={`Scene ${item.sceneIndex + 1}`}
                      className="smm-thumbnail"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  )
                ) : (
                  <div className="smm-no-media">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                  </div>
                )}
              </div>
              <p className="smm-scene-text" title={item.sceneText}>
                {item.sceneText}
              </p>
              <div className="smm-upload-area">
                <label className={`smm-upload-btn ${isReady ? 'smm-replace-btn' : ''}`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  {uploading === item.sceneIndex ? 'Uploading...' : isReady ? 'Replace' : 'Upload Media'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/jpg,video/mp4,video/quicktime,video/webm"
                    hidden
                    disabled={uploading === item.sceneIndex}
                    onChange={(e) => handleUpload(item.sceneIndex, e.target.files?.[0] || null)}
                  />
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <div className="smm-actions">
        <button
          className="btn btn-primary"
          onClick={handleAssemble}
          disabled={assembling || uploadedCount === 0}
        >
          {assembling ? (
            <span className="btn-loading">
              <span className="spinner" />
              Assembling Final Video...
            </span>
          ) : (
            'Assemble Final Video'
          )}
        </button>
        {uploadedCount > 0 && uploadedCount < totalCount && (
          <span className="smm-note">
            {totalCount - uploadedCount} scene(s) without media will use fallback background
          </span>
        )}
        {uploadedCount === 0 && (
          <span className="smm-note smm-note-warn">
            Upload at least one image or video to assemble
          </span>
        )}
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel Workflow
        </button>
      </div>
    </div>
  );
}
