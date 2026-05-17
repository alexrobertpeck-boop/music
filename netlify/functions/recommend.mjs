// Netlify Function: generate album recommendations.
//
// POST /.netlify/functions/recommend
//   body: { constraint: "rainy sunday" }
//
// Reads the user's cached taste profile, recent 20 listens, and an
// exclusion list (personal-rated ∪ club-covered ∪ previously-recommended)
// → asks Claude Sonnet for 5 album picks. Each pick must cite a specific
// rated album from the user's history. The 5 picks are persisted to
// `recommendations` so they're excluded from future requests.
//
// Two-domain invariant: taste profile and recent listens come ONLY from
// personal_ratings. Club ratings never bleed into the taste signal. But
// club albums ARE in the exclusion list because the user has heard them.

import {
  getEnv, jsonOk, jsonError,
  verifyAuthUser,
  supabaseSelect, supabaseUpsert,
} from '../lib/spotify-shared.mjs';
import { callClaude, parseClaudeJson, MODEL_SONNET } from '../lib/claude-shared.mjs';

const REC_COUNT = 5;
const RECENT_LIMIT = 20;
const PRIOR_REC_LIMIT = 10;   // last N recommendation requests to mine for exclusion

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

  let body;
  try { body = await req.json(); }
  catch { return jsonError(400, 'Invalid JSON body.'); }
  const constraint = (body?.constraint || '').toString().trim().slice(0, 600);

  try {
    // 1) Taste profile — must already be generated.
    const profileRows = await supabaseSelect(supaUrl, serviceKey, 'taste_profile',
      `user_id=eq.${userId}&select=profile,generated_at,n_albums`);
    const profileRow = profileRows?.[0];
    if (!profileRow) {
      return jsonError(409, 'No taste profile yet. Generate one first via /.netlify/functions/taste-profile.');
    }

    // 2) Recent personal listens — most-recent first. Only personal,
    //    never club. Includes notes since they're high-signal context.
    const recentSelect = 'rating,notes,rated_at,album:albums(artist,album,year)';
    const recentFilter = `user_id=eq.${userId}&rating=not.is.null&order=rated_at.desc&limit=${RECENT_LIMIT}&select=${encodeURIComponent(recentSelect)}`;
    const recentRaw = await supabaseSelect(supaUrl, serviceKey, 'personal_ratings', recentFilter);
    const recent = recentRaw.map(r => ({
      artist: r.album?.artist, album: r.album?.album, year: r.album?.year,
      rating: r.rating, notes: r.notes || undefined,
    }));

    // 3) Exclusion list. Three sources:
    //    a) every album the user has rated personally
    //    b) every album that's been covered by a club session
    //    c) the recommendations he's already received (last N requests)
    const personalSelect = 'album:albums(artist,album)';
    const personalFilter = `user_id=eq.${userId}&select=${encodeURIComponent(personalSelect)}&limit=2000`;
    const personalAll = await supabaseSelect(supaUrl, serviceKey, 'personal_ratings', personalFilter);

    // Club sessions the user has personally participated in (rated). This is
    // narrower than "every club session ever" because users outside the
    // household haven't actually heard Alex+dad's picks.
    const clubSelect = 'session:club_sessions(album:albums(artist,album))';
    const clubFilter = `user_id=eq.${userId}&select=${encodeURIComponent(clubSelect)}&limit=2000`;
    const clubAll = await supabaseSelect(supaUrl, serviceKey, 'club_session_ratings', clubFilter)
      .then(rows => rows.map(r => ({ album: r.session?.album })));

    const priorRecsFilter = `user_id=eq.${userId}&order=created_at.desc&limit=${PRIOR_REC_LIMIT}&select=recs`;
    const priorRecsRaw = await supabaseSelect(supaUrl, serviceKey, 'recommendations', priorRecsFilter);

    const excludeSet = new Set();
    const pushExclusion = (artist, album) => {
      const a = (artist || '').trim(); const b = (album || '').trim();
      if (a && b) excludeSet.add(`${a.toLowerCase()}||${b.toLowerCase()}`);
    };
    for (const r of personalAll) pushExclusion(r.album?.artist, r.album?.album);
    for (const r of clubAll) pushExclusion(r.album?.artist, r.album?.album);
    for (const r of priorRecsRaw) {
      for (const rec of (r.recs || [])) pushExclusion(rec.artist, rec.album);
    }

    // Build a human-readable exclusion list for Claude. Cap to keep prompt size
    // sane; the post-filter below is the actual enforcement.
    const exclusionList = [...excludeSet].slice(0, 800);

    // 4) Build prompt + call Claude.
    const system = `You recommend albums for one listener. Output STRICT JSON: an array of exactly ${REC_COUNT} objects, no prose, no fence.

Each object:
{
  "artist": "...",
  "album": "...",
  "year": 1997,
  "reasoning": "1-2 sentences. MUST cite at least one specific album the user has rated, including their rating, by name."
}

Rules:
- Never recommend any album in the exclusion list — those have already been heard.
- Use the taste profile as your primary lens. Lean into the contrarian patterns; the listener disagrees with critical consensus on several canon albums, so do NOT default to safe canonical picks.
- Mix the 5 picks: 3 aligned with their sweet spots, 1-2 that expand into adjacent territory in a way the profile suggests they'd be open to.
- Respect the user's constraint where it makes sense; if the constraint is "surprise me" or empty, lean toward expansion picks.
- Don't recommend an album by an artist they've consistently rated low (check artist_arcs).
- Output strictly the JSON array. No prose. No markdown.`;

    const userMsg = `Taste profile:
${JSON.stringify(profileRow.profile)}

Recent listens (most recent first, with their rating and any notes):
${JSON.stringify(recent)}

Exclusion list — these are albums the user has already heard. Never recommend any of these:
${exclusionList.map(s => '- ' + s).join('\n')}

User's constraint: ${constraint || '(none — surprise them)'}`;

    const raw = await callClaude({ apiKey, system, user: userMsg, model: MODEL_SONNET, maxTokens: 1800 });
    let recs;
    try { recs = parseClaudeJson(raw); }
    catch (e) {
      console.error('Recs JSON parse failed. Raw:', raw.slice(0, 500));
      return jsonError(502, `Claude returned non-JSON: ${e.message}`);
    }
    if (!Array.isArray(recs)) {
      return jsonError(502, 'Claude did not return an array.');
    }

    // Defense-in-depth post-filter: drop any rec that overlaps the exclusion
    // set (in case Claude slipped one in despite the instructions).
    const filtered = [];
    for (const r of recs) {
      const key = `${(r.artist || '').toLowerCase().trim()}||${(r.album || '').toLowerCase().trim()}`;
      if (!r.artist || !r.album) continue;
      if (excludeSet.has(key)) continue;
      filtered.push({
        artist: String(r.artist).trim(),
        album: String(r.album).trim(),
        year: Number.isFinite(r.year) ? Number(r.year) : null,
        reasoning: String(r.reasoning || '').trim(),
      });
      if (filtered.length >= REC_COUNT) break;
    }

    // 5) Persist this round so future calls exclude it. Generate the UUID
    // server-side so we can return it to the client — the client needs the
    // id to set source_rec_id when the user adds one of the picks to their
    // "to listen" list.
    const created = new Date().toISOString();
    const recId = crypto.randomUUID();
    await supabaseUpsert(supaUrl, serviceKey, 'recommendations', {
      id: recId,
      user_id: userId,
      constraint_text: constraint || null,
      recs: filtered,
      model: MODEL_SONNET,
      created_at: created,
    });

    return jsonOk({
      rec_id: recId,
      recs: filtered,
      constraint,
      taste_profile_generated_at: profileRow.generated_at,
      n_excluded: excludeSet.size,
      created_at: created,
    });
  } catch (e) {
    console.error('recommend error:', e);
    return jsonError(500, e.message || String(e));
  }
};
