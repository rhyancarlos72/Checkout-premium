import { publicApi } from './api';

const KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'src', 'sck', 'fbclid', 'gclid', 'ttclid', 'external_id'];

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function cookie(name: string) {
  return document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))?.split('=')[1];
}

export function sessionId() {
  const s = safeStorage();
  let id = s?.getItem('ck_sid');
  if (!id) {
    id = crypto.randomUUID();
    s?.setItem('ck_sid', id);
  }
  return id;
}

/** Captura UTMs/click ids da URL (persistidos por 30 dias) + cookies da Meta. */
export function collectTracking(): Record<string, string> {
  const s = safeStorage();
  const params = new URLSearchParams(window.location.search);
  let stored: Record<string, string> = {};
  try {
    const raw = JSON.parse(s?.getItem('ck_utm') ?? '{}');
    if (raw.exp > Date.now()) stored = raw.data ?? {};
  } catch {
    /* ignore */
  }
  const fresh: Record<string, string> = {};
  for (const k of KEYS) {
    const v = params.get(k);
    if (v) fresh[k] = v.slice(0, 300);
  }
  const data = Object.keys(fresh).length ? { ...stored, ...fresh } : stored;
  s?.setItem('ck_utm', JSON.stringify({ data, exp: Date.now() + 30 * 86400000 }));
  const fbp = cookie('_fbp');
  const fbc = cookie('_fbc');
  return {
    ...data,
    ...(fbp ? { fbp } : {}),
    ...(fbc ? { fbc } : {}),
    page_url: window.location.href.slice(0, 500),
    referrer: document.referrer.slice(0, 300),
    session_id: sessionId(),
  };
}

export function track(checkout_slug: string, type: string, data: Record<string, unknown> = {}) {
  publicApi.post('/events', { checkout_slug, type, session_id: sessionId(), data }).catch(() => {});
}

// ------------------------------------------------------------------ Meta Pixel
declare global {
  interface Window {
    fbq?: any;
    _fbq?: any;
  }
}
export function initMetaPixel(pixelId: string | null | undefined) {
  if (!pixelId || window.fbq) return;
  const f: any = function (...args: unknown[]) {
    f.callMethod ? f.callMethod(...args) : f.queue.push(args);
  };
  f.push = f;
  f.loaded = true;
  f.version = '2.0';
  f.queue = [];
  window.fbq = window._fbq = f;
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://connect.facebook.net/en_US/fbevents.js';
  document.head.appendChild(s);
  window.fbq('init', pixelId);
  window.fbq('track', 'PageView');
}
export function pixel(event: string, data: Record<string, unknown> = {}, eventId?: string) {
  window.fbq?.('track', event, data, eventId ? { eventID: eventId } : undefined);
}
