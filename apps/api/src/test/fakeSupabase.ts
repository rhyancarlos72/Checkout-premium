/**
 * Supabase em memória para testes de ponta a ponta (sem rede).
 * Implementa o subconjunto do PostgREST usado pelo app: select com relações embutidas,
 * filtros (eq/neq/in/is/not/gt/gte/lt/lte, caminho JSON ->>), order/limit/range,
 * insert/update/upsert/delete com retorno, count, single/maybeSingle e a RPC mark_order_paid.
 */
import crypto from 'node:crypto';

type Row = Record<string, any>;
export const db: Record<string, Row[]> = {};
const seq: Record<string, number> = {};
const UNIQUE: Record<string, string[]> = {
  customers: ['email'],
  orders: ['public_token'],
  invoices: ['order_id'],
  upsells: ['product_id'],
  settings: ['key'],
  checkouts: ['slug'],
  coupons: ['code'],
  admins: ['user_id'],
  access_requests: ['email'],
};
const NO_ID = new Set(['settings', 'admins', 'checkout_bumps']);

export function resetDb() {
  for (const k of Object.keys(db)) delete db[k];
  for (const k of Object.keys(seq)) delete seq[k];
}
const table = (t: string) => (db[t] ??= []);

function withDefaults(t: string, r: Row): Row {
  const now = new Date().toISOString();
  const row: Row = { ...r };
  if (!NO_ID.has(t) && row.id === undefined) row.id = t === 'events' || t === 'integration_logs' || t === 'webhook_logs' ? (seq[t] = (seq[t] ?? 0) + 1) : crypto.randomUUID();
  row.created_at ??= now;
  if (t === 'products') (row.number ??= 1000 + (seq.products = (seq.products ?? 0) + 1)), (row.active ??= true), (row.delivery_type ??= 'link');
  if (t === 'orders') {
    row.number ??= 1000 + (seq.orders = (seq.orders ?? 0) + 1);
    row.public_token ??= crypto.randomBytes(24).toString('hex');
    row.status ??= 'pending';
    row.tracking ??= {};
  }
  if (t === 'checkouts') (row.active ??= true), (row.provider ??= 'woovi'), (row.pix_expires_minutes ??= 30), (row.theme ??= {}), (row.fields ??= { phone: true, document: false }), (row.tracking ??= {});
  if (t === 'invoices') (row.status ??= 'processing'), (row.attempts ??= 0), (row.response ??= {});
  if (t === 'upsells' || t === 'order_bumps' || t === 'coupons') row.active ??= true;
  if (t === 'coupons') row.used_count ??= 0;
  return row;
}

const get = (row: Row, col: string) => {
  const m = col.match(/^(\w+)->>(\w+)$/);
  return m ? (row[m[1]]?.[m[2]] == null ? null : String(row[m[1]][m[2]])) : row[col];
};
const singular = (t: string) => t.replace(/s$/, '');

// ------------------------------------------------------------------ parser do select
interface Field { name: string; alias?: string; table?: string; hint?: string; children?: Field[] | '*' }
function parseSelect(s: string): Field[] | '*' {
  s = s.replace(/\s+/g, '');
  if (s === '*' || s === '') return '*';
  const out: Field[] = [];
  let depth = 0;
  let cur = '';
  const parts: string[] = [];
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) (parts.push(cur), (cur = ''));
    else cur += ch;
  }
  if (cur) parts.push(cur);
  let star = false;
  for (const p of parts) {
    if (p === '*') {
      star = true;
      continue;
    }
    const m = p.match(/^(?:(\w+):)?([\w]+)(?:!([\w]+))?(?:\((.*)\))?$/);
    if (!m) continue;
    const [, alias, name, hint, inner] = m;
    if (inner !== undefined) out.push({ name: alias ?? name, alias, table: name, hint: hint === 'inner' ? undefined : hint, children: parseSelect(inner) });
    else out.push({ name });
  }
  if (star) out.unshift({ name: '*' });
  return out;
}

function project(t: string, row: Row, fields: Field[] | '*'): Row {
  if (fields === '*') return { ...row };
  const o: Row = {};
  for (const f of fields) {
    if (f.name === '*') Object.assign(o, row);
    else if (!f.table) o[f.name] = row[f.name] ?? null;
    else {
      const target = f.table;
      const fk = f.hint?.endsWith('_fkey') ? f.hint.replace(/^\w+?_/, '').replace(/_fkey$/, '') : null;
      const many2one = fk ?? (f.alias && `${f.alias}_id` in row ? `${f.alias}_id` : `${singular(target)}_id` in row ? `${singular(target)}_id` : null);
      if (many2one) {
        const ref = table(target).find((r) => r.id === row[many2one]);
        o[f.name] = ref ? project(target, ref, f.children!) : null;
      } else {
        const back = `${singular(t)}_id`;
        o[f.name] = table(target).filter((r) => r[back] === row.id).map((r) => project(target, r, f.children!));
      }
    }
  }
  return o;
}

type Filter = (r: Row) => boolean;
class Query implements PromiseLike<any> {
  private filters: Filter[] = [];
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private sel: string | null = null;
  private payload: any;
  private conflict: string | null = null;
  private orders: { col: string; asc: boolean }[] = [];
  private lim: number | null = null;
  private rng: [number, number] | null = null;
  private mode: 'many' | 'single' | 'maybe' = 'many';
  private countHead = false;
  private returning = false;
  constructor(private t: string) {}

