#!/usr/bin/env node
/**
 * Gera apps/api/data/geo-br.bin: cidade e estado (UF) por faixa de IP, SÓ do Brasil, a partir do
 * "IP to City Lite" da DB-IP (CC BY 4.0 — IP Geolocation by DB-IP, https://db-ip.com).
 * O arquivo final tem poucos MB e é lido pelo servidor sem nenhuma consulta externa.
 *
 * Atualizar (mensal, opcional):
 *   cd /tmp && npm pack @ip-location-db/dbip-city-mmdb && tar xzf ip-location-db-dbip-city-mmdb-*.tgz
 *   cd apps/api && npm i --no-save mmdb-lib@2
 *   npm run geo:build -- /tmp/package/dbip-city-ipv4.mmdb /tmp/package/dbip-city-ipv6.mmdb
 *
 * Formato (little-endian):
 *   "GEOBR1" | u32 tamanho do JSON | JSON { locs: ["sp|Sao Paulo", ...], v4: n, v6: n, source }
 *   v4: n × u32 início da faixa, n × u16 índice do local (0xFFFF = fora do Brasil / desconhecido)
 *   v6: n × u64 início da faixa (/64), n × u16 índice do local
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let mmdb;
try {
  mmdb = require('mmdb-lib');
} catch {
  mmdb = createRequire(path.join(process.cwd(), 'noop.js'))('mmdb-lib');
}
const [v4File, v6File] = process.argv.slice(2);
if (!v4File || !v6File) {
  console.error('uso: node build-geo-br.mjs dbip-city-ipv4.mmdb dbip-city-ipv6.mmdb');
  process.exit(1);
}

const UF = {
  acre: 'ac', alagoas: 'al', amapa: 'ap', amazonas: 'am', bahia: 'ba', ceara: 'ce', 'distrito federal': 'df', 'espirito santo': 'es', goias: 'go', maranhao: 'ma', 'mato grosso': 'mt', 'mato grosso do sul': 'ms', 'minas gerais': 'mg', para: 'pa', paraiba: 'pb', parana: 'pr', pernambuco: 'pe', piaui: 'pi', 'rio de janeiro': 'rj', 'rio grande do norte': 'rn', 'rio grande do sul': 'rs', rondonia: 'ro', roraima: 'rr', 'santa catarina': 'sc', 'sao paulo': 'sp', sergipe: 'se', tocantins: 'to',
};
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const NONE = 0xffff;
const locs = [];
const locIdx = new Map();
function loc(rec) {
  if (!rec || rec.country_code !== 'BR') return NONE;
  const uf = UF[norm(rec.state1)] ?? '';
  const city = String(rec.city ?? '').trim();
  if (!uf && !city) return NONE;
  const key = `${uf}|${city}`;
  let i = locIdx.get(key);
  if (i === undefined) {
    i = locs.length;
    if (i >= NONE) throw new Error('locais demais');
    locs.push(key);
    locIdx.set(key, i);
  }
  return i;
}

/** Percorre a árvore do mmdb e devolve faixas [início, fim) com o índice do local (só Brasil). */
function walk(file, bits, keepBits) {
  const r = new mmdb.Reader(fs.readFileSync(file));
  const { nodeCount, nodeByteSize } = r.metadata;
  const w = r.walker;
  const out = []; // [startBigInt, endBigInt, idx]
  const cache = new Map();
  const stack = [[r.ipv4StartNodeNumber ?? 0, 0n, 0]];
  if (bits === 128) stack[0] = [0, 0n, 0];
  while (stack.length) {
    const [node, prefix, depth] = stack.pop();
    for (const bit of [1, 0]) {
      const next = bit ? w.right(node * nodeByteSize) : w.left(node * nodeByteSize);
      const p = prefix | (BigInt(bit) << BigInt(bits - depth - 1));
      if (next < nodeCount) stack.push([next, p, depth + 1]);
      else if (next > nodeCount) {
        let idx = cache.get(next);
        if (idx === undefined) {
          idx = loc(r.resolveDataPointer(next));
          cache.set(next, idx);
        }
        if (idx !== NONE && !(keepBits === 64 && p >> 64n === 0n)) {
          const size = 1n << BigInt(bits - depth - 1);
          out.push([p >> BigInt(bits - keepBits), (p + size) >> BigInt(bits - keepBits), idx]);
        }
      }
    }
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // junta faixas vizinhas do mesmo local e marca o fim de cada bloco (fora do Brasil)
  const starts = [];
  const idxs = [];
  let end = -1n;
  for (const [s, e0, i] of out) {
    const e = e0 > s ? e0 : s + 1n; // blocos menores que /64 viram um /64
    if (s < end) continue; // sobreposição (sub-/64): mantém o primeiro
    if (starts.length && s === end && idxs[idxs.length - 1] === i) {
      end = e;
      continue;
    }
    if (starts.length && s !== end) {
      starts.push(end);
      idxs.push(NONE);
    }
    starts.push(s);
    idxs.push(i);
    end = e;
  }
  if (starts.length) {
    starts.push(end);
    idxs.push(NONE);
  }
  return { starts, idxs };
}

const v4 = walk(v4File, 32, 32);
// mmdb IPv6 da DB-IP também contém o espaço IPv4 mapeado: só interessa o IPv6 "de verdade"
const v6 = walk(v6File, 128, 64);

const json = Buffer.from(JSON.stringify({ source: 'IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0', built: new Date().toISOString().slice(0, 10), locs, v4: v4.starts.length, v6: v6.starts.length }));
const head = Buffer.alloc(10);
head.write('GEOBR1', 0, 'ascii');
head.writeUInt32LE(json.length, 6);
const b4 = Buffer.alloc(v4.starts.length * 4);
v4.starts.forEach((s, i) => b4.writeUInt32LE(Number(s), i * 4));
const i4 = Buffer.alloc(v4.idxs.length * 2);
v4.idxs.forEach((x, i) => i4.writeUInt16LE(x, i * 2));
const b6 = Buffer.alloc(v6.starts.length * 8);
v6.starts.forEach((s, i) => b6.writeBigUInt64LE(s & 0xffffffffffffffffn, i * 8));
const i6 = Buffer.alloc(v6.idxs.length * 2);
v6.idxs.forEach((x, i) => i6.writeUInt16LE(x, i * 2));

const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'geo-br.bin');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, Buffer.concat([head, json, b4, i4, b6, i6]));
console.log(`geo-br.bin: ${locs.length} locais, ${v4.starts.length} faixas IPv4, ${v6.starts.length} faixas IPv6, ${(fs.statSync(dest).size / 1e6).toFixed(1)} MB`);
