import { z } from 'zod';
import { supabase } from '../lib/core.js';

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
    })
    .default({ name: 'Minha Loja', supportEmail: '', document: '' }),
});
export type Settings = z.infer<typeof settingsSchema>;

let cache: { value: Settings; at: number } | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const { data } = await supabase.from('settings').select('value').eq('key', 'general').maybeSingle();
  const value = settingsSchema.parse((data as any)?.value ?? {});
  cache = { value, at: Date.now() };
  return value;
}

export async function saveSettings(input: unknown) {
  const value = settingsSchema.parse(input);
  const { error } = await supabase.from('settings').upsert({ key: 'general', value, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  cache = null;
  return value;
}
