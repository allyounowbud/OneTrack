// lib/supabaseClient.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Read from Netlify env (injected into the browser build)
const URL = window?.env?.SUPABASE_URL || window?.SUPABASE_URL || import.meta?.env?.SUPABASE_URL || 'https://YOUR-PROJECT.supabase.co';
const KEY = window?.env?.SUPABASE_ANON_KEY || window?.SUPABASE_ANON_KEY || import.meta?.env?.SUPABASE_ANON_KEY || 'YOUR-ANON-KEY';

// Fallback warning (in case you forgot envs)
if (!URL || !KEY) {
  console.warn('⚠️ Supabase URL or ANON KEY missing. Check your Netlify env variables.');
}

export const supabase = createClient(URL, KEY);
