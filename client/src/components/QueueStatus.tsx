import { useEffect, useState, useCallback } from 'react';
import { queueApi, type QueueState } from '../api/auth';
import { useAuth } from '../auth/AuthContext';

export function QueueStatus() {
  const { user } = useAuth();
  const [queueState, setQueueState] = useState<QueueState | null>(null);
  const [error, setError] = useState(false);

  const fetchQueue = useCallback(async () => {
    try {
      const state = await queueApi.getState();
      setQueueState(state);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, 3000);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  // Don't show anything if queue is empty
  if (!queueState || queueState.queueLength === 0) return null;

  const userEntry = queueState.queue.find(e => e.username === user?.username);
  const isCurrentlyGenerating = queueState.currentlyGenerating === user?.username;

  return (
    <div className={`queue-status ${isCurrentlyGenerating ? 'generating' : ''}`}>
      <div className="queue-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
        <span className="queue-title">Generation Queue</span>
        {queueState.queueLength > 0 && (
          <span className="queue-count">{queueState.queueLength}</span>
        )}
      </div>

      <div className="queue-body">
        {/* Currently generating */}
        {queueState.currentlyGenerating && (
          <div className="queue-current">
            <div className="queue-current-dot" />
            <div className="queue-current-info">
              <span className="queue-current-label">
                {queueState.currentlyGenerating === user?.username
                  ? 'You are generating now'
                  : `${queueState.currentlyGenerating} is generating`}
              </span>
              <span className="queue-current-topic">
                {queueState.queue[0]?.topic || '...'}
              </span>
            </div>
          </div>
        )}

        {/* User's position if waiting */}
        {userEntry && userEntry.status === 'waiting' && (
          <div className="queue-position">
            <div className="queue-position-badge">
              <span className="queue-position-number">#{userEntry.position}</span>
              <span className="queue-position-label">in queue</span>
            </div>
            <p className="queue-position-text">
              {queueState.currentlyGenerating
                ? `${queueState.currentlyGenerating} is currently generating. Please wait...`
                : 'Waiting for your turn...'}
            </p>
          </div>
        )}

        {/* Full queue list (collapsed preview) */}
        {queueState.queue.length > 1 && (
          <div className="queue-list">
            {queueState.queue.slice(0, 5).map((entry) => (
              <div
                key={entry.id}
                className={`queue-item ${
                  entry.username === user?.username ? 'queue-item-mine' : ''
                } ${entry.status === 'running' ? 'queue-item-running' : ''}`}
              >
                <span className={`queue-item-dot ${entry.status}`} />
                <span className="queue-item-name">{entry.username}</span>
                <span className="queue-item-topic">{entry.topic.slice(0, 30)}</span>
                <span className={`queue-item-status ${entry.status}`}>
                  {entry.status === 'running' ? 'Generating' : `#${entry.position}`}
                </span>
              </div>
            ))}
            {queueState.queue.length > 5 && (
              <div className="queue-more">
                +{queueState.queue.length - 5} more
              </div>
            )}
          </div>
        )}

        {/* Waiting counts */}
        {!userEntry && queueState.queueLength > 0 && (
          <p className="queue-note">
            {queueState.queueLength} video{queueState.queueLength !== 1 ? 's' : ''} queued
          </p>
        )}
      </div>
    </div>
  );
}
