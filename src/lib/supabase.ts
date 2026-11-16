import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;

export const supabaseConfigured = !!(url && key);

// The publishable/anon key is safe in the browser: all data access is enforced by row-level security.
export const supabase = createClient(url ?? 'http://localhost:54321', key ?? 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
});

export const functionsUrl = ((import.meta.env.VITE_FUNCTIONS_URL as string | undefined) || `${url ?? ''}/functions/v1`).replace(/\/$/, '');
