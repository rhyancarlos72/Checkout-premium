import { HttpError } from '../lib/core.js';
import { EfiProvider } from './efi.js';
import type { PixProvider, ProviderName } from './types.js';
import { WooviProvider } from './woovi.js';

export const woovi = new WooviProvider();
export const efi = new EfiProvider();

const registry: Record<ProviderName, PixProvider> = { woovi, efi };

export function getProvider(name: ProviderName): PixProvider {
  const p = registry[name];
  if (!p) throw new HttpError(400, `Provedor desconhecido: ${name}`);
  if (!p.isConfigured()) throw new HttpError(503, `Pagamento indisponível no momento (${name} não configurado)`);
  return p;
}

export function providerStatus() {
  return Object.values(registry).map((p) => ({ name: p.name, configured: p.isConfigured() }));
}

export type { PixProvider, ProviderName } from './types.js';
