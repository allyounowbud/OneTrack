// OneTrack/lib/supabaseClient.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// TODO: replace both with your real values from Supabase → Settings → API
const SUPABASE_URL = 'https://dbxrlauvarqzvejvizew.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRieHJsYXV2YXJxenZlanZpemV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY3MzI5NjEsImV4cCI6MjA3MjMwODk2MX0.WxA5UxIxhV-fiac62xJ1B5blsJJ5S-1Vf1y3pQwxWiM';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
