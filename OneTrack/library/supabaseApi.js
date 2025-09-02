// lib/supabaseApi.js
import { supabase } from './supabaseClient.js';

/**
 * Reads profiles from your Supabase "Profiles" table
 * and normalizes fields to what your UI likely expects.
 */
export async function getProfiles() {
  const { data, error } = await supabase
    .from('Profiles')
    .select('id, "profileName", username, email, discord, role, notes, created, updated, created_at, updated_at')
    .order('profileName', { ascending: true });

  if (error) throw error;

  return (data || []).map(row => ({
    id: row.id,
    username: row.username ?? row.profileName ?? '',
    email: row.email ?? '',
    discord: row.discord ?? '',
    role: row.role ?? '',
    notes: row.notes ?? '',
    created: row.created ?? row.created_at ?? null,
    updated: row.updated ?? row.updated_at ?? null
  }));
}
