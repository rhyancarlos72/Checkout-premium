import type { CSSProperties } from 'react';
import { contrastText } from '@/lib/format';

export interface Theme {
  // Aparência
  mode?: 'light' | 'dark' | 'auto';
  primaryColor?: string;
  backgroundColor?: string;
  radius?: 'sharp' | 'soft' | 'round';
  // Conteúdo
  headline?: string;
  subheadline?: string;
  producerName?: string;
  /** Preço "de" (riscado), em centavos */
  compareAtCents?: number | null;
  benefits?: string[];
  buttonText?: string;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  mockupUrl?: string | null;
  guaranteeDays?: number;
  guaranteeText?: string;
  testimonials?: { name: string; text: string; avatarUrl?: string | null }[];
  footerText?: string;
  // Conversão
  announcement?: string;
  showTimer?: boolean;
  timerMinutes?: number;
  timerText?: string;
  /** cor de fundo da barra do cronômetro/aviso (vazio = cor principal) */
  timerBgColor?: string | null;
  /** cor do texto da barra (vazio = automático, contrastando com o fundo) */
  timerTextColor?: string | null;
  showSeals?: boolean;
  stickyMobileCta?: boolean;
}

export interface PublicCheckout {
  id: string;
  slug: string;
  name: string;
  price_cents: number;
  theme: Theme;
  fields: { phone: boolean; document: boolean };
  tracking: { metaPixelId: string | null };
  product: { name: string; number?: number | null; description: string | null; image_url: string | null };
  bumps: { id: string; title: string; description: string | null; price_cents: number; compare_at_cents: number | null; image_url: string | null }[];
  store: { name: string; supportEmail: string; document: string };
  /** formas além do Pix (cartão só quando liberado pela plataforma) */
  payment?: { card: { maxInstallments: number } | null };
}

export const themeDefaults: Required<Pick<Theme, 'mode' | 'primaryColor' | 'backgroundColor' | 'radius' | 'buttonText' | 'guaranteeDays' | 'showTimer' | 'timerMinutes' | 'showSeals' | 'stickyMobileCta'>> = {
  mode: 'light',
  primaryColor: '#059669',
  backgroundColor: '#f4f5f7',
  radius: 'soft',
  buttonText: 'Finalizar compra',
  guaranteeDays: 7,
  showTimer: false,
  timerMinutes: 15,
  showSeals: true,
  stickyMobileCta: true,
};

export const palettes = [
  { name: 'Esmeralda', color: '#059669' },
  { name: 'Azul', color: '#2563eb' },
  { name: 'Violeta', color: '#7c3aed' },
  { name: 'Rosa', color: '#db2777' },
  { name: 'Laranja', color: '#ea580c' },
  { name: 'Vermelho', color: '#dc2626' },
  { name: 'Grafite', color: '#18181b' },
];

function luminance(hex: string) {
  const n = parseInt(hex.replace('#', ''), 16);
  if (Number.isNaN(n)) return 255;
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (r * 299 + g * 587 + b * 114) / 1000;
}
const isLight = (hex: string) => luminance(hex) > 128;

/** Variáveis CSS do checkout (cores, raio, marca) — usadas pelas classes bg-ck-*, text-ck-*, rounded-ck. */
/** Resolve o modo 'auto' pela preferência do aparelho. */
export function resolveMode(mode: Theme['mode'], prefersDark: boolean): 'light' | 'dark' {
  return mode === 'auto' ? (prefersDark ? 'dark' : 'light') : mode === 'dark' ? 'dark' : 'light';
}

export function themeStyle(theme: Theme | undefined, prefersDark = false): CSSProperties {
  const t = { ...themeDefaults, ...theme };
  const dark = resolveMode(t.mode, prefersDark) === 'dark';
  let brand = t.primaryColor || themeDefaults.primaryColor;
  // Em modo escuro, uma marca muito escura some no fundo: clareia o botão
  if (dark && luminance(brand) < 50) brand = '#f4f4f5';
  // Fundo: respeita a cor escolhida se combinar com o modo; senão usa o padrão do modo
  const bg = dark ? (t.backgroundColor && !isLight(t.backgroundColor) ? t.backgroundColor : '#0a0b10') : t.backgroundColor && isLight(t.backgroundColor) ? t.backgroundColor : '#f4f5f7';
  const r = { sharp: '6px', soft: '14px', round: '22px' }[t.radius] ?? '14px';
  return {
    ['--brand' as any]: brand,
    ['--brand-fg' as any]: contrastText(brand),
    ['--ck-bg' as any]: bg,
    ['--ck-surface' as any]: dark ? '#12141b' : '#ffffff',
    ['--ck-surface-2' as any]: dark ? '#191c25' : '#f8fafc',
    ['--ck-input' as any]: dark ? '#0d0f15' : '#ffffff',
    ['--ck-text' as any]: dark ? '#f4f4f5' : '#0f172a',
    ['--ck-muted' as any]: dark ? '#a1a1aa' : '#64748b',
    ['--ck-border' as any]: dark ? 'rgba(255,255,255,.09)' : '#e5e7eb',
    ['--ck-r' as any]: r,
    colorScheme: dark ? 'dark' : 'light',
  };
}

import { useEffect, useState } from 'react';

/** true quando o aparelho está em modo escuro (atualiza ao vivo). */
export function usePrefersDark() {
  const get = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const [v, setV] = useState<boolean>(get);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = () => setV(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return v;
}
