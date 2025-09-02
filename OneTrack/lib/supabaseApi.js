// OneTrack/lib/supabaseApi.js
import { supabase } from './supabaseClient.js';

/** Read Profiles (normalized to your old shape) */
export async function getProfiles() {
  const { data, error } = await supabase
    .from('Profiles')
    .select('id, "profileName", username, email, discord, role, notes, created, updated, created_at, updated_at')
    .order('profileName', { ascending: true });
  if (error) throw error;

  return (data || []).map(row => ({
    id: row.id,
    row: row.id, // alias so old code that expects .row still works
    username: row.username ?? row.profileName ?? '',
    email: row.email ?? '',
    discord: row.discord ?? '',
    role: row.role ?? '',
    notes: row.notes ?? '',
    created: row.created ?? row.created_at ?? null,
    updated: row.updated ?? row.updated_at ?? null
  }));
}

/** Create one profile */
export async function addProfile(payload) {
  const rec = {
    username: payload?.username ?? '',
    email:    payload?.email ?? '',
    discord:  payload?.discord ?? '',
    role:     payload?.role ?? '',
    notes:    payload?.notes ?? ''
  };
  const { data, error } = await supabase.from('Profiles').insert([rec]).select('id');
  if (error) throw error;
  return { ok: true, id: data?.[0]?.id };
}

/** Update many profiles (rows[].row is treated as primary key id) */
export async function updateProfiles(rows) {
  if (!Array.isArray(rows)) throw new Error('rows must be an array');
  const updates = rows.map(r => ({
    id: r.row,
    username: r.username ?? null,
    email:    r.email ?? null,
    discord:  r.discord ?? null,
    role:     r.role ?? null,
    notes:    r.notes ?? null
  }));
  const { error } = await supabase.from('Profiles').upsert(updates, { onConflict: 'id' });
  if (error) throw error;
  return { ok: true };
}

/** Delete one profile by id */
export async function removeProfile(id) {
  const { error } = await supabase.from('Profiles').delete().eq('id', Number(id));
  if (error) throw error;
  return { ok: true };
}
