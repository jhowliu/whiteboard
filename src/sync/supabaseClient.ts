import { createClient, type SupabaseClient } from '@supabase/supabase-js'

function readEnv(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

const url = readEnv(import.meta.env.VITE_SUPABASE_URL)
const anonKey = readEnv(import.meta.env.VITE_SUPABASE_ANON_KEY)

/**
 * The Supabase client, or `null` in local-only mode (when either
 * `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` is missing).
 */
export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          // Sign-in is by one-time code only; there are no magic-link redirects.
          detectSessionInUrl: false,
        },
      })
    : null

export function isSupabaseConfigured(): boolean {
  return supabase !== null
}
