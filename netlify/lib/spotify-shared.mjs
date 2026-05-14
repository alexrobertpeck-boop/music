// Shared helpers for Spotify enrichment functions.
// Single source of truth for: token cache, Spotify Web API calls,
// album-level aggregation of track audio features, Supabase REST writes,
// and JWT-based household-member verification.

export const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com';
export const SPOTIFY_API = 'https://api.spotify.com/v1';

export function getEnv(name) {
  return (typeof Netlify !== 'undefined' && Netlify.env?.get(name)) || process.env[name];
}

// ─── Spotify token (Client Credentials flow) ──────────────────────────────
// Cached in module scope across invocations within a warm function instance.
// Refreshed when within 30s of expiry.

let cachedToken = null;
let cachedExpiry = 0;

export async function getSpotifyToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExpiry - 30000) return cachedToken;

  const clientId = getEnv('SPOTIFY_CLIENT_ID');
  const clientSecret = getEnv('SPOTIFY_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not configured.');
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify token ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  cachedExpiry = now + (data.expires_in * 1000);
  return cachedToken;
}

export async function spotifyFetch(path, params = {}) {
  const token = await getSpotifyToken();
  const url = new URL(`${SPOTIFY_API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (res.status === 429) {
    // Honor Retry-After if present (Spotify returns it in seconds). Cap at
    // 5s so a single retry doesn't blow Netlify's 10s sync-function budget;
    // if Spotify wants longer the caller should re-batch later.
    const retry = Number(res.headers.get('Retry-After') || 1);
    await new Promise(r => setTimeout(r, Math.min(retry, 5) * 1000));
    return spotifyFetch(path, params);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Spotify domain calls ─────────────────────────────────────────────────

export async function searchAlbumCandidates(artist, album, limit = 5) {
  // Spotify's structured search: artist: + album:. Quoting the whole phrase
  // helps with multi-word names but punctuation/diacritics can still hurt —
  // we'll auto-confirm only on a close Levenshtein match, otherwise punt.
  const q = `artist:"${artist}" album:"${album}"`;
  const data = await spotifyFetch('/search', { q, type: 'album', limit, market: 'AU' });
  const items = data.albums?.items || [];
  return items.map(simplifyAlbumSearchHit);
}

function simplifyAlbumSearchHit(a) {
  return {
    spotify_id: a.id,
    artist: a.artists?.map(x => x.name).join(', ') || '',
    artist_id: a.artists?.[0]?.id || null,
    album: a.name,
    year: yearFromReleaseDate(a.release_date),
    release_date: a.release_date,
    cover_url: a.images?.find(i => i.width >= 200)?.url || a.images?.[0]?.url || null,
    total_tracks: a.total_tracks,
  };
}

function yearFromReleaseDate(s) {
  if (!s) return null;
  const m = /^(\d{4})/.exec(s);
  return m ? Number(m[1]) : null;
}

export async function getAlbumDetails(spotifyId) {
  // Album endpoint returns a full track list (with track ids + duration_ms)
  // and artist ids. One call per album.
  return spotifyFetch(`/albums/${spotifyId}`, { market: 'AU' });
}

export async function getAudioFeatures(trackIds) {
  // Up to 100 ids per call. Chunk if more.
  const out = [];
  for (let i = 0; i < trackIds.length; i += 100) {
    const chunk = trackIds.slice(i, i + 100);
    const data = await spotifyFetch('/audio-features', { ids: chunk.join(',') });
    for (const f of (data.audio_features || [])) if (f) out.push(f);
  }
  return out;
}

export async function getArtistGenres(artistId) {
  if (!artistId) return [];
  const data = await spotifyFetch(`/artists/${artistId}`);
  return data.genres || [];
}

// ─── Album-level aggregation ──────────────────────────────────────────────

const INTERLUDE_MS = 60_000;  // skip tracks under 60s when averaging
const NUMERIC_KEYS = ['danceability', 'energy', 'valence', 'acousticness', 'instrumentalness', 'tempo', 'loudness'];

export function aggregateFeatures(albumDetails, audioFeatures) {
  // albumDetails.tracks.items[i].duration_ms — pair by id to filter interludes
  const trackById = new Map();
  for (const t of (albumDetails.tracks?.items || [])) trackById.set(t.id, t);
  const usable = audioFeatures.filter(f => {
    const t = trackById.get(f.id);
    return t && t.duration_ms >= INTERLUDE_MS;
  });

  const source = usable.length > 0 ? usable : audioFeatures;  // fall back to all if every track is short
  if (source.length === 0) {
    return { track_count: 0 };
  }

  const agg = { track_count: source.length };
  for (const k of NUMERIC_KEYS) {
    let sum = 0, n = 0;
    for (const f of source) {
      const v = f[k];
      if (typeof v === 'number' && Number.isFinite(v)) { sum += v; n++; }
    }
    agg[k] = n > 0 ? +(sum / n).toFixed(4) : null;
  }

  // Key: mode (most common value).
  const keyCounts = {};
  for (const f of source) {
    if (typeof f.key === 'number') keyCounts[f.key] = (keyCounts[f.key] || 0) + 1;
  }
  let bestKey = null, bestN = -1;
  for (const [k, n] of Object.entries(keyCounts)) {
    if (n > bestN) { bestKey = Number(k); bestN = n; }
  }
  agg.key = bestKey;

  return agg;
}

// ─── Fuzzy matching ───────────────────────────────────────────────────────

export function normalizeName(s) {
  // Lowercase, drop punctuation/diacritics, collapse whitespace. Good enough
  // for catching "Marvin Gay" vs "Marvin Gaye" once we threshold Levenshtein.
  return (s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function levenshtein(a, b) {
  a = a || ''; b = b || '';
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

export function isCloseMatch(catalogArtist, catalogAlbum, catalogYear, candidate) {
  const ca = normalizeName(catalogArtist);
  const cb = normalizeName(catalogAlbum);
  const sa = normalizeName(candidate.artist);
  const sb = normalizeName(candidate.album);
  const artistDist = levenshtein(ca, sa);
  const albumDist  = levenshtein(cb, sb);
  // Allow a wider threshold for longer strings — proportional fallback.
  const artistOk = artistDist <= Math.max(2, Math.floor(Math.min(ca.length, sa.length) * 0.15));
  const albumOk  = albumDist  <= Math.max(2, Math.floor(Math.min(cb.length, sb.length) * 0.15));
  const yearOk   = catalogYear == null || candidate.year == null
                 || Math.abs(catalogYear - candidate.year) <= 1;
  return artistOk && albumOk && yearOk;
}

// ─── Supabase REST helpers ────────────────────────────────────────────────

function normalizeSupabaseUrl(url) {
  if (!url) return url;
  return url.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
}

export async function supabaseSelect(url, key, table, filter) {
  const base = normalizeSupabaseUrl(url);
  const res = await fetch(`${base}/rest/v1/${table}?${filter}`, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Supabase select ${table}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function supabaseUpdate(url, key, table, filter, patch) {
  const base = normalizeSupabaseUrl(url);
  const res = await fetch(`${base}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Supabase update ${table}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export async function supabaseUpsert(url, key, table, row, onConflict) {
  const base = normalizeSupabaseUrl(url);
  const query = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  const res = await fetch(`${base}/rest/v1/${table}${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${table}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// ─── User verification ───────────────────────────────────────────────────
// Reads the bearer JWT from the request, asks Supabase Auth to validate it,
// returns the user.id. Then checks the user is in household_members. We
// double-gate: the JWT proves who they are; the allowlist proves they're
// allowed to drive write-heavy server-side ops.

export async function verifyHouseholdUser(req, supaUrl, anonKey, serviceKey) {
  const authHeader = req.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) throw new Error('Missing Authorization header');
  const jwt = match[1];

  const base = normalizeSupabaseUrl(supaUrl);
  const meRes = await fetch(`${base}/auth/v1/user`, {
    headers: {
      'apikey': anonKey || serviceKey,
      'Authorization': `Bearer ${jwt}`,
    },
  });
  if (!meRes.ok) throw new Error(`Auth check failed: ${meRes.status}`);
  const user = await meRes.json();
  if (!user?.id) throw new Error('User token did not resolve.');

  const rows = await supabaseSelect(
    supaUrl, serviceKey, 'household_members',
    `user_id=eq.${user.id}&select=user_id`
  );
  if (!rows?.length) throw new Error('User is not a household member.');
  return user.id;
}

// ─── Response helpers ────────────────────────────────────────────────────

export function jsonOk(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
export function jsonError(status, message, extra = {}) {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
