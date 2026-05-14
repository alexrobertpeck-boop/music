// Netlify Function: generate album-club discussion questions.
//
// POST /.netlify/functions/club-questions
//   body: { session_id }
//
// Pulls each household member's display name + their highest-rated albums
// (for shared touchpoints), plus the session's album and any existing
// research notes. Asks Claude Sonnet for 6-8 discussion questions that
// reference each member's taste where natural and lean on the
// generational gap.

import {
  getEnv, jsonOk, jsonError,
  verifyHouseholdUser,
  supabaseSelect, supabaseUpdate,
} from '../lib/spotify-shared.mjs';
import { callClaude, parseClaudeJson, MODEL_SONNET } from '../lib/claude-shared.mjs';

const TOP_PER_MEMBER = 10;

export default async (req) => {
  if (req.method !== 'POST') return jsonError(405, 'POST only.');

  const supaUrl = getEnv('SUPABASE_URL');
  const anonKey = getEnv('SUPABASE_ANON_KEY');
  const serviceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  const apiKey = getEnv('ANTHROPIC_API_KEY');
  if (!supaUrl || !serviceKey) return jsonError(500, 'Supabase env vars missing.');
  if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY missing.');

  try { await verifyHouseholdUser(req, supaUrl, anonKey, serviceKey); }
  catch (e) { return jsonError(401, e.message); }

  let body;
  try { body = await req.json(); } catch { return jsonError(400, 'Invalid JSON body.'); }
  const sessionId = body?.session_id;
  if (!sessionId) return jsonError(400, 'session_id required.');

  try {
    // 1) Session + album.
    const sessSelect = 'id,research,album:albums(artist,album,year)';
    const sessRows = await supabaseSelect(supaUrl, serviceKey, 'club_sessions',
      `id=eq.${sessionId}&select=${encodeURIComponent(sessSelect)}`);
    const session = sessRows?.[0];
    if (!session) return jsonError(404, 'Session not found.');
    const { artist, album, year } = session.album || {};
    if (!artist || !album) return jsonError(400, 'Session album metadata missing.');

    // 2) Household members.
    const members = await supabaseSelect(supaUrl, serviceKey, 'household_members',
      'select=user_id,display_name');

    // 3) Each member's top N rated albums (one query per member; 1-2 members
    //    in practice, so this is fine).
    const ratingSelect = 'rating,album:albums(artist,album,year)';
    const memberContexts = await Promise.all(members.map(async m => {
      const ratings = await supabaseSelect(supaUrl, serviceKey, 'personal_ratings',
        `user_id=eq.${m.user_id}&rating=not.is.null&order=rating.desc,rated_at.desc&limit=${TOP_PER_MEMBER}&select=${encodeURIComponent(ratingSelect)}`);
      return {
        display_name: m.display_name,
        top_rated: ratings.map(r => ({
          artist: r.album?.artist,
          album: r.album?.album,
          year: r.album?.year,
          rating: r.rating,
        })),
      };
    }));

    const system = `You generate discussion questions for a two-person album club.

Output STRICT JSON: an array of 6-8 question strings. No prose around the array, no markdown, no fence.

Each question:
- Short, conversation-opening, open-ended (not yes/no)
- Mix flavors across the set: an emotional-reaction one, a craft/production one, a lyrical-theme one, a "compare to X" one that names a specific album one of the members has rated, and an era/context one (the members' generational gap is ~30 years — at least one question should engage that).
- Plainly worded. No "don't you think…", no coaching, no rhetorical flourishes.
- Don't ask the same flavor twice.
- Don't restate what the research notes already say.`;

    const userMsg = `Album: ${artist} — ${album} (${year || '?'})

Research notes from earlier (treat as context, don't restate):
${session.research?.text || '(none yet)'}

Club members and their top-rated albums:
${memberContexts.map(m => `- ${m.display_name}:\n` + m.top_rated.map(r => `    · ${r.artist} — ${r.album} (${r.year || '?'}): ${r.rating}/10`).join('\n')).join('\n\n')}`;

    const raw = await callClaude({ apiKey, system, user: userMsg, model: MODEL_SONNET, maxTokens: 2000 });
    let questions;
    try { questions = parseClaudeJson(raw); }
    catch (e) {
      console.error('club-questions parse failed. Raw:\n' + raw);
      return jsonError(502, `Claude returned non-JSON: ${e.message}`);
    }
    if (!Array.isArray(questions)) {
      return jsonError(502, 'Claude returned a non-array.');
    }
    questions = questions.map(q => String(q).trim()).filter(Boolean).slice(0, 8);

    const payload = {
      questions,
      model: MODEL_SONNET,
      generated_at: new Date().toISOString(),
    };
    await supabaseUpdate(supaUrl, serviceKey, 'club_sessions',
      `id=eq.${sessionId}`,
      { questions: payload, updated_at: payload.generated_at });

    return jsonOk({ questions: payload });
  } catch (e) {
    console.error('club-questions error:', e);
    return jsonError(500, e.message || String(e));
  }
};
