import { useState, useEffect, useCallback } from 'react';
import {
  PushState, getPushState, subscribeToPush, unsubscribeFromPush, registerServiceWorker, isPushSupported,
} from './push';

interface Dip {
  ticker: string;
  name: string;
  price: number;
  ema12: number;
  pct: number;
  bucket: string;
  change: number | null;
  marketState: string | null;
  extendedPrice: number | null;
  pctExtended: number | null;
}

const LS_API = 'ema_mobile_api_base';
const LS_THRESHOLD = 'ema_mobile_threshold';
const LS_CACHE = 'ema_mobile_last_dips';

const DEFAULT_THRESHOLD = 15;

/** Guessing the desktop's LAN address is hopeless, so it's a setting. */
function loadApiBase(): string {
  try {
    const saved = localStorage.getItem(LS_API);
    if (saved) return saved;
  } catch { /* private mode */ }
  // Same-origin is right when the app is served by the desktop server itself.
  return window.location.origin;
}

function loadThreshold(): number {
  try {
    const v = Number(localStorage.getItem(LS_THRESHOLD));
    if (Number.isFinite(v) && v >= 1 && v <= 90) return v;
  } catch { /* ignore */ }
  return DEFAULT_THRESHOLD;
}

function bucketTone(pct: number): string {
  const a = Math.abs(pct);
  if (a >= 25) return 'crit';
  if (a >= 20) return 'high';
  if (a >= 15) return 'mid';
  if (a >= 10) return 'low';
  return 'flat';
}

