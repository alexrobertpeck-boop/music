// Netlify Function: fetch a track list for an Album Club session.
//
// POST /.netlify/functions/club-tracks
//   body: { session_id }
//
// Asks Claude Haiku for the ordered track list of the session's album.
// Claude-based (rather than hitting Spotify) so it works even when the
// Spotify dev app is in cooldown, and avoids the audio-features /
// rate-limit complexity. Cached to club_sessions.tracks.
//
// Output: array of track name strings, in album order.

import {
  getEnv, jsonOk, jsonError,
  verifyHouseholdUser,
  supabaseSelect, supabaseUpdate,
  getAlbumDetails,
} from '../lib/spotify-shared.mjs';
import { callClaude, parseClaudeJson, MODEL_SONNET } from '../lib/claude-shared.mjs';

export default async (req) => {
  if (req.method !== 'POST') return jsonError(405, 'POST only.');

  const supaUrl = getEnv('SUPABASE_URL');
  const anonKey = getEnv('SUPABASE_ANON_KEY');
  const serviceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  const apiKey = getEnv('ANTHROPIC_API_KEY');
  if (!supaUrl || !serviceKey) return jsonError(500, 'Supabase env vars missing.');

  try { await verifyHouseholdUser(req, supaUrl, anonKey, serviceKey); }
  catch (e) { return jsonError(401, e.message); }

  let body;
  try { body = await req.json(); } catch { return jsonError(400, 'Invalid JSON body.'); }
  const sessionId = body?.session_id;
  const manualTracks = body?.manual_tracks;   // optional: caller-supplied list to set directly
  if (!sessionId) return jsonError(400, 'session_id required.');

  try {
    const sessSelect = 'id,album:albums(artist,album,year,spotify_album_id)';
    const sessRows = await supabaseSelect(supaUrl, serviceKey, 'club_sessions',
      `id=eq.${sessionId}&select=${encodeURIComponent(sessSelect)}`);
    const session = sessRows?.[0];
    if (!session) return jsonError(404, 'Session not found.');
    const a = session.album || {};
    const { artist, album, year, spotify_album_id } = a;
    if (!artist || !album) return jsonError(400, 'Session album metadata missing.');

    // ─── Manual override path ─────
    if (Array.isArray(manualTracks)) {
      const cleaned = manualTracks.map(t => String(t).trim()).filter(Boolean).slice(0, 40);
      const payload = {
        tracks: cleaned,
        source: 'manual',
        generated_at: new Date().toISOString(),
      };
      await supabaseUpdate(supaUrl, serviceKey, 'club_sessions',
        `id=eq.${sessionId}`,
        { tracks: payload, updated_at: payload.generated_at });
      return jsonOk({ tracks: payload });
    }

    // ─── Path 1: Spotify (truth) ─────
    if (spotify_album_id) {
      try {
        const details = await getAlbumDetails(spotify_album_id);
        const items = details?.tracks?.items || [];
        const tracks = items.map(t => t?.name).filter(Boolean).slice(0, 40);
        if (tracks.length > 0) {
          const payload = {
            tracks,
            source: 'spotify',
            generated_at: new Date().toISOString(),
          };
          await supabaseUpdate(supaUrl, serviceKey, 'club_sessions',
            `id=eq.${sessionId}`,
            { tracks: payload, updated_at: payload.generated_at });
          return jsonOk({ tracks: payload });
        }
      } catch (e) {
        console.warn(`club-tracks: Spotify fetch failed for ${spotify_album_id}: ${e.message}. Falling back to Claude.`);
      }
    }

    // ─── Path 2: Claude fallback ─────
    if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY missing and Spotify lookup failed.');

    const system = `Return the ordered track list of an album as STRICT JSON: a single array of track-name strings, in playing order. No prose, no fence, no commentary.

Rules:
- Use the STANDARD album release. Not deluxe, anniversary, expanded, remastered, or live versions.
- Use the exact track names as they appear on the official release.
- If you are not highly confident in the track list (e.g. obscure release, you'd be guessing more than 1-2 names), return an empty array []. Do NOT invent or guess track names.
- It is better to return [] than to fabricate plausible-sounding tracks.`;

    const userMsg = `Album: ${artist} — ${album}${year ? ` (${year})` : ''}.`;

    const raw = await callClaude({ apiKey, system, user: userMsg, model: MODEL_SONNET, maxTokens: 1500 });
    let tracks;
    try { tracks = parseClaudeJson(raw); }
    catch (e) {
      console.error('club-tracks parse failed. Raw:\n' + raw);
      return jsonError(502, `Claude returned non-JSON: ${e.message}`);
    }
    if (!Array.isArray(tracks)) return jsonError(502, 'Claude returned a non-array.');
    tracks = tracks.map(t => String(t).trim()).filter(Boolean).slice(0, 40);

    const payload = {
      tracks,
      source: 'claude-sonnet',
      generated_at: new Date().toISOString(),
    };
    await supabaseUpdate(supaUrl, serviceKey, 'club_sessions',
      `id=eq.${sessionId}`,
      { tracks: payload, updated_at: payload.generated_at });

    return jsonOk({ tracks: payload });
  } catch (e) {
    console.error('club-tracks error:', e);
    return jsonError(500, e.message || String(e));
  }
};
