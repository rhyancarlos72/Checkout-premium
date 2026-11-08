
const KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'src', 'sck', 'xcod', 'fbclid', 'gclid', 'ttclid', 'external_id', 'pt_xid'];

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
function setCookie(name: string, value: string, days = 90) {
  try {
    document.cookie = `${name}=${value}; path=/; max-age=${days * 86400}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  } catch {
    /* cookies bloqueados */
  }
}

/**
 * Garante os cookies da Meta mesmo sem o Pixel carregar (bloqueador, Pixel só na página de vendas etc.):
 *  - _fbp: identificador do navegador (formato oficial fb.1.<ms>.<aleatório>)
 *  - _fbc: criado a partir do fbclid do anúncio com o horário do clique
 * São os mesmos valores que o Pixel geraria, e aumentam a taxa de correspondência dos eventos.
 */
export function ensureMetaCookies() {
  const now = Date.now();
  if (!cookie('_fbp')) setCookie('_fbp', `fb.1.${now}.${Math.floor(1e9 + Math.random() * 9e9)}`);
  const fbclid = new URLSearchParams(location.search).get('fbclid');
  if (fbclid) {
    const cur = cookie('_fbc');
    if (!cur || !cur.endsWith(`.${fbclid}`)) {
      setCookie('_fbc', `fb.1.${now}.${fbclid}`);
      try {
        safeStorage()?.setItem('ck_fbclid_at', String(now));
      } catch {
        /* ignore */
      }
    }
  }
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
  ensureMetaCookies();
  const fbp = cookie('_fbp');
  const fbc = cookie('_fbc');
  const fbclidAt = s?.getItem('ck_fbclid_at');
  return {
    ...data,
    // external_id estável do visitante (o da URL/PayTracking, se houver): o MESMO no Pixel e no servidor
    external_id: data.external_id || data.pt_xid || sessionId(),
    ...(fbp ? { fbp } : {}),
    ...(fbc ? { fbc } : {}),
    ...(fbclidAt ? { fbclid_at: fbclidAt } : {}),
    visitor_id: sessionId(),
    page_url: window.location.href.slice(0, 500),
    referrer: document.referrer.slice(0, 300),
    session_id: sessionId(),
  };
}

export function track(checkout_slug: string, type: string, data: Record<string, unknown> = {}) {
  const body = JSON.stringify({ checkout_slug, type, session_id: sessionId(), data });
  // Estatística: vai como beacon (prioridade mínima do navegador), fora da cadeia crítica do carregamento.
  try {
    if (navigator.sendBeacon?.('/api/public/events', new Blob([body], { type: 'application/json' }))) return;
  } catch {
    /* cai no fetch abaixo */
  }
  fetch('/api/public/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, priority: 'low' } as RequestInit).catch(() => {});
}

// ------------------------------------------------------------------ Meta Pixel
declare global {
  interface Window {
    fbq?: any;
    _fbq?: any;
  }
}
export interface PixelUser {
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  externalId?: string | null;
}
/** Correspondência avançada do Pixel: o próprio Pixel normaliza e criptografa (SHA-256) antes de enviar. */
function pixelUserData(u?: PixelUser) {
  if (!u) return undefined;
  const [fn, ...ln] = (u.name ?? '').trim().toLowerCase().split(/\s+/);
  let ph = (u.phone ?? '').replace(/\D/g, '');
  if (ph.length === 10 || ph.length === 11) ph = `55${ph}`;
  const d: Record<string, string> = { country: 'br' };
  if (u.email) d.em = u.email.trim().toLowerCase();
  if (ph) d.ph = ph;
  if (fn) d.fn = fn;
  if (ln.length) d.ln = ln.join(' ');
  if (u.externalId) d.external_id = u.externalId;
  return d;
}
/** Atualiza os dados do comprador no Pixel já carregado (antes do Purchase). */
export function setPixelUser(pixelId: string | null | undefined, u: PixelUser) {
  if (pixelId && window.fbq) window.fbq('init', pixelId, pixelUserData(u));
}
export function initMetaPixel(pixelId: string | null | undefined, user?: PixelUser) {
  if (!pixelId) return;
  ensureMetaCookies();
  if (window.fbq) return setPixelUser(pixelId, user ?? {});
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
  window.fbq('init', pixelId, pixelUserData(user));
  window.fbq('track', 'PageView');
}
export function pixel(event: string, data: Record<string, unknown> = {}, eventId?: string) {
  window.fbq?.('track', event, data, eventId ? { eventID: eventId } : undefined);
}

/** external_id do visitante (igual ao enviado no pedido), para o Pixel desde o primeiro evento. */
export function visitorExternalId() {
  try {
    const raw = JSON.parse(safeStorage()?.getItem('ck_utm') ?? '{}');
    const d = raw?.data ?? {};
    const p = new URLSearchParams(window.location.search);
    return p.get('external_id') || p.get('pt_xid') || d.external_id || d.pt_xid || sessionId();
  } catch {
    return sessionId();
  }
}
