import { describe, expect, it } from 'vitest';
import { geoFromIp, geoTrackingFromIp, loadGeoDb } from './geoip.js';

describe('cidade/estado pelo IP (base local, só Brasil)', () => {
  it('base carrega e tem cidades do Brasil inteiro', () => {
    const d = loadGeoDb()!;
    expect(d).not.toBeNull();
    expect(d.locs.length).toBeGreaterThan(3000);
    expect(new Set(d.locs.map((l) => l.split('|')[0])).size).toBeGreaterThanOrEqual(27); // todas as UFs
  });
  it('IPv4 e IPv6 de provedores brasileiros', () => {
    expect(geoFromIp('187.10.20.77')).toEqual({ city: 'Maua', state: 'sp', country: 'BR' });
    expect(geoFromIp('::ffff:200.147.67.142')).toMatchObject({ city: 'Rio de Janeiro', state: 'rj' });
    expect(geoFromIp('2804:14c:5b81:8b1c::1')).toMatchObject({ city: 'Belo Horizonte', state: 'mg' });
    expect(geoFromIp('2804:7f0:b900:0:0:0:0:1')).toMatchObject({ state: 'sp' });
  });
  it('fora do Brasil, IP interno ou inválido: nada (não inventa localização)', () => {
    for (const ip of ['8.8.8.8', '2001:4860:4860::8888', '10.0.0.1', '127.0.0.1', '::1', 'abc', '', null, '999.1.1.1', '1:2:3']) expect(geoFromIp(ip as any)).toBeNull();
    expect(geoTrackingFromIp('8.8.8.8')).toEqual({});
    expect(geoTrackingFromIp('187.10.20.77')).toEqual({ geo_country: 'BR', geo_city: 'Maua', geo_state: 'sp' });
  });
  it('consulta rápida', () => {
    const t = performance.now();
    for (let i = 0; i < 20_000; i++) geoFromIp(`177.${i % 250}.${(i * 7) % 250}.1`);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
