import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

let supabaseConfigError = '';

try {
  new URL(supabaseUrl);
} catch {
  supabaseConfigError =
    'VITE_SUPABASE_URL must be a valid Supabase URL, such as https://your-project.supabase.co.';
}

if (!supabaseAnonKey || supabaseAnonKey === 'your-anon-public-key') {
  supabaseConfigError =
    'VITE_SUPABASE_ANON_KEY must contain the real public Supabase anon key.';
}

export { supabaseConfigError };

// Keep startup renderable so configuration mistakes are visible in the UI.
export const supabase = supabaseConfigError
  ? null
  : createClient(supabaseUrl, supabaseAnonKey);
