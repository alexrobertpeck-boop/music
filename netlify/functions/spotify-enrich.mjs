// Netlify Function: Spotify enrichment.
//
// Two modes, single endpoint:
//
//  GET  /.netlify/functions/spotify-enrich?album_ids=uuid1,uuid2,...
//       For each album: search Spotify, auto-confirm if the top hit matches
//       closely (Levenshtein ≤ ~15% of length, year ±1), else return up to
//       5 candidates for manual review. For auto-confirmed (or pre-confirmed)
//       albums, fetch full audio features + artist genres and upsert
//       spotify_features. Processes up to 15 albums in parallel.
//
//  POST /.netlify/functions/spotify-enrich   body: {album_id, spotify_album_id}
//       Manual-confirm path: bind the album to the chosen Spotify ID, set
//       match_status='manual', enrich features. Used by the Confirm Matches UI.
//
// Auth: requires a valid Supabase user JWT in the Authorization header AND
// the user must be in household_members. Writes use the service role key.

import {
  getEnv, jsonOk, jsonError,
  verifyHouseholdUser,
  supabaseSelect, supabaseUpdate, supabaseUpsert,
  searchAlbumCandidates, getAlbumDetails, getAudioFeatures, getArtistGenres,
  aggregateFeatures, isCloseMatch,
} from '../lib/spotify-shared.mjs';

const MAX_BATCH = 15;

export default async (req) => {
  const supaUrl = getEnv('SUPABASE_URL');
  const anonKey = getEnv('SUPABASE_ANON_KEY');             // optional; serviceKey works for auth check too
  const serviceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!supaUrl || !serviceKey) return jsonError(500, 'Supabase env vars missing.');

  let userId;
  try {
    userId = await verifyHouseholdUser(req, supaUrl, anonKey, serviceKey);
  } catch (e) {
    return jsonError(401, e.message);
  }

  try {
    if (req.method === 'POST') {
      return await handleManualConfirm(req, supaUrl, serviceKey);
    }
    return await handleBatchEnrich(req, supaUrl, serviceKey);
  } catch (e) {
    console.error('spotify-enrich error:', e);
    return jsonError(500, e.message || String(e));
  }
};

// ─── Batch enrich (GET) ────────────────────────────────────────────────────

async function handleBatchEnrich(req, supaUrl, serviceKey) {
  const url = new URL(req.url);
  const idsParam = url.searchParams.get('album_ids') || url.searchParams.get('album_id') || '';
  const albumIds = idsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, MAX_BATCH);
  if (!albumIds.length) return jsonError(400, 'No album_ids provided.');

  // One query for all catalog rows.
  const filter = `id=in.(${albumIds.join(',')})&select=id,artist,album,year,spotify_album_id,match_status`;
  const albums = await supabaseSelect(supaUrl, serviceKey, 'albums', filter);
  const byId = new Map(albums.map(a => [a.id, a]));

  const results = await Promise.all(albumIds.map(id => enrichOne(byId.get(id), supaUrl, serviceKey)));
  return jsonOk({ results });
}

async function enrichOne(album, supaUrl, serviceKey) {
  if (!album) return { album_id: null, status: 'error', message: 'Album not found in catalog.' };

  // Path A: already has a Spotify ID — just re-pull features.
  if (album.spotify_album_id) {
    try {
      const features = await enrichFeatures(album, supaUrl, serviceKey);
      return resultEnriched(album, features);
    } catch (e) {
      return resultError(album, `features: ${e.message}`);
    }
  }

  // Path B: needs a search. Try to find a close match; if none, return
  // candidates for the UI to handle.
  let candidates = [];
  try {
    candidates = await searchAlbumCandidates(album.artist, album.album, 5);
  } catch (e) {
    return resultError(album, `search: ${e.message}`);
  }
  if (!candidates.length) {
    return { ...baseResult(album), status: 'no_match', message: 'Spotify returned 0 results.' };
  }

  const top = candidates[0];
  if (isCloseMatch(album.artist, album.album, album.year, top)) {
    await supabaseUpdate(supaUrl, serviceKey, 'albums', `id=eq.${album.id}`, {
      spotify_album_id: top.spotify_id,
      match_status: 'confirmed',
    });
    const bound = { ...album, spotify_album_id: top.spotify_id };
    try {
      const features = await enrichFeatures(bound, supaUrl, serviceKey);
      return resultEnriched(bound, features, 'auto-confirmed');
    } catch (e) {
      return resultError(bound, `features after auto-confirm: ${e.message}`);
    }
  }

  return { ...baseResult(album), status: 'needs_manual', candidates };
}

