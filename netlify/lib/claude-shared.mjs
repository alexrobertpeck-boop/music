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
export function parseClaudeJson(raw) {
  if (!raw) throw new Error('Empty Claude response.');
  let s = raw.trim();

  // Strip markdown fences if Claude included them.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();

  // Try direct parse first.
  try { return JSON.parse(s); } catch {}

  // Fall back to slicing the outermost { ... } or [ ... ].
  const first = s.search(/[\[{]/);
  if (first < 0) throw new Error(`Couldn't find JSON in response: ${raw.slice(0, 200)}`);
  const opener = s[first];
  const closer = opener === '{' ? '}' : ']';
  const last = s.lastIndexOf(closer);
  if (last <= first) throw new Error(`Truncated JSON in response: ${raw.slice(0, 200)}`);
  return JSON.parse(s.slice(first, last + 1));
}
