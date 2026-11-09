import { z } from 'zod';
import { supabase } from '../lib/core.js';
import { orgKey } from '../lib/tenant.js';

export const settingsSchema = z.object({
  recovery: z
    .object({
      enabled: z.boolean().default(true),
      delayMinutes: z.number().int().min(5).max(1440).default(30),
    })
    .default({ enabled: true, delayMinutes: 30 }),
  goal: z
    .object({ monthlyCents: z.number().int().min(0).max(100_000_000_00).default(10_000_000) })
    .default({ monthlyCents: 10_000_000 }),
  store: z
    .object({
      name: z.string().max(80).default('Minha Loja'),
      supportEmail: z.string().email().or(z.literal('')).default(''),
      document: z.string().max(30).default(''),
      /** quem recebe o Pix (nome da conta no gateway, o mesmo que aparece no app do banco) */
      pixReceiver: z.string().trim().max(80).default('Prime Tecnologia'),
    })
    .default({ name: 'Minha Loja', supportEmail: '', document: '', pixReceiver: 'Prime Tecnologia' }),
  // identidade visual do sistema (painel, login, ícone da aba)
  brand: z
    .object({
      name: z.string().trim().max(40).default('Checkout Premium'),
      logoUrl: z.string().url().max(500).or(z.literal('')).default(''),
      logoBg: z.boolean().default(false),
    })
    .default({ name: 'Checkout Premium', logoUrl: '', logoBg: false }),
});
export type Settings = z.infer<typeof settingsSchema>;

// cache por chave (cada produtor tem a sua)
const cache = new Map<string, { value: Settings; at: number }>();

/** Configurações da organização atual (loja, meta, recuperação). A marca do sistema é sempre a da plataforma. */
export async function getSettings(): Promise<Settings> {
  const key = await orgKey('general');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  // até 10 min: responde com o que tem e atualiza por trás (nome da loja/meta mudam pouco; salvar limpa o cache)
  if (hit && Date.now() - hit.at < 10 * 60_000) {
    void loadSettings(key).catch(() => {});
    return hit.value;
  }
  return loadSettings(key);
}

async function loadSettings(key: string): Promise<Settings> {
  const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  let value = settingsSchema.parse((data as any)?.value ?? {});
  if (key !== 'general') {
    const { data: base } = await supabase.from('settings').select('value').eq('key', 'general').maybeSingle();
    value = { ...value, brand: settingsSchema.parse((base as any)?.value ?? {}).brand };
  }
  cache.set(key, { value, at: Date.now() });
  return value;
}

export async function saveSettings(input: unknown) {
  const key = await orgKey('general');
  let value = settingsSchema.parse(input);
  // produtor não altera a marca do sistema (logo/nome da plataforma)
  if (key !== 'general') {
    const { data: cur } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
    value = { ...value, brand: settingsSchema.parse((cur as any)?.value ?? {}).brand };
  }
  const { error } = await supabase.from('settings').upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  cache.clear();
  return value;
}
