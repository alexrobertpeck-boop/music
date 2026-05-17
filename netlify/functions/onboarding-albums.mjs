// Netlify Function: generate the 25-album onboarding quiz for a new user.
//
// POST /.netlify/functions/onboarding-albums
//   body: { genres: [...], eras: [...], anchor_artist: '...' }
//         (optional — falls back to onboarding_quizzes.intro_answers)
//   query: ?force=1 — regenerate even if a cached list exists
//
// Reads the user's intro_answers (passed in or persisted), asks Claude Sonnet
// for a 25-album list following the composition rule:
//   - ~15 aligned with stated genres + eras
//   - ~5 wildcards in adjacent territory
//   - ~5 polarizing canon picks regardless of stated taste (contrarian
//     sentinels — we need them to tell critical-consensus agreement from
//     contrarian taste)
//
// Persists intro_answers + generated_albums to onboarding_quizzes. Idempotent:
// returns the cached list unless force=1.

import {
  getEnv, jsonOk, jsonError,
  verifyAuthUser,
  supabaseSelect, supabaseUpsert,
} from '../lib/spotify-shared.mjs';
import { callClaude, parseClaudeJson, MODEL_SONNET } from '../lib/claude-shared.mjs';

const TARGET_COUNT = 25;

export default async (req) => {
  if (req.method !== 'POST') return jsonError(405, 'POST only.');

  const supaUrl = getEnv('SUPABASE_URL');
  const anonKey = getEnv('SUPABASE_ANON_KEY');
  const serviceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  const apiKey = getEnv('ANTHROPIC_API_KEY');
  if (!supaUrl || !serviceKey) return jsonError(500, 'Supabase env vars missing.');
  if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY missing.');

  let userId;
  try { userId = await verifyAuthUser(req, supaUrl, anonKey, serviceKey); }
  catch (e) { return jsonError(401, e.message); }

  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1';

  let incoming = null;
  try { incoming = await req.json(); } catch { /* body optional */ }

  try {
    // Existing row (if any).
    const existingRows = await supabaseSelect(supaUrl, serviceKey, 'onboarding_quizzes',
      `user_id=eq.${userId}&select=intro_answers,generated_albums,started_at,completed_at`);
    const existing = existingRows?.[0] || null;

    // Merge intro_answers: prefer request body, fall back to persisted.
    const intro = sanitizeIntro(incoming) || existing?.intro_answers || null;
    if (!intro) {
      return jsonError(400, 'intro_answers required (genres / eras / anchor_artist).');
    }

    // Persist intro_answers if changed (or first time).
    const introChanged = JSON.stringify(intro) !== JSON.stringify(existing?.intro_answers || null);
    if (introChanged) {
      await supabaseUpsert(supaUrl, serviceKey, 'onboarding_quizzes', {
        user_id: userId,
        intro_answers: intro,
        started_at: existing?.started_at || new Date().toISOString(),
      }, 'user_id');
    }

    // Cache hit: return existing list unless force=1 or intro changed.
    if (!force && !introChanged && Array.isArray(existing?.generated_albums) && existing.generated_albums.length) {
      return jsonOk({
        albums: existing.generated_albums,
        intro_answers: intro,
        cached: true,
      });
    }

    // Generate via Claude.
    const system = `You design a 25-album rating quiz for a music recommender. The user just answered three intro questions; your job is to pick albums whose ratings will give the recommender enough signal to know them within roughly ten minutes.

Composition rule (strict — count the buckets):
- 15 albums clearly aligned with their stated genres + eras. Mix critically-loved with cult / underrated. Span the eras they picked.
- 5 wildcard picks in adjacent territory they MIGHT be open to (e.g. indie + 2010s → throw in a krautrock or alt-country record). The wildcards should be plausible jumps, not random.
- 5 polarizing canon picks that ALL serious listeners are expected to have opinions about — REGARDLESS of stated genres/eras. These are contrarian-detection sentinels. Pull from: Pet Sounds, The Velvet Underground & Nico, Public Enemy - It Takes a Nation of Millions..., Kid A, The Dark Side of the Moon, Illmatic, Pink Moon, Marquee Moon, Rumours, In the Aeroplane Over the Sea, Highway 61 Revisited, OK Computer, Songs in the Key of Life. Vary the 5 you pick.

Constraints:
- No duplicates. Use real, well-known album titles. Prefer canonical primary album titles (no remasters, deluxe editions, live versions).
- Years should be the original release year.
- Output STRICT JSON: an array of exactly ${TARGET_COUNT} objects, no prose, no markdown fence.
- Each object shape: { "artist": "...", "album": "...", "year": 1997, "bucket": "aligned" | "wildcard" | "canon" }`;

    const userMsg = `New listener intro answers:
${JSON.stringify(intro)}

Pick the 25 albums per the composition rule. JSON array only.`;

    const raw = await callClaude({ apiKey, system, user: userMsg, model: MODEL_SONNET, maxTokens: 2400 });
    let albums;
    try { albums = parseClaudeJson(raw); }
    catch (e) {
      console.error('onboarding-albums JSON parse failed. Raw:', raw.slice(0, 500));
      return jsonError(502, `Claude returned non-JSON: ${e.message}`);
    }
    if (!Array.isArray(albums)) return jsonError(502, 'Claude did not return an array.');

    // Normalize + dedupe.
    const seen = new Set();
    const cleaned = [];
    for (const a of albums) {
      const artist = String(a?.artist || '').trim();
      const album = String(a?.album || '').trim();
      if (!artist || !album) continue;
      const key = `${artist.toLowerCase()}||${album.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push({
        artist,
        album,
        year: Number.isFinite(a.year) ? Number(a.year) : null,
        bucket: ['aligned', 'wildcard', 'canon'].includes(a.bucket) ? a.bucket : 'aligned',
      });
      if (cleaned.length >= TARGET_COUNT) break;
    }

    await supabaseUpsert(supaUrl, serviceKey, 'onboarding_quizzes', {
      user_id: userId,
      intro_answers: intro,
      generated_albums: cleaned,
      started_at: existing?.started_at || new Date().toISOString(),
    }, 'user_id');

    return jsonOk({
      albums: cleaned,
      intro_answers: intro,
      cached: false,
    });
  } catch (e) {
    console.error('onboarding-albums error:', e);
    return jsonError(500, e.message || String(e));
  }
};

function sanitizeIntro(body) {
  if (!body || typeof body !== 'object') return null;
  const genres = Array.isArray(body.genres) ? body.genres.map(s => String(s).trim()).filter(Boolean).slice(0, 12) : [];
  const eras = Array.isArray(body.eras) ? body.eras.map(s => String(s).trim()).filter(Boolean).slice(0, 8) : [];
  const anchor = (body.anchor_artist || '').toString().trim().slice(0, 200);
  if (!genres.length && !eras.length && !anchor) return null;
  return { genres, eras, anchor_artist: anchor };
}
