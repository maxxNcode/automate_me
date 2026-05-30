import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';

export function LoginScreen() {
  const { register, login, loading, error, clearError } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [accessKey, setAccessKey] = useState('');
  const [username, setUsername] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!accessKey.trim() || !username.trim()) return;

    setSubmitting(true);
    try {
      if (mode === 'register') {
        await register(accessKey.trim(), username.trim());
      } else {
        await login(accessKey.trim(), username.trim());
      }
    } catch {
      // Error is handled by AuthContext
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = () => {
    setMode(mode === 'login' ? 'register' : 'login');
    clearError();
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        {/* Logo */}
        <div className="login-logo">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
        </div>

        <h1 className="login-title">YouTube Auto</h1>
        <p className="login-subtitle">
          {mode === 'register'
            ? 'Enter your access key and choose a username to get started'
            : 'Sign in with your access key and username'}
        </p>

        {/* Error */}
        {error && (
          <div className="login-error">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-field">
            <label htmlFor="accessKey">Access Key</label>
            <input
              id="accessKey"
              type="text"
              placeholder="XXXX-XXXX-XXXX"
              value={accessKey}
              onChange={e => { setAccessKey(e.target.value); clearError(); }}
              className="login-input"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </div>

          <div className="login-field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              placeholder="Your name (letters, numbers, underscores)"
              value={username}
              onChange={e => { setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, '')); clearError(); }}
              className="login-input"
              maxLength={30}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={submitting || !accessKey.trim() || !username.trim()}
          >
            {submitting ? (
              <span className="btn-loading">
                <span className="spinner" />
                {mode === 'register' ? 'Signing up...' : 'Signing in...'}
              </span>
            ) : (
              mode === 'register' ? 'Join Studio' : 'Sign In'
            )}
          </button>
        </form>

        <div className="login-switch">
          {mode === 'register' ? (
            <span>
              Already have an account?{' '}
              <button className="login-link" onClick={switchMode} type="button">
                Sign in
              </button>
            </span>
          ) : (
            <span>
              Don't have a key yet?{' '}
              <button className="login-link" onClick={switchMode} type="button">
                Register
              </button>
            </span>
          )}
        </div>

        <div className="login-footer">
          <p>Ask the admin for an access key to join</p>
        </div>
      </div>
    </div>
  );
}