// ─── Manual confirm (POST) ─────────────────────────────────────────────────

async function handleManualConfirm(req, supaUrl, serviceKey) {
  let body;
  try { body = await req.json(); }
  catch { return jsonError(400, 'Invalid JSON body.'); }

  const { album_id, spotify_album_id, overwrite_metadata } = body || {};
  if (!album_id || !spotify_album_id) {
    return jsonError(400, 'Body must include album_id and spotify_album_id.');
  }

  const rows = await supabaseSelect(supaUrl, serviceKey, 'albums',
    `id=eq.${album_id}&select=id,artist,album,year,spotify_album_id,match_status`);
  const album = rows?.[0];
  if (!album) return jsonError(404, 'Album not in catalog.');

  const patch = { spotify_album_id, match_status: 'manual' };

  // Optionally overwrite the typo-laden artist/album name with the canonical
  // Spotify version. UI exposes this as a toggle.
  if (overwrite_metadata) {
    try {
      const details = await getAlbumDetails(spotify_album_id);
      patch.artist = details.artists?.map(a => a.name).join(', ') || album.artist;
      patch.album  = details.name || album.album;
      const yr = /^(\d{4})/.exec(details.release_date || '');
      if (yr) patch.year = Number(yr[1]);
    } catch (e) {
      console.warn('Could not fetch canonical metadata, sticking with user values:', e.message);
    }
  }

  await supabaseUpdate(supaUrl, serviceKey, 'albums', `id=eq.${album.id}`, patch);

  const bound = { ...album, ...patch };
  try {
    const features = await enrichFeatures(bound, supaUrl, serviceKey);
    return jsonOk({ result: resultEnriched(bound, features, 'manually-confirmed') });
  } catch (e) {
    return jsonOk({ result: resultError(bound, `features after manual confirm: ${e.message}`) });
  }
}

// ─── Feature pull + upsert ─────────────────────────────────────────────────

async function enrichFeatures(album, supaUrl, serviceKey) {
  const details = await getAlbumDetails(album.spotify_album_id);
  const trackIds = (details.tracks?.items || []).map(t => t.id).filter(Boolean);
  const audioFeatures = trackIds.length ? await getAudioFeatures(trackIds) : [];

  // Primary artist drives genre tags. Spotify exposes genres on artist, not album.
  const primaryArtistId = details.artists?.[0]?.id || null;
  const genres = primaryArtistId ? await getArtistGenres(primaryArtistId) : [];

  const agg = aggregateFeatures(details, audioFeatures);

  const row = {
    album_id: album.id,
    danceability: agg.danceability ?? null,
    energy: agg.energy ?? null,
    valence: agg.valence ?? null,
    acousticness: agg.acousticness ?? null,
    instrumentalness: agg.instrumentalness ?? null,
    tempo: agg.tempo ?? null,
    loudness: agg.loudness ?? null,
    key: agg.key ?? null,
    genres,
    track_count: agg.track_count ?? trackIds.length,
    raw: { tracks: audioFeatures },  // keep raw track-level for later re-aggregation
    fetched_at: new Date().toISOString(),
  };
  await supabaseUpsert(supaUrl, serviceKey, 'spotify_features', row, 'album_id');
  return row;
}

// ─── Result shapers ────────────────────────────────────────────────────────

function baseResult(album) {
  return { album_id: album.id, artist: album.artist, album: album.album, year: album.year };
}
function resultEnriched(album, features, note) {
  return {
    ...baseResult(album),
    status: 'enriched',
    spotify_album_id: album.spotify_album_id,
    features: {
      danceability: features.danceability,
      energy: features.energy,
      valence: features.valence,
      acousticness: features.acousticness,
      instrumentalness: features.instrumentalness,
      tempo: features.tempo,
      loudness: features.loudness,
      key: features.key,
      genres: features.genres,
      track_count: features.track_count,
    },
    note,
  };
}
function resultError(album, message) {
  return { ...baseResult(album), status: 'error', message };
}
