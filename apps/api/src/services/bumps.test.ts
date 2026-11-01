import { describe, expect, it, vi } from 'vitest';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
process.env.PUBLIC_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-test-key-test-key';
process.env.NODE_ENV = 'test';
const { visibleBumps } = await import('./orders.js');

const bump = (o: any) => ({ id: 'b', product_id: 'p2', title: '', description: null, image_url: null, price_cents: 1990, active: true, product: { name: 'Pack', description: 'desc', image_url: 'img', active: true }, ...o });

describe('visibleBumps', () => {
  it('mostra bump ativo e herda dados do produto adicional', () => {
    const [b] = visibleBumps([{ sort: 0, bump: bump({}) }]);
    expect(b).toMatchObject({ title: 'Pack', description: 'desc', image_url: 'img' });
  });
  it('NÃO esconde bump cujo produto adicional está inativo', () => {
    expect(visibleBumps([{ sort: 0, bump: bump({ product: { name: 'X', active: false } }) }])).toHaveLength(1);
  });
  it('NÃO esconde bump antigo que aponta para o próprio produto principal', () => {
    expect(visibleBumps([{ sort: 0, bump: bump({ product_id: 'p1' }) }])).toHaveLength(1);
  });
  it('esconde só bump desativado ou ausente, e respeita a ordem', () => {
    const r = visibleBumps([
      { sort: 2, bump: bump({ id: 'c', title: 'C' }) },
      { sort: 1, bump: bump({ id: 'off', active: false }) },
      { sort: 0, bump: bump({ id: 'a', title: 'A' }) },
      { sort: 3, bump: null },
    ]);
    expect(r.map((x) => x.id)).toEqual(['a', 'c']);
  });
});
