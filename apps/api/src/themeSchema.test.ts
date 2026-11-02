import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Todo campo de personalização do editor precisa ser aceito pelo servidor (senão some ao salvar). */
describe('personalização do checkout', () => {
  it('o servidor salva todos os campos do editor', () => {
    const root = path.resolve(__dirname, '../../..');
    const front = fs.readFileSync(path.join(root, 'apps/web/src/pages/checkout/theme.ts'), 'utf8');
    const iface = front.slice(front.indexOf('export interface Theme'), front.indexOf('\n}', front.indexOf('export interface Theme')));
    const editorKeys = [...iface.matchAll(/^\s+(\w+)\?:/gm)].map((m) => m[1]);
    const back = fs.readFileSync(path.join(root, 'apps/api/src/routes/admin.ts'), 'utf8');
    const start = back.indexOf('const themeSchema');
    const schema = back.slice(start, back.indexOf('.strip()', start));
    const serverKeys = [...schema.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
    expect(editorKeys.length).toBeGreaterThan(10);
    expect(editorKeys.filter((k) => !serverKeys.includes(k))).toEqual([]);
  });
});