  select(s = '*', opts?: { count?: string; head?: boolean }) {
    if (this.op === 'select') this.sel = s;
    else (this.returning = true), (this.sel = s);
    if (opts?.head) this.countHead = true;
    return this;
  }
  insert(v: any) {
    return (this.op = 'insert'), (this.payload = v), this;
  }
  update(v: any) {
    return (this.op = 'update'), (this.payload = v), this;
  }
  upsert(v: any, o?: { onConflict?: string }) {
    return (this.op = 'upsert'), (this.payload = v), (this.conflict = o?.onConflict ?? null), this;
  }
  delete() {
    return (this.op = 'delete'), this;
  }
  eq(c: string, v: any) {
    return this.filters.push((r) => get(r, c) == v || (v === true && get(r, c) === true)), this;
  }
  neq(c: string, v: any) {
    return this.filters.push((r) => get(r, c) != v), this;
  }
  in(c: string, vs: any[]) {
    return this.filters.push((r) => vs.includes(get(r, c))), this;
  }
  is(c: string, v: any) {
    return this.filters.push((r) => (get(r, c) ?? null) === v), this;
  }
  not(c: string, op: string, v: any) {
    return this.filters.push((r) => (op === 'is' ? (get(r, c) ?? null) !== v : get(r, c) != v)), this;
  }
  gt(c: string, v: any) {
    return this.filters.push((r) => get(r, c) != null && get(r, c) > v), this;
  }
  gte(c: string, v: any) {
    return this.filters.push((r) => get(r, c) != null && get(r, c) >= v), this;
  }
  lt(c: string, v: any) {
    return this.filters.push((r) => get(r, c) != null && get(r, c) < v), this;
  }
  lte(c: string, v: any) {
    return this.filters.push((r) => get(r, c) != null && get(r, c) <= v), this;
  }
  or() {
    return this;
  }
  ilike() {
    return this;
  }
  order(col: string, o?: { ascending?: boolean }) {
    return this.orders.push({ col, asc: o?.ascending !== false }), this;
  }
  limit(n: number) {
    return (this.lim = n), this;
  }
  range(a: number, b: number) {
    return (this.rng = [a, b]), this;
  }
  single() {
    return (this.mode = 'single'), this;
  }
  maybeSingle() {
    return (this.mode = 'maybe'), this;
  }

  private dup(row: Row, ignore?: Row) {
    for (const col of UNIQUE[this.t] ?? []) if (row[col] != null && table(this.t).some((r) => r !== ignore && r[col] === row[col])) return col;
    return null;
  }
  private run(): { data: any; error: any; count?: number } {
    const rows = table(this.t);
    let out: Row[] = [];
    if (this.op === 'insert' || this.op === 'upsert') {
      const items = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((x: Row) => withDefaults(this.t, x));
      for (const it of items) {
        const key = this.conflict ?? (UNIQUE[this.t] ?? [])[0];
        const existing = this.op === 'upsert' && key ? rows.find((r) => r[key] === it[key]) : undefined;
        if (existing) {
          Object.assign(existing, Object.fromEntries(Object.entries(it).filter(([k]) => k !== 'id' && k !== 'created_at')));
          out.push(existing);
          continue;
        }
        const d = this.dup(it);
        if (d) return { data: null, error: { message: `duplicate key value violates unique constraint "${this.t}_${d}_key"`, code: '23505' } };
        rows.push(it);
        out.push(it);
      }
    } else {
      out = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === 'update') for (const r of out) Object.assign(r, this.payload);
      if (this.op === 'delete') db[this.t] = rows.filter((r) => !out.includes(r));
    }
    for (const o of [...this.orders].reverse()) out = [...out].sort((a, b) => (get(a, o.col) > get(b, o.col) ? 1 : get(a, o.col) < get(b, o.col) ? -1 : 0) * (o.asc ? 1 : -1));
    const count = out.length;
    if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
    if (this.lim != null) out = out.slice(0, this.lim);
    if (this.countHead) return { data: null, error: null, count };
    if (this.op !== 'select' && !this.returning) return { data: null, error: null };
    const fields = parseSelect(this.sel ?? '*');
    const data = out.map((r) => project(this.t, r, fields));
    if (this.mode === 'single') return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: `esperado 1 linha em ${this.t}, veio ${data.length}` } };
    if (this.mode === 'maybe') return { data: data[0] ?? null, error: null };
    return { data, error: null, count };
  }
  then<A, B>(ok?: (v: any) => A | PromiseLike<A>, ko?: (e: any) => B | PromiseLike<B>) {
    return Promise.resolve()
      .then(() => this.run())
      .then(ok, ko);
  }
}

export function createFakeClient() {
  return {
    from: (t: string) => new Query(t),
    rpc: async (fn: string, args: any) => {
      if (fn === 'mark_order_paid') {
        const o = table('orders').find((r) => r.id === args.p_order_id && ['pending', 'expired'].includes(r.status));
        if (!o) return { data: false, error: null };
        Object.assign(o, { status: 'paid', paid_at: new Date().toISOString() });
        if (o.coupon_id) {
          const c = table('coupons').find((x) => x.id === o.coupon_id);
          if (c) c.used_count++;
        }
        return { data: true, error: null };
      }
      return { data: null, error: { message: `rpc ${fn} não simulada` } };
    },
    storage: { from: () => ({ createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://storage.test/${p}?sig=1` } }) }) },
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'sem auth no teste' } }), admin: {} },
  };
}
