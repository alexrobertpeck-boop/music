// Netlify Function: generate or read Alex's taste profile.
//
// GET /.netlify/functions/taste-profile
//     Returns the cached profile if <30 days old. Otherwise regenerates.
//
// GET /.netlify/functions/taste-profile?force=1
//     Always regenerates and overwrites the cached row.
//
// Profile generation: gather every rated personal_ratings row for the user,
// join in albums + spotify_features, send the lot to Claude Sonnet with a
// strict-JSON schema prompt. The result is the structured taste profile
// that downstream `recommend.mjs` calls consume.

import {
  getEnv, jsonOk, jsonError,
  verifyHouseholdUser,
  supabaseSelect, supabaseUpsert,
} from '../lib/spotify-shared.mjs';
import { callClaude, parseClaudeJson, MODEL_SONNET } from '../lib/claude-shared.mjs';

const STALE_DAYS = 30;

export default async (req) => {
  const supaUrl = getEnv('SUPABASE_URL');
  const anonKey = getEnv('SUPABASE_ANON_KEY');
  const serviceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  const apiKey = getEnv('ANTHROPIC_API_KEY');
  if (!supaUrl || !serviceKey) return jsonError(500, 'Supabase env vars missing.');
  if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY missing.');

  let userId;
  try {
    userId = await verifyHouseholdUser(req, supaUrl, anonKey, serviceKey);
  } catch (e) {
    return jsonError(401, e.message);
  }

  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1';

  try {
    // Cached fast path.
    if (!force) {
      const rows = await supabaseSelect(supaUrl, serviceKey, 'taste_profile',
        `user_id=eq.${userId}&select=*`);
      const row = rows?.[0];
      if (row) {
        const ageDays = (Date.now() - new Date(row.generated_at).getTime()) / 86400000;
        if (ageDays < STALE_DAYS) {
          return jsonOk({ profile: row.profile, generated_at: row.generated_at, n_albums: row.n_albums, model: row.model, cached: true });
        }
      }
    }

    // Gather rated personal listens with Spotify features.
    // PostgREST embed: ratings → albums → spotify_features. We filter to
    // rating IS NOT NULL because unrated rows carry no signal for taste.
    const select = 'rating,notes,rated_at,album:albums(id,artist,album,year,spotify_features(danceability,energy,valence,acousticness,instrumentalness,tempo,loudness,key,genres))';
    const filter = `user_id=eq.${userId}&rating=not.is.null&select=${encodeURIComponent(select)}&limit=2000`;
    const ratings = await supabaseSelect(supaUrl, serviceKey, 'personal_ratings', filter);

    if (!ratings?.length) {
      return jsonError(400, 'No rated albums yet — log some albums first.');
    }

    const dataset = ratings.map(r => {
      const a = r.album || {};
      const f = a.spotify_features || {};
      return {
        artist: a.artist,
        album: a.album,
        year: a.year,
        rating: r.rating,
        notes: r.notes || undefined,
        genres: f.genres || undefined,
        danceability: f.danceability ?? undefined,
        energy: f.energy ?? undefined,
        valence: f.valence ?? undefined,
        acousticness: f.acousticness ?? undefined,
        instrumentalness: f.instrumentalness ?? undefined,
        tempo: f.tempo ?? undefined,
        loudness: f.loudness ?? undefined,
        key: f.key ?? undefined,
      };
    });

    const system = `You analyze music taste from solo listening data — NOT shared listening, NOT critic picks. Produce a structured JSON taste profile per the schema below.

Schema (output JSON only, no markdown):
{
  "summary": "1-2 sentence plain-language portrait of this listener",
  "dominant_genres": ["genre", ...],
  "dominant_eras": ["2000s", "1990s", ...],
  "contrarian_patterns": [
    { "pattern": "what's unusual", "evidence": ["Artist - Album (rating)", ...] }
  ],
  "audio_feature_sweetspots": {
    "high_rated_traits": "describe the audio-feature profile of 8+ rated albums",
    "low_rated_traits": "describe the audio-feature profile of 1-3 rated albums"
  },
  "artist_arcs": [
    { "artist": "...", "summary": "ratings span / what they love or skip" }
  ],
  "blindspots": ["genres/eras with <3 ratings the listener might want to explore"],
  "key_signals_for_recommender": [
    "concise bullets a downstream recommender should weigh — e.g. 'leans contrarian on canonical 60s pop' or 'prefers acousticness > 0.6 in 8+ ratings'"
  ]
}

Rules:
- Contrarian = the listener disagreeing with broad critical consensus (a celebrated album rated 1-3, or an unfashionable / overlooked album rated 9-10). Treat these as the strongest signal, not noise. Cite specific evidence.
- Don't restate raw counts. Extract insight.
- Group artists by trajectory where multiple albums are rated (e.g. "loves the early albums, lukewarm on recent").
- Output strictly the JSON above. No prose before or after. No code fence.`;

    const userMsg = `Listener's rated albums (${dataset.length} rows). Some rows have full Spotify audio features; some don't yet — use what's there.

${JSON.stringify(dataset)}`;

    const raw = await callClaude({ apiKey, system, user: userMsg, model: MODEL_SONNET, maxTokens: 4096 });
    let profile;
    try { profile = parseClaudeJson(raw); }
    catch (e) {
      console.error('Profile JSON parse failed. Raw:', raw.slice(0, 500));
      return jsonError(502, `Claude returned non-JSON: ${e.message}`);
    }

    const now = new Date().toISOString();
    await supabaseUpsert(supaUrl, serviceKey, 'taste_profile', {
      user_id: userId,
      profile,
      model: MODEL_SONNET,
      n_albums: dataset.length,
      generated_at: now,
    }, 'user_id');

    return jsonOk({ profile, generated_at: now, n_albums: dataset.length, model: MODEL_SONNET, cached: false });
  } catch (e) {
    console.error('taste-profile error:', e);
    return jsonError(500, e.message || String(e));
  }
};
