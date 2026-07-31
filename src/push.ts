/**
 * Push subscription plumbing.
 *
 * The flow Android needs, in order:
 *   register service worker -> request Notification permission -> get the
 *   VAPID public key from the server -> subscribe via PushManager -> hand the
 *   subscription to the server so the cloud scanner can send to it.
 *
 * Permission must be requested from a user gesture, so this is only ever called
 * from a button handler.
 */

export interface PushState {
  supported: boolean;
  permission: NotificationPermission;
  subscribed: boolean;
  endpoint: string | null;
  reason: string | null;
}

/** VAPID keys are base64url; PushManager wants a Uint8Array. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    // Relative path + relative scope, so the app works both at the domain root
    // and under a subpath (e.g. GitHub Pages project sites).
    return await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (err) {
    console.error('[push] Service worker registration failed', err);
    return null;
  }
}

export async function getPushState(): Promise<PushState> {
  if (!isPushSupported()) {
    return {
      supported: false,
      permission: 'default',
      subscribed: false,
      endpoint: null,
      reason: window.isSecureContext
        ? 'This browser does not support web push.'
        : 'Push needs a secure context — open the app over HTTPS or localhost.',
    };
  }

  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;

  return {
    supported: true,
    permission: Notification.permission,
    subscribed: !!sub,
    endpoint: sub?.endpoint ?? null,
    reason: null,
  };
}

export async function subscribeToPush(
  apiBase: string,
  thresholdPct: number,
  label: string,
): Promise<{ ok: boolean; error?: string; endpoint?: string }> {
  if (!isPushSupported()) return { ok: false, error: 'Push is not supported in this browser.' };
  if (!window.isSecureContext) {
    return { ok: false, error: 'Push requires HTTPS (or localhost). See the README for the LAN setup.' };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return {
      ok: false,
      error: permission === 'denied'
        ? 'Notifications are blocked. Enable them for this site in Android app settings.'
        : 'Notification permission was dismissed.',
    };
  }

  const reg = (await navigator.serviceWorker.getRegistration()) || (await registerServiceWorker());
  if (!reg) return { ok: false, error: 'Service worker could not be registered.' };
  await navigator.serviceWorker.ready;

  let publicKey: string;
  try {
    const resp = await fetch(`${apiBase}/api/push/vapid-public-key`);
    const json = await resp.json();
    if (!resp.ok || !json.publicKey) throw new Error(json.error || 'No VAPID key returned');
    publicKey = json.publicKey;
  } catch (err: any) {
    return { ok: false, error: `Could not reach the server: ${err.message}` };
  }

  let sub: PushSubscription;
  try {
    // Reuse an existing subscription rather than replacing it.
    //
    // Unsubscribing first is destructive: it invalidates the endpoint the
    // server already holds, so if anything after that point fails (a dropped
    // request, a closed tunnel) the server is left with a registration the
    // push service now answers 410 for — and the app still looks enabled.
    // Tapping "Enable" twice was enough to trigger it.
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      sub = existing;
    } else {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
      });
    }
  } catch (err: any) {
    // A key mismatch (InvalidStateError) is the one case that genuinely needs a
    // fresh subscription, so only then do we discard the old one.
    try {
      const stale = await reg.pushManager.getSubscription();
      if (stale) await stale.unsubscribe().catch(() => {});
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
      });
    } catch (retryErr: any) {
      return { ok: false, error: `Subscribe failed: ${retryErr.message || err.message}` };
    }
  }

  try {
    const resp = await fetch(`${apiBase}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), thresholdPct, label }),
    });
    if (!resp.ok) {
      const json = await resp.json().catch(() => ({}));
      throw new Error(json.error || `HTTP ${resp.status}`);
    }
  } catch (err: any) {
    return { ok: false, error: `Server rejected the subscription: ${err.message}` };
  }

  return { ok: true, endpoint: sub.endpoint };
}

export async function unsubscribeFromPush(apiBase: string): Promise<boolean> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return false;

  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await fetch(`${apiBase}/api/push/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }).catch(() => { /* local unsubscribe already happened */ });
  return true;
}
