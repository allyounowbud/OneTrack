// lib/supabaseClient.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// TODO: put YOUR values here:
const SUPABASE_URL = 'https://<PROJECT-REF>.supabase.co';
const SUPABASE_ANON_KEY = '<YOUR-ANON-KEY>';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
