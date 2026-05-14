// Netlify BACKGROUND Function: rebuild the user's taste profile.
//
// Filename ends in `-background` so Netlify runs it as a background function
// (returns 202 immediately, 15-minute execution budget). Claude Sonnet over
// ~300 rated albums regularly takes 25–40s, well past the 10s synchronous
// function ceiling that made the original taste-profile.mjs return 502.
//
// POST /.netlify/functions/taste-profile-rebuild-background
//   - Returns 202 right away.
//   - Reads all rated personal listens + joined Spotify features.
//   - Calls Claude Sonnet with a strict-JSON schema (contrarian-focused).
//   - Upserts the resulting profile into `taste_profile` for the user.
//
// The frontend polls `/.netlify/functions/taste-profile` until generated_at
// changes (or 90s elapses), then renders the fresh row.

import {
  getEnv,
  verifyHouseholdUser,
  supabaseSelect, supabaseUpsert,
} from '../lib/spotify-shared.mjs';
import { callClaude, parseClaudeJson, MODEL_SONNET } from '../lib/claude-shared.mjs';

export default async (req) => {
  const supaUrl = getEnv('SUPABASE_URL');
  const anonKey = getEnv('SUPABASE_ANON_KEY');
  const serviceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  const apiKey = getEnv('ANTHROPIC_API_KEY');
  if (!supaUrl || !serviceKey) {
    console.error('rebuild: Supabase env vars missing');
    return new Response('Supabase env vars missing', { status: 500 });
  }
  if (!apiKey) {
    console.error('rebuild: ANTHROPIC_API_KEY missing');
    return new Response('ANTHROPIC_API_KEY missing', { status: 500 });
  }

  // We still authenticate the request — even for a background function, we
  // don't want random callers triggering Claude spend.
  let userId;
  try { userId = await verifyHouseholdUser(req, supaUrl, anonKey, serviceKey); }
  catch (e) {
    console.error('rebuild: auth failed', e);
    return new Response(`auth: ${e.message}`, { status: 401 });
  }

  try {
    console.log(`rebuild: starting for user ${userId}`);
    const select = 'rating,notes,rated_at,album:albums(id,artist,album,year,spotify_features(danceability,energy,valence,acousticness,instrumentalness,tempo,loudness,key,genres))';
    const filter = `user_id=eq.${userId}&rating=not.is.null&select=${encodeURIComponent(select)}&limit=2000`;
    const ratings = await supabaseSelect(supaUrl, serviceKey, 'personal_ratings', filter);
    if (!ratings?.length) {
      console.error('rebuild: no rated albums');
      return new Response('no rated albums', { status: 400 });
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
  "dominant_genres": ["genre", ...],            // 4-7 max
  "dominant_eras": ["2000s", "1990s", ...],     // up to 5
  "contrarian_patterns": [                       // up to 4 patterns
    { "pattern": "what's unusual", "evidence": ["Artist - Album (rating)", ...] }  // up to 4 examples per pattern
  ],
  "audio_feature_sweetspots": {
    "high_rated_traits": "describe the audio-feature profile of 8+ rated albums",
    "low_rated_traits": "describe the audio-feature profile of 1-3 rated albums"
  },
  "artist_arcs": [                               // up to 6 artists with multiple ratings
    { "artist": "...", "summary": "ratings span / what they love or skip" }
  ],
  "blindspots": ["..."],                          // up to 6 genres/eras with <3 ratings worth exploring
  "key_signals_for_recommender": ["..."]          // 4-6 bullets
}

Rules:
- Contrarian = the listener disagreeing with broad critical consensus (a celebrated album rated 1-3, or an unfashionable / overlooked album rated 9-10). Treat these as the strongest signal, not noise. Cite specific evidence (artist + album + rating).
- Keep every field tight; do not exceed the caps in comments above.
- Don't restate raw counts. Extract insight.
- Group artists by trajectory where multiple albums are rated (e.g. "loves the early albums, lukewarm on recent").
- Output strictly the JSON above. No prose before or after. No code fence. No commentary.`;

    const userMsg = `Listener's rated albums (${dataset.length} rows). Some rows have full Spotify audio features; some don't yet — use what's there.

${JSON.stringify(dataset)}`;

    const raw = await callClaude({ apiKey, system, user: userMsg, model: MODEL_SONNET, maxTokens: 8192 });
    let profile;
    try { profile = parseClaudeJson(raw); }
    catch (e) {
      console.error('rebuild: JSON parse failed. Full Claude response:\n' + raw);
      return new Response(`parse failed: ${e.message}`, { status: 502 });
    }

    await supabaseUpsert(supaUrl, serviceKey, 'taste_profile', {
      user_id: userId,
      profile,
      model: MODEL_SONNET,
      n_albums: dataset.length,
      generated_at: new Date().toISOString(),
    }, 'user_id');

    console.log(`rebuild: success for user ${userId} (${dataset.length} albums)`);
    return new Response('rebuilt', { status: 200 });
  } catch (e) {
    console.error('rebuild error:', e);
    return new Response(String(e?.message || e), { status: 500 });
  }
};
