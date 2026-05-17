// Shared Claude API helpers.
// Calls go straight to api.anthropic.com — keeps the key server-side.

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const MODEL_SONNET = 'claude-sonnet-4-6';
export const MODEL_HAIKU = 'claude-haiku-4-5-20251001';

export async function callClaude({ apiKey, system, user, model = MODEL_SONNET, maxTokens = 4096, temperature }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: user }],
  };
  if (system) body.system = system;
  if (temperature != null) body.temperature = temperature;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || '';
}

// Pulls a JSON value out of Claude's response. Tolerant of:
//   - bare JSON output (what the prompt asks for)
//   - JSON wrapped in ```json … ``` fences
//   - leading/trailing prose surrounding the JSON
//   - NDJSON: a stream of {...} (or [...]) values without an enclosing array,
//     which Claude occasionally produces despite "output an array" prompts.
//     Returned as an array unless there's only one value.
export function parseClaudeJson(raw) {
  if (!raw) throw new Error('Empty Claude response.');
  let s = raw.trim();

  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();

  let firstErr;
  try { return JSON.parse(s); } catch (e) { firstErr = e; }

  // NDJSON: scan top-level JSON values from the start.
  const ndjson = tryParseNdjson(s);
  if (ndjson) return ndjson;

  // Prose-wrapped: slice the outermost { ... } or [ ... ].
  const first = s.search(/[\[{]/);
  if (first < 0) throw new Error(`Couldn't find JSON in response: ${raw.slice(0, 200)}`);
  const opener = s[first];
  const closer = opener === '{' ? '}' : ']';
  const last = s.lastIndexOf(closer);
  if (last <= first) throw new Error(`Truncated JSON in response: ${raw.slice(0, 200)}`);
  try {
    return JSON.parse(s.slice(first, last + 1));
  } catch {
    const sliceNd = tryParseNdjson(s.slice(first));
    if (sliceNd) return sliceNd;
    throw firstErr;
  }
}

// Scan `s` for one or more top-level JSON values ({...} or [...]) separated
// by whitespace (and tolerate trailing prose). Returns the values as an
// array (or the single value if there's exactly one), or null if the scan
// can't recover anything.
function tryParseNdjson(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] !== '{' && s[i] !== '[') break;          // hit non-JSON prose, stop scanning
    const end = findBalancedEnd(s, i);
    if (end < 0) return null;
    try { out.push(JSON.parse(s.slice(i, end + 1))); }
    catch { return null; }
    i = end + 1;
  }
  if (out.length === 0) return null;
  if (out.length === 1) return out[0];
  return out;
}

function findBalancedEnd(s, start) {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
