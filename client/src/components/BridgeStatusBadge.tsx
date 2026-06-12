import { useState, useEffect, useCallback } from 'react';

const API_BASE = 'http://localhost:3001';

type BridgeStatus = 'ready' | 'no_extension' | 'gemini_tab_not_open' | 'not_signed_in' | 'popup_busy' | 'no_bridge' | 'unavailable' | 'checking' | 'unknown';

interface BridgeStatusInfo {
  status: BridgeStatus;
  label: string;
  detail: string;
  color: 'green' | 'yellow' | 'red' | 'gray';
  icon: string;
}

const STATUS_MAP: Record<string, BridgeStatusInfo> = {
  ready: {
    status: 'ready',
    label: 'Extension Ready',
    detail: 'Gemini extension is connected and signed in',
    color: 'green',
    icon: '🟢',
  },
  no_extension: {
    status: 'no_extension',
    label: 'No Extension Ping',
    detail: 'Gemini extension hasn\'t pinged the server in 30s',
    color: 'red',
    icon: '🔴',
  },
  gemini_tab_not_open: {
    status: 'gemini_tab_not_open',
    label: 'Gemini Tab Not Open',
    detail: 'Open https://gemini.google.com/app and sign in',
    color: 'yellow',
    icon: '🟡',
  },
  not_signed_in: {
    status: 'not_signed_in',
    label: 'Not Signed In',
    detail: 'Sign in to Google on the Gemini tab',
    color: 'yellow',
    icon: '🟡',
  },
  popup_busy: {
    status: 'popup_busy',
    label: 'Popup Mode Active',
    detail: 'Popup batch is running — bridge mode paused',
    color: 'yellow',
    icon: '🟡',
  },
  no_bridge: {
    status: 'no_bridge',
    label: 'Bridge Not Initialized',
    detail: 'Gemini bridge service has not been initialized on the server',
    color: 'red',
    icon: '🔴',
  },
  unavailable: {
    status: 'unavailable',
    label: 'Server Unavailable',
    detail: 'Cannot reach the backend server at localhost:3001',
    color: 'red',
    icon: '🔴',
  },
  checking: {
    status: 'checking',
    label: 'Checking...',
    detail: 'Querying bridge status',
    color: 'gray',
    icon: '⏳',
  },
  unknown: {
    status: 'unknown',
    label: 'Unknown',
    detail: 'Bridge status unknown',
    color: 'gray',
    icon: '❓',
  },
};

async function fetchBridgeConnection(): Promise<BridgeStatus> {
  const res = await fetch(`${API_BASE}/api/system/gemini-connection`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return 'unavailable';
  const data = await res.json();
  if (data?.success && data?.data?.status) {
    return data.data.status as BridgeStatus;
  }
  return 'unknown';
}

export function BridgeStatusBadge() {
  const [bridgeInfo, setBridgeInfo] = useState<BridgeStatusInfo>(STATUS_MAP.checking);
  const [expanded, setExpanded] = useState(false);

  const checkStatus = useCallback(async () => {
    try {
      const status = await fetchBridgeConnection();
      setBridgeInfo(STATUS_MAP[status] || STATUS_MAP.unknown);
    } catch {
      setBridgeInfo(STATUS_MAP.unavailable);
    }
  }, []);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 15000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  const handleClick = () => {
    if (bridgeInfo.status === 'gemini_tab_not_open' || bridgeInfo.status === 'not_signed_in' || bridgeInfo.status === 'no_extension') {
      window.open('https://gemini.google.com/app', '_blank');
    }
    setExpanded(!expanded);
  };

  const colorClass = bridgeInfo.color;

  return (
    <div className={`bridge-status-badge ${colorClass} ${expanded ? 'expanded' : ''}`}>
      <button className="bridge-status-trigger" onClick={handleClick} title={bridgeInfo.detail}>
        <span className="bridge-status-icon">{bridgeInfo.icon}</span>
        <span className="bridge-status-label">{bridgeInfo.label}</span>
        <svg className="bridge-status-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {expanded && (
        <div className="bridge-status-detail">
          <p>{bridgeInfo.detail}</p>
          {(bridgeInfo.status === 'gemini_tab_not_open' || bridgeInfo.status === 'not_signed_in') && (
            <button className="btn btn-sm btn-primary" onClick={() => window.open('https://gemini.google.com/app', '_blank')}>
              Open Gemini
            </button>
          )}
          {bridgeInfo.status === 'no_extension' && (
            <p className="hint">Make sure the geminiauto extension is loaded in Chrome (chrome://extensions)</p>
          )}
          <button className="btn btn-ghost btn-sm" onClick={checkStatus}>
            Check Again
          </button>
        </div>
      )}
    </div>
  );
}
