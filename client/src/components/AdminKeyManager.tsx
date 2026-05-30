import { useState, useEffect, useCallback } from 'react';
import { authApi, type AccessKey, type RegisteredUser } from '../api/auth';
import { useAuth } from '../auth/AuthContext';

export function AdminKeyManager() {
  const { user } = useAuth();
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [users, setUsers] = useState<RegisteredUser[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [newKeyRole, setNewKeyRole] = useState<'user' | 'admin'>('user');
  const [generating, setGenerating] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [keyList, userList] = await Promise.all([
        authApi.listKeys(),
        authApi.listUsers(),
      ]);
      setKeys(keyList);
      setUsers(userList);
    } catch {}
  }, []);

  useEffect(() => {
    if (expanded) fetchData();
  }, [expanded, fetchData]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      await authApi.generateKey(newKeyLabel || undefined, newKeyRole);
      setNewKeyLabel('');
      await fetchData();
    } catch {}
    setGenerating(false);
  };

  const handleDelete = async (key: string) => {
    try {
      await authApi.deleteKey(key);
      await fetchData();
    } catch {}
  };

  const handleCopy = (key: string) => {
    navigator.clipboard.writeText(key).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const availableKeys = keys.filter(k => !k.used_by);
  const usedKeys = keys.filter(k => k.used_by);

  return (
    <div className="admin-key-manager">
      <button
        className="admin-key-toggle"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <span>Access Keys</span>
        <span className="admin-key-count">{keys.length}</span>
        <span className={`chevron ${expanded ? 'open' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {expanded && (
        <div className="admin-key-body">
          {/* Generate new key */}
          <div className="admin-key-generate">
            <input
              type="text"
              placeholder="Label (optional)"
              value={newKeyLabel}
              onChange={e => setNewKeyLabel(e.target.value)}
              className="admin-key-input"
              maxLength={40}
            />
            <div className="admin-key-role-select">
              <button
                className={`role-btn ${newKeyRole === 'user' ? 'active' : ''}`}
                onClick={() => setNewKeyRole('user')}
                type="button"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                User
              </button>
              <button
                className={`role-btn ${newKeyRole === 'admin' ? 'active' : ''}`}
                onClick={() => setNewKeyRole('admin')}
                type="button"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </button>
            </div>
            <button
              className="btn btn-sm btn-primary"
              onClick={handleGenerate}
              disabled={generating}
            >
              {generating ? 'Generating...' : 'Generate'}
            </button>
          </div>

          {/* Available keys */}
          {availableKeys.length > 0 && (
            <div className="admin-key-section">
              <h4>Available ({availableKeys.length})</h4>
              <div className="admin-key-items">
                {availableKeys.map(k => (
                  <div key={k.key} className="admin-key-item">
                    <code className="admin-key-code">{k.key}</code>
                    <span className={`role-badge ${k.role}`}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="role-badge-icon">
                        {k.role === 'admin' ? (
                          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        ) : (
                          <><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>
                        )}
                      </svg>
                      {k.role === 'admin' ? 'Admin' : 'User'}
                    </span>
                    {k.label && <span className="admin-key-label">{k.label}</span>}
                    <div className="admin-key-actions">
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => handleCopy(k.key)}
                      >
                        {copiedKey === k.key ? 'Copied!' : 'Copy'}
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => handleDelete(k.key)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Used keys */}
          {usedKeys.length > 0 && (
            <div className="admin-key-section">
              <h4>Used ({usedKeys.length})</h4>
              <div className="admin-key-items">
                {usedKeys.map(k => (
                  <div key={k.key} className="admin-key-item used">
                    <code className="admin-key-code">{k.key}</code>
                    <span className={`role-badge ${k.role}`}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="role-badge-icon">
                        {k.role === 'admin' ? (
                          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        ) : (
                          <><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>
                        )}
                      </svg>
                      {k.role === 'admin' ? 'Admin' : 'User'}
                    </span>
                    <span className="admin-key-used-by">{k.used_by}</span>
                    <div className="admin-key-actions">
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => handleDelete(k.key)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Registered users */}
          {users.length > 0 && (
            <div className="admin-key-section">
              <h4>Registered Users ({users.length})</h4>
              <div className="admin-key-items">
                {users.map(u => (
                  <div key={u.username} className="admin-key-item user">
                    <span className="admin-user-name">{u.username}</span>
                    <span className="admin-user-seen">
                      {u.last_seen
                        ? `Last seen: ${new Date(u.last_seen).toLocaleDateString()}`
                        : 'Never seen'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(availableKeys.length === 0 && usedKeys.length === 0 && users.length === 0) && (
            <p className="admin-key-empty">No keys yet. Generate one to share with friends.</p>
          )}
        </div>
      )}
    </div>
  );
}
