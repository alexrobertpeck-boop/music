// Netlify Function (sync, read-only): return the cached taste profile.
//
// GET /.netlify/functions/taste-profile
//     200 { profile, generated_at, n_albums, model } when a row exists.
//     404 when nothing has been generated yet.
//
// Generation lives in `taste-profile-rebuild-background.mjs` because Claude
// Sonnet over ~300 albums regularly takes 25–40s — well past the 10s
// synchronous function ceiling. This file is the fast-path read.

import {
  getEnv, jsonOk, jsonError,
  verifyHouseholdUser,
  supabaseSelect,
} from '../lib/spotify-shared.mjs';

export default async (req) => {
  const supaUrl = getEnv('SUPABASE_URL');
  const anonKey = getEnv('SUPABASE_ANON_KEY');
  const serviceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!supaUrl || !serviceKey) return jsonError(500, 'Supabase env vars missing.');

  let userId;
  try { userId = await verifyHouseholdUser(req, supaUrl, anonKey, serviceKey); }
  catch (e) { return jsonError(401, e.message); }

  try {
    const rows = await supabaseSelect(supaUrl, serviceKey, 'taste_profile',
      `user_id=eq.${userId}&select=profile,generated_at,n_albums,model`);
    const row = rows?.[0];
    if (!row) return jsonError(404, 'No taste profile yet. POST to /taste-profile-rebuild-background to generate one.');
    return jsonOk({
      profile: row.profile,
      generated_at: row.generated_at,
      n_albums: row.n_albums,
      model: row.model,
      cached: true,
    });
  } catch (e) {
    console.error('taste-profile read error:', e);
    return jsonError(500, e.message || String(e));
  }
};
