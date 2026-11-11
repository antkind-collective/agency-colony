// Reads dashboard-screenshot images for ONE newsletter/dispatch send and
// returns structured stats as strict JSON.
//
// Context: Rhea's comms report (28 Jul 2026) is a Word file where each
// send's stats exist only as PASTED SCREENSHOTS of the LeadConnector
// dashboard — no tables, no text numbers. The client unzips the .docx, pairs
// images with their send heading, and calls this per send. Numbers extracted
// by vision are REVIEWED by the uploader in the app before anything is saved —
// this function's output is a proposal, not a write.
const Anthropic = require('@anthropic-ai/sdk');
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { callerIs } = require('./lib/caller');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.APP_BASE_URL || 'https://app.youragency.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PROMPT = `These are dashboard screenshots for ONE email send (a newsletter or dispatch). Read every metric visible and return ONLY a JSON object — no prose, no markdown fences — with these keys (null when the metric is not visible in any screenshot):

{"delivered": int, "delivered_rate": fraction, "opened": int, "open_rate": fraction, "clicked": int, "click_rate": fraction, "unsubscribed": int, "hard_bounce": int, "skipped": int, "total_clicks": int, "unique_clicks": int, "unique_engagements": int}

Rules:
- Rates are FRACTIONS: a tile showing "48.3%" is 0.483.
- Copy numbers EXACTLY as shown. Never compute a value from other values.
- A metric absent from every screenshot is null, not 0.
- "Clicks per unique open" style ratios: ignore unless they map to a key above.`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authHeader = event.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  const token = authHeader.slice(7);
  try {
    const supabase = getSupabaseAdmin();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid token' }) };
    // Employees only (audit 16 Sep 2026): a partner or candidate token passed
    // the check above and could spend the Anthropic key. Analytics is an
    // employee screen; neither Circle nor the joining checklist calls this.
    if (!await callerIs(token, 'is_employee')) {
      return { statusCode: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Employees only' }) };
    }
  } catch (e) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Auth verification failed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }
  const images = Array.isArray(body.images) ? body.images.slice(0, 8) : [];
  if (!images.length) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No images provided' }) };
  }

  try {
    const client = new Anthropic({ apiKey });
    const content = images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType || 'image/png', data: img.data }
    }));
    content.push({ type: 'text', text: `${PROMPT}\n\nSend: ${String(body.heading || '').slice(0, 120)}` });

    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      messages: [{ role: 'user', content }],
    });
    const text = (response.content[0]?.text || '').replace(/^```(json)?|```$/g, '').trim();
    let stats;
    try { stats = JSON.parse(text); } catch (e) {
      return { statusCode: 422, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Model did not return valid JSON', raw: text.slice(0, 300) }) };
    }
    return { statusCode: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify({ stats }) };
  } catch (err) {
    console.error('extract-send-stats error:', err.message);
    // Say why (27 Oct 2026): "Extraction failed" alone left Rhea's upload
    // undiagnosable. The SDK's status + message carry no key or user data.
    const why = err.status === 401 ? 'the AI service refused Colony\'s key'
      : `${err.status ? `${err.status} ` : ''}${String(err.message || '').slice(0, 140)}`.trim();
    return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: `Extraction failed${why ? `: ${why}` : ''}` }) };
  }
};
