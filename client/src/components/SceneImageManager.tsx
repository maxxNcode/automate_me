import { useState, useEffect, useCallback } from 'react';
import { workflowApi } from '../api/workflow';

interface SceneImageInfo {
  sceneIndex: number;
  text: string;
  status: 'generated' | 'manual_upload' | 'missing';
  fileUrl?: string;
  uploadedAt?: string;
}

interface SceneImageManagerProps {
  workflowId: string;
  scenes: Array<{ text: string; searchTerms: string[] }>;
  workflowStatus: string;
  onContinue: () => void;
  onCancel: () => void;
}

export function SceneImageManager({ workflowId, scenes, workflowStatus, onContinue, onCancel }: SceneImageManagerProps) {
  const [sceneImages, setSceneImages] = useState<SceneImageInfo[]>([]);
  const [uploading, setUploading] = useState<number | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSceneImages = useCallback(async () => {
    try {
      const data = await workflowApi.getSceneImages(workflowId);
      if (data && data.length > 0) {
        setSceneImages(data as SceneImageInfo[]);
      } else {
        // Build default from scenes
        setSceneImages(scenes.map((s, i) => ({
          sceneIndex: i,
          text: s.text,
          status: 'missing' as const,
        })));
      }
    } catch {
      // Build default from scenes
      setSceneImages(scenes.map((s, i) => ({
        sceneIndex: i,
        text: s.text,
        status: 'missing' as const,
      })));
    }
  }, [workflowId, scenes]);

  useEffect(() => {
    if (workflowStatus === 'awaiting_images') {
      fetchSceneImages();
    }
  }, [workflowStatus, fetchSceneImages]);

  const handleFileUpload = async (sceneIndex: number, file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Please upload a PNG or JPEG image file');
      return;
    }
    setUploading(sceneIndex);
    setError(null);
    try {
      await workflowApi.uploadSceneImage(workflowId, sceneIndex, file);
      // Refresh scene list
      await fetchSceneImages();
    } catch (err) {
      setError(`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setUploading(null);
    }
  };

  const handleContinue = async () => {
    setContinuing(true);
    setError(null);
    try {
      await workflowApi.continueToVideo(workflowId);
      onContinue();
    } catch (err) {
      setError(`Failed to continue: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setContinuing(false);
    }
  };

  const generatedCount = sceneImages.filter(si => si.status === 'generated' || si.status === 'manual_upload').length;
  const totalCount = sceneImages.length || scenes.length;

  if (workflowStatus !== 'awaiting_images') return null;

  return (
    <div className="scene-image-manager">
      <div className="sim-header">
        <h4>🎨 Scene Images — Manual Review</h4>
        <p className="sim-summary">
          <strong>{generatedCount}/{totalCount}</strong> scene image(s) available
          {generatedCount < totalCount && (
            <span className="sim-hint"> — Upload images for missing scenes below, then click "Continue to Video"</span>
          )}
        </p>
      </div>

      {error && <div className="sim-error">{error}</div>}

      <div className="sim-scenes-grid">
        {(sceneImages.length > 0 ? sceneImages : scenes.map((s, i) => ({
          sceneIndex: i,
          text: s.text,
          status: 'missing' as const,
          fileUrl: undefined,
        } as SceneImageInfo))).map((si) => {
          const isReady = si.status === 'generated' || si.status === 'manual_upload';
          return (
            <div key={si.sceneIndex} className={`sim-scene-card ${isReady ? 'ready' : 'missing'}`}>
              <div className="sim-scene-header">
                <span className="sim-scene-number">Scene {si.sceneIndex + 1}</span>
                <span className={`sim-scene-status ${isReady ? 'status-ready' : 'status-missing'}`}>
                  {isReady ? (si.status === 'manual_upload' ? '📤 Manual' : '✅ Generated') : '❌ Missing'}
                </span>
              </div>
              <div className="sim-scene-preview">
                {si.fileUrl ? (
                  <img
                    src={si.fileUrl}
                    alt={`Scene ${si.sceneIndex + 1}`}
                    className="sim-thumbnail"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <div className="sim-no-image">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                  </div>
                )}
              </div>
              <p className="sim-scene-text" title={si.text}>
                {si.text.length > 80 ? si.text.slice(0, 80) + '...' : si.text}
              </p>
              <div className="sim-upload-area">
                <label className={`sim-upload-btn ${isReady ? 'sim-replace-btn' : ''}`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  {uploading === si.sceneIndex ? 'Uploading...' : isReady ? 'Replace' : 'Upload Image'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    hidden
                    disabled={uploading === si.sceneIndex}
                    onChange={(e) => handleFileUpload(si.sceneIndex, e.target.files?.[0] || null)}
                  />
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <div className="sim-actions">
        <button
          className="btn btn-primary"
          onClick={handleContinue}
          disabled={continuing || generatedCount === 0}
        >
          {continuing ? 'Assembling Video...' : 'Continue to Video'}
        </button>
        {generatedCount > 0 && generatedCount < totalCount && (
          <span className="sim-note">
            {totalCount - generatedCount} scene(s) without images will use fallback background
          </span>
        )}
        {generatedCount === 0 && (
          <span className="sim-note sim-note-warn">
            At least one image needed to continue. Upload images above.
          </span>
        )}
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel Workflow
        </button>
      </div>
    </div>
  );
}
