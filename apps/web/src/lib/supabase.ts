import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

/** Cliente público (anon key). Usado só para login do admin e upload de imagens (RLS exige admin). */
export const supabase = createClient(url || 'http://localhost', anon || 'missing', {
  auth: { persistSession: true, autoRefreshToken: true },
});
export const supabaseConfigured = Boolean(url && anon);
