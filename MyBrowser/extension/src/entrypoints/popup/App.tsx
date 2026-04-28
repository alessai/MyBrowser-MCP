import { useState, useEffect, useCallback } from 'react';
import { sendToBackground } from '../../lib/messaging';
import { getStorageAll, setStorageAll, type StorageSchema } from '../../lib/storage';
import type { WsStatusResponse } from '../../lib/protocol';

type View = 'main' | 'settings';

type StatusInfo = WsStatusResponse;

const STATE_LABELS: Record<StatusInfo['state'], string> = {
  CONNECTED: 'Connected',
  CONNECTING: 'Connecting',
  AUTHENTICATING: 'Authenticating',
  DISCONNECTED: 'Disconnected',
};

const STATE_COLORS: Record<StatusInfo['state'], string> = {
  CONNECTED: 'var(--color-green)',
  CONNECTING: 'var(--color-yellow)',
  AUTHENTICATING: 'var(--color-yellow)',
  DISCONNECTED: 'var(--color-red)',
};

interface AnnotationInfo {
  hotkey: string | null;
  pending: number | null;
  archived: number | null;
  error: string | null;
}

export default function App() {
  const [view, setView] = useState<View>('main');
  const [status, setStatus] = useState<StatusInfo>({ state: 'DISCONNECTED' });
  const [settings, setSettings] = useState<StorageSchema>({
    serverAddress: '',
    serverPort: 9009,
    authToken: '',
    browserName: '',
  });
  const [showToken, setShowToken] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [annotation, setAnnotation] = useState<AnnotationInfo | null>(null);
  const [diagnosticsResult, setDiagnosticsResult] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await sendToBackground<WsStatusResponse>('ws_status');
      setStatus({ state: res.state });
    } catch {
      setStatus({ state: 'DISCONNECTED' });
    }
  }, []);

  const fetchAnnotation = useCallback(async () => {
    try {
      const res = await sendToBackground<AnnotationInfo>('get_annotation_info');
      setAnnotation(res);
    } catch {
      setAnnotation(null);
    }
  }, []);

  useEffect(() => {
    getStorageAll().then(setSettings);
    // Initial fetch on mount.
    fetchStatus();
    fetchAnnotation();

    // Passive freshness: poll every 10 s — but only while the popup is
    // actually visible. A pinned popup or a hidden popup (which Chrome
    // keeps alive in some configurations) will NOT keep burning WS
    // round-trips. Was previously 2 s unconditional, which meant 30
    // RT/min per open popup.
    let interval: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (interval !== null) return;
      interval = setInterval(() => {
        fetchStatus();
        fetchAnnotation();
      }, 10_000);
    };
    const stopPolling = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Refresh immediately on visibility change, then resume polling.
        fetchStatus();
        fetchAnnotation();
        startPolling();
      } else {
        stopPolling();
      }
    };
    if (document.visibilityState === "visible") startPolling();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopPolling();
    };
  }, [fetchStatus, fetchAnnotation]);

  const handleRefreshAnnotation = () => {
    fetchAnnotation();
  };

  const openShortcutsPage = () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await setStorageAll(settings);
      await sendToBackground('ws_reconnect');
      setView('main');
    } catch (e) {
      console.error('Save failed:', e);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTestResult('Testing...');
    try {
      const res = await sendToBackground<WsStatusResponse>('ws_status');
      setTestResult(`State: ${STATE_LABELS[res.state]}`);
    } catch (e) {
      setTestResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleCopyDiagnostics = async () => {
    setDiagnosticsResult('Collecting diagnostics...');
    try {
      const diagnostics = await sendToBackground<Record<string, unknown>>('get_diagnostics');
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setDiagnosticsResult('Diagnostics copied');
      setTimeout(() => setDiagnosticsResult(null), 2500);
    } catch (e) {
      setDiagnosticsResult(`Diagnostics failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (view === 'settings') {
    return (
      <div className="popup">
        <header>
          <button className="back-btn" onClick={() => { setView('main'); setTestResult(null); }}>
            ← Back
          </button>
          <h1>Settings</h1>
        </header>

        <div className="settings-form">
          <label>
            Server Address
            <input
              type="text"
              value={settings.serverAddress}
              onChange={(e) => setSettings({ ...settings, serverAddress: e.target.value })}
              placeholder="e.g. 100.64.0.1"
            />
          </label>

          <label>
            Port
            <input
              type="number"
              value={settings.serverPort}
              onChange={(e) => setSettings({ ...settings, serverPort: Number(e.target.value) })}
              placeholder="9009"
            />
          </label>

          <label>
            Browser Name
            <input
              type="text"
              value={settings.browserName}
              onChange={(e) => setSettings({ ...settings, browserName: e.target.value })}
              placeholder="e.g. Windows-Chrome"
            />
          </label>

          <label>
            Auth Token
            <div className="token-input">
              <input
                type={showToken ? 'text' : 'password'}
                value={settings.authToken}
                onChange={(e) => setSettings({ ...settings, authToken: e.target.value })}
                placeholder="Enter token"
              />
              <button
                className="toggle-btn"
                onClick={() => setShowToken(!showToken)}
                type="button"
              >
                {showToken ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>

          <div className="btn-row">
            <button className="btn btn-secondary" onClick={handleTest}>
              Test Connection
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>

          {testResult && (
            <div className={`test-result ${testResult.startsWith('Error') ? 'error' : ''}`}>
              {testResult}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="popup">
      <header>
        <h1>MyBrowser</h1>
        <span className="version">v1.1.0</span>
      </header>

      <div className="status-section">
        <div className="status-row">
          <span
            className="status-dot"
            style={{ backgroundColor: STATE_COLORS[status.state] }}
          />
          <span className="status-label">{STATE_LABELS[status.state]}</span>
        </div>

        <div className="info-grid">
          <div className="info-item">
            <span className="info-label">Server</span>
            <span className="info-value">
              {settings.serverAddress || '—'}
              {settings.serverPort ? `:${settings.serverPort}` : ''}
            </span>
          </div>

          <div className="info-item">
            <span className="info-label">Browser</span>
            <span className="info-value">
              {settings.browserName || '—'}
            </span>
          </div>

          <div className="info-item">
            <span className="info-label">Port</span>
            <span className="info-value">
              {settings.serverPort || '—'}
            </span>
          </div>

          <div className="info-item">
            <span className="info-label">Auth Token</span>
            <span className="info-value">
              {settings.authToken ? 'Configured' : 'Missing'}
            </span>
          </div>
        </div>
      </div>

      <section
        className="annotation-section"
        aria-label="Annotation notes"
      >
        <div className="annotation-section-row">
          <span className="annotation-section-title">Annotation notes</span>
          <div className="annotation-section-actions">
            {/* Dedicated status node wraps ONLY the changing text so
                screen readers announce just the new value when it changes.
                aria-atomic makes the announcement whole-badge instead of
                character-diff. role=status is the semantic equivalent of
                aria-live=polite + aria-atomic, kept explicit for clarity. */}
            <span
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className={
                'annotation-badge' +
                ((annotation?.pending ?? 0) > 0 ? ' annotation-badge--active' : '')
              }
            >
              {annotation?.error
                ? '—'
                : annotation?.pending != null
                  ? `${annotation.pending} pending`
                  : '…'}
            </span>
            <button
              type="button"
              className="annotation-refresh"
              onClick={handleRefreshAnnotation}
              title="Refresh now"
              aria-label="Refresh annotation count"
            >
              ↻
            </button>
          </div>
        </div>

        <div className="annotation-meta">
          Hotkey:{' '}
          {annotation?.hotkey ? (
            <code>{annotation.hotkey}</code>
          ) : (
            <span className="annotation-hotkey-missing">not set</span>
          )}
          {' · '}
          <button
            type="button"
            className="annotation-meta-link"
            onClick={openShortcutsPage}
          >
            change
          </button>
        </div>

        {annotation?.error && (
          <div role="alert" className="annotation-error">
            Error: {annotation.error}
          </div>
        )}

        {annotation?.archived != null && annotation.archived > 0 && (
          <div className="annotation-meta-archived">
            {annotation.archived} archived
          </div>
        )}
      </section>

      <footer>
        <div className="footer-actions">
          <button className="btn btn-secondary" onClick={handleCopyDiagnostics}>
            Copy diagnostics
          </button>
          <button className="btn btn-primary" onClick={() => setView('settings')}>
            Settings
          </button>
        </div>
        {diagnosticsResult && (
          <div className={`diagnostics-result ${diagnosticsResult.includes('failed') ? 'error' : ''}`}>
            {diagnosticsResult}
          </div>
        )}
      </footer>
    </div>
  );
}