export function App() {
  const [apiBase, setApiBase] = useState(loadApiBase);
  const [threshold, setThreshold] = useState(loadThreshold);
  const [dips, setDips] = useState<Dip[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [lastFailure, setLastFailure] = useState<string | null>(null);

  // ── Push state ──
  const refreshPushState = useCallback(async () => {
    setPush(await getPushState());
  }, []);

  useEffect(() => {
    if (isPushSupported()) registerServiceWorker().then(refreshPushState);
    else refreshPushState();
  }, [refreshPushState]);

  // ── Dip list ──
  const fetchDips = useCallback(async (base: string) => {
    setLoading(true);
    setError(null);
    // Without a timeout an unreachable server leaves the request hanging, so
    // the refresh button spins forever and looks like it does nothing. A dead
    // tunnel is the normal case here, not an edge case.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const resp = await fetch(`${base}/api/push/dips?min=5`, { signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // A wrong address usually still returns 200 — some other site's HTML.
      // Parsing that as JSON produces a baffling "Unexpected token '<'", so
      // check the content type and say what's actually wrong instead.
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error('that address is not the Stock Analyzer server');
      }
      const json = await resp.json();
      setDips(json.stocks || []);
      setLastUpdated(json.lastUpdated || null);
      setOffline(false);
      try { localStorage.setItem(LS_CACHE, JSON.stringify(json)); } catch { /* quota */ }
      return 'live' as const;
    } catch (err: any) {
      const reason = err?.name === 'AbortError'
        ? 'server did not respond within 12s'
        : err?.message || 'network error';
      // Falling back to cache is the normal case abroad — say so plainly rather
      // than showing an empty list that looks like "no dips".
      try {
        const raw = localStorage.getItem(LS_CACHE);
        if (raw) {
          const cached = JSON.parse(raw);
          setDips(cached.stocks || []);
          setLastUpdated(cached.lastUpdated || null);
          setOffline(true);
          setError(null);
          setLastFailure(reason);
          return 'cached' as const;
        }
      } catch { /* cache unreadable, fall through */ }

      setError(`Can't reach the server — ${reason}. Push alerts still work.`);
      setLastFailure(reason);
      return 'failed' as const;
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchDips(apiBase); }, [apiBase, fetchDips]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  /**
   * Manual refresh always says what happened. Silently falling back to cache
   * makes the button look broken — which is exactly how a dead tunnel felt.
   */
  const handleRefresh = async () => {
    const result = await fetchDips(apiBase);
    if (result === 'live') showToast('✅ Updated');
    else if (result === 'cached') showToast('📴 Server unreachable — showing cached list');
    else showToast('⚠️ Server unreachable');
  };

  const handleEnable = async () => {
    setBusy(true);
    const label = `${navigator.platform || 'Phone'} · ${new Date().toLocaleDateString()}`;
    const result = await subscribeToPush(apiBase, threshold, label);
    setBusy(false);
    await refreshPushState();
    showToast(result.ok ? '✅ Alerts enabled on this device' : `⚠️ ${result.error}`);
  };

  const handleDisable = async () => {
    setBusy(true);
    await unsubscribeFromPush(apiBase);
    setBusy(false);
    await refreshPushState();
    showToast('Alerts disabled on this device');
  };

  const handleTest = async () => {
    setBusy(true);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const resp = await fetch(`${apiBase}/api/push/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: push?.endpoint }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      const json = await resp.json();
      showToast(json.success ? '📨 Test sent — check your notifications' : `⚠️ ${json.error}`);
    } catch (err: any) {
      showToast(err?.name === 'AbortError'
        ? '⚠️ Server did not respond — is the tunnel running?'
        : `⚠️ ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const saveThreshold = async (value: number) => {
    setThreshold(value);
    try { localStorage.setItem(LS_THRESHOLD, String(value)); } catch { /* ignore */ }
    // Re-register so the server stores the new threshold for this device.
    if (push?.subscribed) {
      const label = `${navigator.platform || 'Phone'} · ${new Date().toLocaleDateString()}`;
      await subscribeToPush(apiBase, value, label);
      showToast(`Threshold updated to ${value}%`);
    }
  };

  const saveApiBase = (value: string) => {
    const clean = value.trim().replace(/\/+$/, '');
    setApiBase(clean);
    try { localStorage.setItem(LS_API, clean); } catch { /* ignore */ }
  };

  const visible = dips.filter(d => Math.abs(d.pct) >= threshold);
  const belowThreshold = dips.length - visible.length;

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>EMA Dips</h1>
          <div className="sub">
            {lastUpdated
              ? `${offline ? 'Cached ' : 'Updated '}${new Date(lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : 'No data yet'}
          </div>
        </div>
        <div className="header-actions">
          <button className="icon-btn" onClick={handleRefresh} disabled={loading} aria-label="Refresh">
            {loading ? '…' : '↻'}
          </button>
          <button className="icon-btn" onClick={() => setShowSettings(s => !s)} aria-label="Settings">⚙</button>
        </div>
      </header>

      {offline && (
        <div className="banner banner-warn">
          📴 Offline — showing the last list this phone downloaded. Push alerts still arrive.
          {lastFailure && <div className="small muted">({lastFailure})</div>}
        </div>
      )}
      {error && <div className="banner banner-error">{error}</div>}

      {/* Alert status */}
      <section className="card">
        <div className="row">
          <div>
            <div className="card-title">Phone alerts</div>
            <div className="card-sub">
              {!push?.supported
                ? push?.reason || 'Not supported'
                : push.subscribed
                  ? `On · notifying at ${threshold}% or deeper`
                  : push.permission === 'denied'
                    ? 'Blocked in Android settings'
                    : 'Off'}
            </div>
          </div>
          <span className={`pill ${push?.subscribed ? 'pill-on' : 'pill-off'}`}>
            {push?.subscribed ? 'ON' : 'OFF'}
          </span>
        </div>

        <div className="btn-row">
          {push?.subscribed ? (
            <>
              <button className="btn btn-ghost" onClick={handleDisable} disabled={busy}>Turn off</button>
              <button className="btn btn-primary" onClick={handleTest} disabled={busy}>Send test</button>
            </>
          ) : (
            <button className="btn btn-primary wide" onClick={handleEnable} disabled={busy || !push?.supported}>
              {busy ? 'Working…' : 'Enable phone alerts'}
            </button>
          )}
        </div>
      </section>

      {/* Threshold */}
      <section className="card">
        <div className="row">
          <div className="card-title">Alert threshold</div>
          <div className="threshold-value">{threshold}%</div>
        </div>
        <div className="card-sub">Notify when a stock is this far below its EMA12.</div>
        <input
          className="slider"
          type="range"
          min={5}
          max={40}
          step={1}
          value={threshold}
          onChange={e => setThreshold(Number(e.target.value))}
          onPointerUp={e => saveThreshold(Number((e.target as HTMLInputElement).value))}
          onKeyUp={e => saveThreshold(Number((e.target as HTMLInputElement).value))}
        />
        <div className="slider-ticks"><span>5%</span><span>20%</span><span>40%</span></div>
      </section>

      {showSettings && (
        <section className="card">
          <div className="card-title">Server address</div>
          <div className="card-sub">
            Your desktop's address on the home network, e.g. http://192.168.1.20:3050
          </div>
          <input
            className="text-input"
            value={apiBase}
            onChange={e => setApiBase(e.target.value)}
            onBlur={e => saveApiBase(e.target.value)}
            placeholder="http://192.168.1.20:3050"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
          />
          <div className="card-sub small">
            Only needed to browse the list and register this phone. Alerts are sent from the cloud
            scanner, so they arrive with your desktop switched off.
          </div>
        </section>
      )}

      {/* Dip list */}
      <section className="list">
        <div className="list-head">
          <span>{visible.length} at {threshold}%+</span>
          {belowThreshold > 0 && <span className="muted">{belowThreshold} shallower hidden</span>}
        </div>

        {visible.length === 0 && !loading && (
          <div className="empty">
            <div className="empty-icon">📉</div>
            <div>No stocks {threshold}% or more below EMA12</div>
            <div className="muted small">Lower the threshold to see more</div>
          </div>
        )}

        {visible.map(d => (
          <article key={d.ticker} className={`dip tone-${bucketTone(d.pct)}`}>
            <div className="dip-main">
              <div className="dip-ticker">{d.ticker}</div>
              <div className="dip-name">{d.name}</div>
            </div>
            <div className="dip-figures">
              <div className="dip-pct">{d.pct.toFixed(1)}%</div>
              <div className="dip-price">
                ${d.price.toFixed(2)} <span className="muted">vs {d.ema12.toFixed(2)}</span>
              </div>
            </div>
          </article>
        ))}
      </section>

      <footer className="footer">
        EMA12 from daily candles · alerts sent from the cloud scanner every 15 min during market hours
      </footer>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
