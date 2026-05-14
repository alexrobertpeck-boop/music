// Netlify Function: generate album research notes for an Album Club session.
//
// POST /.netlify/functions/club-research
//   body: { session_id }
//
// Reads the session's album (artist + title + year), asks Claude Haiku for
// ~300 words of context — release setting, what's notable, 2-3 key tracks to
// listen for, recurring themes, production quirks worth noticing — and
// stores it on club_sessions.research. Plain prose, no markdown.

import {
  getEnv, jsonOk, jsonError,
  verifyHouseholdUser,
  supabaseSelect, supabaseUpdate,
} from '../lib/spotify-shared.mjs';
import { callClaude, MODEL_HAIKU } from '../lib/claude-shared.mjs';

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
    const select = 'id,album:albums(artist,album,year)';
    const rows = await supabaseSelect(supaUrl, serviceKey, 'club_sessions',
      `id=eq.${sessionId}&select=${encodeURIComponent(select)}`);
    const session = rows?.[0];
    if (!session) return jsonError(404, 'Session not found.');
    const { artist, album, year } = session.album || {};
    if (!artist || !album) return jsonError(400, 'Session album metadata missing.');

    const system = `You write CONTEXT notes for a two-person album club's prep — a launchpad for their own research, NOT a review or critique.

What to include:
- Release date and where it sat in the band's arc at that point (debut? mid-career pivot? late-period?)
- What was going on for the band — line-up changes, between-album shifts, anything that shaped the recording
- The wider musical context the album landed in (genre wave, peer scene, who else was releasing what nearby)
- The cultural / political moment the album responded to or commented on, if relevant
- Any unusual production circumstance (studio, producer, sessions length, gear) worth knowing about
- Reception at release — was it a hit, ignored, divisive?

What NOT to include:
- "It's a classic / underrated / masterpiece" framing
- Your own opinion of the album
- Track-by-track summaries (they'll listen for that themselves)
- A summary of the album's themes (they'll figure that out)
- Critical platitudes

Plain prose. About 300 words. No markdown, no bullets, no headings. Be specific and concrete with dates, names, and places. If you don't know something, omit it — don't invent.`;

    const userMsg = `Album: ${artist} — ${album} (${year || '?'}).`;

    const text = await callClaude({ apiKey, system, user: userMsg, model: MODEL_HAIKU, maxTokens: 800 });

    const research = {
      text,
      model: MODEL_HAIKU,
      generated_at: new Date().toISOString(),
    };
    await supabaseUpdate(supaUrl, serviceKey, 'club_sessions',
      `id=eq.${sessionId}`,
      { research, updated_at: research.generated_at });

    return jsonOk({ research });
  } catch (e) {
    console.error('club-research error:', e);
    return jsonError(500, e.message || String(e));
  }
};
