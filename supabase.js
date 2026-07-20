import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// service_role key: server-side only, bypasses row-level security.
export const supabase = createClient(url, key, { auth: { persistSession: false } });
