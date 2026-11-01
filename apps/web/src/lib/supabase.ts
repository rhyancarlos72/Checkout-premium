import { createClient } from '@supabase/supabase-js';

declare global {
  interface Window {
    __APP_CONFIG__?: { supabaseUrl?: string; supabaseAnonKey?: string };
  }
}

// Lido em tempo de execução de /config.js (servido pela API); VITE_* só como alternativa no dev.
const cfg = window.__APP_CONFIG__ ?? {};
const url = cfg.supabaseUrl || (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '';
const anon = cfg.supabaseAnonKey || (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || '';

/** Cliente público (anon key). Usado só para login do admin e upload de imagens (RLS exige admin). */
export const supabase = createClient(url || 'http://localhost', anon || 'missing', {
  auth: { persistSession: true, autoRefreshToken: true },
});
export const supabaseConfigured = Boolean(url && anon);
