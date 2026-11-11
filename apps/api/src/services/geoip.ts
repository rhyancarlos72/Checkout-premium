import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Cidade e estado do visitante pelo IP, consultados NO PRÓPRIO SERVIDOR (nada sai para serviços externos).
 * Base: data/geo-br.bin (só Brasil, ~4 MB), gerada por scripts/build-geo-br.mjs a partir do
 * "IP to City Lite" — IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0.
 * Usada quando a hospedagem não envia cabeçalhos de localização (Hostinger não envia; Cloudflare/Vercel enviam).
 */
export interface IpGeo {
  city: string;
  state: string; // UF minúscula (sp, rj, ...)
  country: 'BR';
}

interface GeoDb {
  locs: string[];
  v4: Uint32Array;
  v4i: Uint16Array;
  v6: BigUint64Array;
  v6i: Uint16Array;
}
let db: GeoDb | null | undefined;
const NONE = 0xffff;

function dataFile() {
  const here = path.dirname(fileURLToPath(import.meta.url)); // src/services ou dist/services
  return path.resolve(here, '../../data/geo-br.bin');
}

export function loadGeoDb(file = dataFile()): GeoDb | null {
  try {
    const buf = fs.readFileSync(file);
    if (buf.toString('ascii', 0, 6) !== 'GEOBR1') return null;
    const jl = buf.readUInt32LE(6);
    const meta = JSON.parse(buf.toString('utf8', 10, 10 + jl)) as { locs: string[]; v4: number; v6: number };
    let off = 10 + jl;
    // copia para arrays alinhados (o Buffer pode começar em qualquer posição)
    const take = (bytes: number) => {
      const ab = new ArrayBuffer(bytes);
      new Uint8Array(ab).set(buf.subarray(off, off + bytes));
      off += bytes;
      return ab;
    };
    const v4 = new Uint32Array(take(meta.v4 * 4));
    const v4i = new Uint16Array(take(meta.v4 * 2));
    const v6 = new BigUint64Array(take(meta.v6 * 8));
    const v6i = new Uint16Array(take(meta.v6 * 2));
    return { locs: meta.locs, v4, v4i, v6, v6i };
  } catch {
    return null;
  }
}
const getDb = () => (db === undefined ? (db = loadGeoDb()) : db);

/** Carrega a base já na subida do servidor (a primeira visita não espera a leitura do arquivo). */
export function warmGeoDb() {
  getDb();
}

function parseV4(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
/** 64 bits iniciais do IPv6 (as faixas de provedores são de /64 para cima). */
function parseV6Prefix(ip: string): bigint | null {
  if (!/^[0-9a-f:]+$/i.test(ip) || !ip.includes(':')) return null;
  const [head, tail] = ip.split('::');
  if (ip.split('::').length > 2) return null;
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8 || groups.some((g) => g.length > 4 || g === '')) return null;
  return groups.slice(0, 4).reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}
function search<T extends number | bigint>(arr: ArrayLike<T>, x: T) {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function geoFromIp(ip: string | null | undefined): IpGeo | null {
  if (!ip) return null;
  const d = getDb();
  if (!d) return null;
  let addr = ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) addr = mapped[1];
  let idx = NONE;
  const v4 = parseV4(addr);
  if (v4 !== null) {
    const i = search(d.v4, v4);
    if (i >= 0) idx = d.v4i[i];
  } else {
    const v6 = parseV6Prefix(addr);
    if (v6 === null) return null;
    const i = search(d.v6, v6);
    if (i >= 0) idx = d.v6i[i];
  }
  if (idx === NONE || !d.locs[idx]) return null;
  const [state, city] = d.locs[idx].split('|');
  return { city, state, country: 'BR' };
}

/** Campos de rastreamento (geo_*) pelo IP, no mesmo formato dos cabeçalhos da CDN. */
export function geoTrackingFromIp(ip: string | null | undefined): Record<string, string> {
  const g = geoFromIp(ip);
  if (!g) return {};
  const out: Record<string, string> = { geo_country: g.country };
  if (g.city) out.geo_city = g.city;
  if (g.state) out.geo_state = g.state;
  return out;
}
