const Anthropic = require('@anthropic-ai/sdk');

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { callerIs } = require('./lib/caller');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.APP_BASE_URL || 'https://app.youragency.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  // Verify auth — validate Supabase access token against the auth server
  const authHeader = event.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return {
      statusCode: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }
  const token = authHeader.slice(7);
  try {
    const supabase = getSupabaseAdmin();
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return {
        statusCode: 401,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid or expired token' }),
      };
    }
    // Employees only (audit 16 Sep 2026): a partner or candidate token passed
    // the check above and could spend the Anthropic key. Analytics is an
    // employee screen; neither Circle nor the joining checklist calls this.
    if (!await callerIs(token, 'is_employee')) {
      return { statusCode: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Employees only' }) };
    }
  } catch (authEx) {
    return {
      statusCode: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Auth verification failed' }),
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const { analysisType, data, clientName, viewMode, benchmarks } = body;

  if (!analysisType || !data) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing analysisType or data' }),
    };
  }

  const validAnalysisTypes = ['monthly', 'weekly', 'post', 'brand-signal', 'instagram', 'community_pulse', 'comparison'];
  if (!validAnalysisTypes.includes(analysisType)) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Invalid analysisType. Must be one of: ${validAnalysisTypes.join(', ')}` }),
    };
  }

  if (clientName !== undefined && (typeof clientName !== 'string' || clientName.length > 200)) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'clientName must be a string (max 200 chars)' }),
    };
  }

  if (viewMode !== undefined && viewMode !== 'organic' && viewMode !== 'sponsored') {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'viewMode must be "organic" or "sponsored"' }),
    };
  }

  try {
    const client = new Anthropic({ apiKey });
    const prompt = buildPrompt(analysisType, data, clientName, viewMode, benchmarks);

    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
      system: SYSTEM_PROMPT,
    });

    const text = response.content[0]?.text || '';

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        insights: text,
        usage: {
          input_tokens: response.usage?.input_tokens || 0,
          output_tokens: response.usage?.output_tokens || 0,
        },
      }),
    };
  } catch (err) {
    console.error('Claude API error:', err.message);
    return {
      statusCode: 502,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to generate insights' }),
    };
  }
};

// --- System prompt ---
const SYSTEM_PROMPT = `You are a senior social media strategist (LinkedIn and Instagram) at Your Agency, a digital marketing agency. You're writing internal performance notes for the account management team.

Rules:
• Be specific — always cite actual numbers, percentages, and deltas. Never say "impressions increased" without saying by how much.
• Use percentages EXACTLY as provided in the data. If you must derive one, it is (new − old) ÷ OLD — dividing by the new value is wrong and has produced wrong briefs. When unsure, give the absolute delta only.
• Be direct — skip preamble. Start with the most important finding.
• Be actionable — every recommendation must be something the team can do this week, not generic advice like "post more consistently."
• Use plain text only — no markdown headers, bold, or formatting. Use bullet points (•) for lists.
• Format for SKIMMING: short labeled sections, then one-sentence bullets. Never write a paragraph longer than two sentences — a wall of prose gets skipped between calls, which defeats the whole note.
• One claim per bullet, AT MOST 25 words. If a bullet needs "and" or a second clause, it's two bullets.
• Keep it concise — the team reads these quickly between calls.
• When numbers are provided for organic vs sponsored context, tailor your analysis to that specific channel.`;


// Generic A-vs-B comparison brief (LinkedIn weekly windows, Community sends).
// The insight is the summary of the comparison ON SCREEN — same windows as the
// tiles — and every delta arrives precomputed; the model quotes, never divides.
function buildComparisonPrompt(data, client) {
  const c = data?.comparison;
  if (!c || !c.aLabel) return `No comparison data available for ${client}.`;
  const deltas = Object.entries(c.precomputedDeltas || {})
    .map(([k, v]) => `• ${k}: ${v}`).join('\n') || '(nothing moved)';
  const totals = (label, t) => t && Object.keys(t).length
    ? `\n${label} TOTALS: ` + Object.entries(t)
        .filter(([k]) => !/^(week|date|name|send_type)$/.test(k))
        .map(([k, v]) => `${k}: ${typeof v === 'number' && v < 1 && /rate/i.test(k) ? (v * 100).toFixed(2) + '%' : Number(v).toLocaleString()}`)
        .join('  |  ')
    : '';

  return `${data.channel || 'Channel'} comparison for ${client}: ${c.aLabel} vs ${c.bLabel}.${c.note ? ` (${c.note})` : ''}
${totals(c.aLabel, c.aTotals)}${totals(c.bLabel, c.bTotals)}

PRECOMPUTED CHANGES (quote these EXACTLY — never derive your own percentages):
${deltas}
${audienceSection(data)}
Write a SHORT comparative brief — it sits next to tiles showing the raw numbers, so interpret rather than restate. Sections:

1. What moved
The 2-3 changes that matter, quoting the precomputed figures. If everything is flat, one line.

2. Likely why
Only what the data supports; say plainly what's missing rather than inventing a cause.
${data.audience ? `
3. Audience fit
1-2 bullets on who this audience actually is${data.audience.targetPersona ? ' and how it matches the stated target' : ''}. ${data.audience.targetPersona ? '' : 'NO target persona is defined for this client — describe the audience makeup; do NOT invent a target to judge against.'}

4. Do next` : `
3. Do next`}
2-3 concrete moves for the coming week. No generic advice.

Under 200 words total.`;
}

// Audience block for the comparison prompt. The target persona comes from
// per-client config — the retired brand-signal prompt hardcoded a pharma/
// biotech ICP and judged every client against it, activism nonprofits
// included.
function audienceSection(data) {
  const a = data && data.audience;
  if (!a) return '';
  const seg = (label, list) => Array.isArray(list) && list.length
    ? `${label}: ${list.slice(0, 5).map(x => `${x.name} (${x.count})`).join(', ')}\n` : '';
  const fd = a.followerDemographics || {};
  const vd = a.visitorDemographics || {};
  const persona = a.targetPersona
    ? `TARGET PERSONA (from client config): industries ${a.targetPersona.industriesLabel || (a.targetPersona.industries || []).join(', ')}; functions ${a.targetPersona.jobFunctionsLabel || (a.targetPersona.jobFunctions || []).join(', ')}; seniority ${a.targetPersona.seniorityLabel || ''}\n`
    : 'TARGET PERSONA: none defined for this client.\n';
  const lines = seg('Follower industries', fd.industry) + seg('Follower functions', fd.job_function)
    + seg('Visitor industries', vd.industry) + seg('Visitor functions', vd.job_function);
  if (!lines) return '';
  return `\nAUDIENCE:\n${persona}${lines}`;
}

// --- Prompt builders ---

// Precomputed deltas ride in from the client (same math as the tiles). The
// model QUOTES them — asked to derive, it picked wrong denominators and
// invented baselines.
function precomputedBlock(data) {
  const d = data && data.precomputedDeltas;
  if (!d || !Object.keys(d).length) return '';
  const lines = Object.entries(d).map(([k, v]) => `• ${k}: ${v}`).join('\n');
  return `\nPRECOMPUTED CHANGES, latest vs previous (quote these EXACTLY — never derive your own percentages):\n${lines}\n`;
}


function buildPrompt(type, data, clientName, viewMode, benchmarks) {
  const client = clientName || 'this client';
  const channel = viewMode === 'sponsored' ? 'Sponsored' : 'Organic';

  if (type === 'monthly') {
    return buildMonthlyPrompt(data, client, channel);
  }
  if (type === 'weekly') {
    return buildWeeklyPrompt(data, client, channel);
  }
  if (type === 'post') {
    return buildPostPrompt(data, client, benchmarks);
  }
  if (type === 'brand-signal') {
    return buildBrandSignalPrompt(data, client);
  }
  if (type === 'instagram') {
    return buildInstagramPrompt(data, client);
  }
  if (type === 'community_pulse') {
    return buildCommunityPulsePrompt(data, client);
  }
  if (type === 'comparison') {
    return buildComparisonPrompt(data, client);
  }

  return `Analyze this LinkedIn data for ${client}:\n${JSON.stringify(data).substring(0, 3000)}`;
}

function buildCommunityPulsePrompt(data, client) {
  const sends = Array.isArray(data?.sends) ? data.sends : [];
  const s = data?.summary || {};
  const demo = data?.demographics || {};
  if (!sends.length) return `No community sends data available for ${client}.`;

  const pct = (f) => `${((f || 0) * 100).toFixed(1)}%`;
  const table = sends.map(r =>
    `${r.date}  |  ${r.send_type}  |  "${r.name}"  |  delivered ${(r.delivered || 0).toLocaleString()}  |  open ${pct(r.open_rate)}  |  click ${pct(r.click_rate)}  |  unsubs ${r.unsubscribed || 0}  |  bounced ${r.hard_bounce || 0}`
  ).join('\n');

  const byType = Object.entries(s.by_type || {}).map(([t, v]) =>
    `${t}: ${v.sends} sends, open ${pct(v.open_rate)}, click ${pct(v.click_rate)}`
  ).join(' | ');

  const seg = (label, list) => (Array.isArray(list) && list.length)
    ? `${label}: ${list.slice(0, 8).map(x => `${x.name} (${x.count})`).join(', ')}\n` : '';
  const growth = (demo.subscribers?.growth_by_month || []).slice(-8).map(g => `${g.month}: +${g.count}`).join('  ');

  return `Community pulse analysis for ${client} — their newsletter, dispatches, surveys, and community forum.

This is a MOVEMENT-BUILDING organization, not a brand. Analyze through a movement lens:
opens are ATTENTION; clicks, survey responses, forum joins, and opportunity uptake are PARTICIPATION.
A movement's health is measured by participation and belonging, not reach.

${precomputedBlock(data)}
SUMMARY: ${s.total_sends || sends.length} sends, ${s.date_from || '?'} – ${s.date_to || '?'} | overall open ${pct(s.open_rate)}, click ${pct(s.click_rate)} | ${(s.subscribers || 0).toLocaleString()} subscribers | ${(s.forum_members || 0).toLocaleString()} forum members
BY SEND TYPE: ${byType}

SENDS (oldest to newest):
${table}

${growth ? `SUBSCRIBER GROWTH BY MONTH: ${growth}\n` : ''}${seg('Subscriber regions', demo.subscribers?.by_region)}${seg('Forum domains of work', demo.forum?.by_domain)}${seg('Forum regions', demo.forum?.by_region)}
Provide:

1. Participation Pulse
Beyond opens, where is the community actually ACTING? Compare send types — which formats convert attention into participation (clicks, survey responses)? Cite the specific sends and rates.

2. Community Health
Is the base growing, engaged, and diverse (regions, domains of work)? What do unsubscribe patterns say about list quality vs churn?

3. What the Network Wants
From which sends drew action, infer what this community values (opportunities, resources, gatherings, stories). Be specific about the evidence.

4. Recommendations
2-3 concrete moves for the next month of sends — send type mix, cadence, content focus. Reference actual numbers.`;
}

function buildInstagramPrompt(data, client) {
  const posts = Array.isArray(data?.posts) ? data.posts : [];
  const s = data?.summary || {};
  const dailyMetrics = Array.isArray(data?.dailyMetrics) ? data.dailyMetrics : [];

  // Comparison mode: the user picked A-vs-B windows in the UI, and the insight
  // is the SUMMARY OF THAT COMPARISON — not a whole-file retrospective (nobody
  // acts on "May 5-6 spiked" in October; data needs perspective — Alex).
  if (data?.comparison && data.comparison.a && data.comparison.b) {
    const c = data.comparison;
    const fmtTotals = (t) => Object.entries(t || {})
      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${Math.round(Number(v) || 0).toLocaleString()}`)
      .join('  |  ');
    const dailyTable = (rows, label) => Array.isArray(rows) && rows.length
      ? `\n${label} daily:\n` + rows.map(r => {
          const keys = Object.keys(r).filter(k => k !== 'date');
          return `${r.date}  |  ${keys.map(k => `${k}: ${r[k]}`).join('  |  ')}`;
        }).join('\n')
      : '';
    const postLines = posts.length
      ? `\nPOSTS INSIDE THESE WINDOWS:\n` + posts.map(p =>
          `${p.date || '?'}  |  ${(p.views || 0).toLocaleString()} views  |  ${p.likes || 0} likes  |  ${p.type || 'post'}  |  "${p.description || ''}"`).join('\n')
      : '\n(No post-level rows fall inside these windows.)';

    return `Instagram comparison for ${client}: ${c.a.label} vs ${c.b.label}.${c.note ? ` (${c.note})` : ''}

${c.a.label} TOTALS: ${fmtTotals(c.a.totals)}
${c.b.label} TOTALS: ${fmtTotals(c.b.totals)}
${c.precomputedPct && Object.keys(c.precomputedPct).length ? `PRECOMPUTED CHANGES A vs B (quote these EXACTLY — never derive your own percentages):\n` + Object.entries(c.precomputedPct).map(([k, v]) => `• ${k.replace(/_/g, ' ')}: ${v}`).join('\n') : ''}
${dailyTable(c.a.daily, c.a.label)}${dailyTable(c.b.daily, c.b.label)}${postLines}

Write a SHORT comparative brief — it sits next to tiles that already show the raw numbers, so interpret rather than restate. Sections:

1. What moved
The 2-3 metric changes that matter, each with its % change. Skip metrics that barely moved. If everything is flat, say so in one line.

2. Likely why
Connect movements to specific posts/days where the data supports it. Where it doesn't, say plainly what data is missing — never invent a cause.

3. Do next week
2-3 concrete moves grounded in what moved. No generic social-media advice.

Keep the whole thing under 180 words. Cite real numbers.`;
  }

  // Daily account metrics from the Insights CSV uploads (follows/views/…)
  let metricsSection = '';
  if (dailyMetrics.length) {
    const keys = [...new Set(dailyMetrics.flatMap(r => Object.keys(r)))].filter(k => k !== 'date').sort();
    const rows = dailyMetrics.map(r => `${r.date}  |  ${keys.map(k => `${k}: ${r[k] === undefined ? '-' : r[k]}`).join('  |  ')}`).join('\n');
    metricsSection = `

DAILY ACCOUNT METRICS (${dailyMetrics.length} days: ${keys.join(', ')}):
${rows}

For the daily metrics: identify the trend, name spike days with their values, and connect spikes to specific posts where the dates line up. A '-' means that metric wasn't uploaded for that day — treat it as missing, not zero.`;
  }

  if (!posts.length && dailyMetrics.length) {
    return `Instagram account-trends analysis for ${client}. No post-level export has been uploaded yet — analyze the account metrics only.
${metricsSection}

Provide:

1. Trend Read
What's the overall trajectory of each metric? Cite actual numbers and dates.

2. Spike Days
Which days spiked and by how much vs the baseline? What might have driven them?

3. Recommendations
2-3 concrete moves. Also note that uploading the post-level export (Meta Business Suite posts CSV/XLSX) would let this analysis connect spikes to specific posts.`;
  }
  if (!posts.length) return `No Instagram post data available for ${client}.`;

  const table = posts.map(p =>
    `${p.date || '?'}  |  ${(p.views || 0).toLocaleString()} views  |  reach ${(p.reach || 0).toLocaleString()}  |  ${p.likes || 0} likes  |  ${p.comments || 0} comments  |  ${p.saves || 0} saves  |  ${p.shares || 0} shares  |  ${p.follows || 0} follows  |  ${p.type || 'post'}${p.durationSec ? ` (${p.durationSec}s)` : ''}  |  "${p.description || ''}"`
  ).join('\n');

  const summaryLine = `Account: ${s.account_name || client}${s.account_username ? ` (@${s.account_username})` : ''} | Period: ${s.date_from || '?'} – ${s.date_to || '?'} | ${s.total_posts || posts.length} posts | ${(s.total_views || 0).toLocaleString()} views | ${(s.total_likes || 0).toLocaleString()} likes | ${(s.total_comments || 0).toLocaleString()} comments | ${(s.total_saves || 0).toLocaleString()} saves | ${(s.total_shares || 0).toLocaleString()} shares | ${s.total_follows || 0} follows | avg engagement ${s.avg_engagement || '?'}%`;

  return `Instagram performance analysis for ${client}.

SUMMARY: ${summaryLine}

POSTS (top ${posts.length} by views):
${table}
${metricsSection}
DATA CAVEAT: Meta's exports often zero-fill fields they didn't capture (reach, follows, saves can be 0 on rows with high views). Treat suspiciously uniform zeros as MISSING data, not as literal performance — never diagnose "no reach despite views" from zero-filled fields. Base conclusions on fields that vary across rows.

Analyze the full post set. Provide:

1. What's Working
Which posts, formats (reel vs static vs carousel), lengths, topics, and hooks over-perform? Cite the specific posts and numbers. Saves and shares signal deeper resonance than likes — weight them accordingly.

2. What's Not
Which content consistently under-performs, and what do those posts have in common?

3. Follower Conversion
Which posts actually drove follows? Reach without follows is rented attention — call out the difference.

4. Recommendations
2-3 concrete content moves for next month based on the patterns above (topic, format, length, hook style). Reference actual posts as evidence.`;
}

// Full report-context blocks for the analysis prompts. The analyses should
// read EVERYTHING the uploaded reports can say: every post with full metrics,
// follower gains + demographics, visitor trends. Aggregate totals alone
// misdiagnose content-mix swings — a recruitment-post reach spike ending
// reads as "reach collapsed" (real case: Example Collective, Jun 2026).
function postsSection(posts, label) {
  if (!Array.isArray(posts) || !posts.length) return '';
  const rows = posts.map(p =>
    `${p.date || '?'}  |  ${(p.impressions || 0).toLocaleString()} impr  |  ${p.clicks || 0} clicks  |  ${p.reactions || 0} reactions  |  ${p.comments || 0} comments  |  ${p.reposts || 0} reposts  |  ${p.type || 'post'}  |  "${p.title || ''}"`
  ).join('\n');
  return `

${label || 'ALL POSTS in this window'} (by impressions):
${rows}

Before diagnosing any sharp reach swing, check the post list: distinguish a content-mix effect ending (e.g. hiring/recruitment or announcement posts routinely out-reach normal content on LinkedIn) from a genuine distribution problem, and name the specific posts responsible. If a spike was driven by one or two outlier posts, state what the baseline looks like excluding them. Also look for content patterns: which topics, hooks, or formats consistently over- or under-perform.`;
}

function segLine(label, list) {
  if (!Array.isArray(list) || !list.length) return '';
  return `${label}: ${list.map(s => `${s.name} (${s.count})`).join(', ')}\n`;
}

function followersSection(followers) {
  if (!followers) return '';
  const daily = (followers.daily || []).map(d => `${d.date}: +${d.gained}`).join('  ');
  const demo = followers.demographics;
  const demoText = demo
    ? segLine('Top job functions', demo.jobFunctions) + segLine('Top industries', demo.industries) + segLine('Seniority', demo.seniority) + segLine('Locations', demo.locations) + segLine('Company size', demo.companySize)
    : '';
  return `

FOLLOWERS in this window: +${followers.gainedInWindow || 0} total
${daily ? `Daily gains: ${daily}` : ''}
${demoText ? `Follower base demographics:\n${demoText}` : ''}
Cross-reference: did follower gains track the reach spikes, and are the gains landing in the client's target segments?`;
}

function visitorsSection(visitors) {
  if (!visitors) return '';
  const daily = (visitors.daily || []).map(d => `${d.date}: ${d.unique}u/${d.views}v`).join('  ');
  const demo = visitors.demographics;
  const demoText = demo
    ? segLine('Visitor job functions', demo.jobFunctions) + segLine('Visitor industries', demo.industries) + segLine('Visitor seniority', demo.seniority)
    : '';
  return `

PAGE VISITORS in this window: ${visitors.uniqueVisitorsInWindow || 0} unique
${daily ? `Daily (unique/views): ${daily}` : ''}
${demoText || ''}`;
}

function contextSections(rawData) {
  if (Array.isArray(rawData) || !rawData) return '';
  return postsSection(rawData.recentPosts || rawData.posts) + followersSection(rawData.followers) + visitorsSection(rawData.visitors);
}

function buildMonthlyPrompt(rawData, client, channel) {
  const data = Array.isArray(rawData) ? rawData : (rawData?.months || []);
  // Only analyze last 3 months (with 1 prior month for context)
  const allMonths = data.slice(-4);
  const months = data.slice(-3);
  if (!months.length) return `No monthly data available for ${client}.`;

  const imprKey = channel === 'Sponsored' ? 'Impressions (sponsored)' : 'Impressions (organic)';

  const firstMonth = months[0]?.month || '';
  const lastMonth = months[months.length - 1]?.month || '';

  // Build readable table
  const table = allMonths.map(m => {
    const impr = m[imprKey] || 0;
    const clicks = m['Clicks (total)'] || 0;
    const reactions = m['Reactions (total)'] || 0;
    const comments = m['Comments (total)'] || 0;
    const reposts = m['Reposts (total)'] || 0;
    const engRate = ((m['Engagement rate (total)'] || 0) * 100).toFixed(2);
    const ctr = impr > 0 ? ((clicks / impr) * 100).toFixed(2) : '0.00';
    return `${m.month}  |  Impr: ${impr.toLocaleString()}  |  Clicks: ${clicks}  |  CTR: ${ctr}%  |  Reactions: ${reactions}  |  Comments: ${comments}  |  Reposts: ${reposts}  |  Eng: ${engRate}%`;
  }).join('\n');

  // Compare the 3 months against each other
  const latest = months[months.length - 1];
  const prior = months.length > 1 ? months[months.length - 2] : null;

  return `Analysis for ${firstMonth} – ${lastMonth}: ${channel} channel, ${client}.
${precomputedBlock(rawData)}
Start your response with "Analysis for ${firstMonth} – ${lastMonth}".

DATA (${allMonths.length} months, oldest to newest):
${table}${contextSections(rawData)}

Analyze the last 3 months. Provide:

1. Performance Summary
What's the trajectory over these 3 months? Is ${channel.toLowerCase()} reach growing, flat, or declining? How is engagement trending relative to impressions?

2. Standout Months
Which of the 3 months was best and worst? What might explain the difference? Use the post list to attribute spikes or dips to specific content where the data supports it.

3. Recommendations
2-3 specific things the AM team should do next month. Be concrete (e.g., "Increase posting frequency from 2x to 3x/week since October's 3-post weeks averaged 40% higher impressions" — not "post more").`;
}

function buildWeeklyPrompt(rawData, client, channel) {
  const data = Array.isArray(rawData) ? rawData : (rawData?.weeks || []);
  // Only analyze last 4 weeks (with 1 prior week for context)
  const allWeeks = data.slice(-5);
  const weeks = data.slice(-4);
  if (!weeks.length) return `No weekly data available for ${client}.`;

  const imprKey = channel === 'Sponsored' ? 'Impressions (sponsored)' : 'Impressions (organic)';

  const firstWeek = weeks[0]?.week || '';
  const lastWeek = weeks[weeks.length - 1]?.week || '';

  const table = allWeeks.map(w => {
    const impr = w[imprKey] || 0;
    const clicks = w['Clicks (total)'] || 0;
    const reactions = w['Reactions (total)'] || 0;
    const comments = w['Comments (total)'] || 0;
    const engRate = ((w['Engagement rate (total)'] || 0) * 100).toFixed(2);
    const ctr = impr > 0 ? ((clicks / impr) * 100).toFixed(2) : '0.00';
    return `${w.week}  |  Impr: ${impr.toLocaleString()}  |  Clicks: ${clicks}  |  CTR: ${ctr}%  |  Reactions: ${reactions}  |  Comments: ${comments}  |  Eng: ${engRate}%`;
  }).join('\n');

  // Week-over-week momentum
  const latest = weeks[weeks.length - 1];
  const prev = weeks.length > 1 ? weeks[weeks.length - 2] : null;
  let momentum = '';
  if (latest && prev) {
    const lastImpr = latest[imprKey] || 0;
    const prevImpr = prev[imprKey] || 0;
    const delta = prevImpr > 0 ? (((lastImpr - prevImpr) / prevImpr) * 100).toFixed(1) : 'N/A';
    const lastEng = (latest['Engagement rate (total)'] || 0) * 100;
    const prevEng = (prev['Engagement rate (total)'] || 0) * 100;
    const engDelta = prevEng > 0 ? (((lastEng - prevEng) / prevEng) * 100).toFixed(1) : 'N/A';
    momentum = `Latest week vs previous: Impressions ${delta}%, Engagement rate ${engDelta}%`;
  }

  return `Analysis for ${firstWeek} – ${lastWeek}: ${channel} channel, ${client}.
${precomputedBlock(rawData)}
Start your response with "Analysis for ${firstWeek} – ${lastWeek}".

DATA (${allWeeks.length} weeks, oldest to newest):
${table}
${momentum ? `LATEST MOMENTUM: ${momentum}` : ''}${contextSections(rawData)}

Analyze the last 4 weeks. Provide:

1. This Week's Pulse
How did the most recent week perform? Is it continuing a trend or an outlier?

2. Patterns
Any consistent patterns across the 4 weeks — is there a trend in engagement vs reach? Use the post list to attribute reach spikes or dips to specific content where the data supports it.

3. Recommendations
2-3 specific tactical moves for next week. Reference actual numbers from the data.`;
}

function buildPostPrompt(data, client, benchmarks) {
  const p = data;
  const title = p['Post title'] || 'Untitled';
  const type = p['Post type'] || 'Unknown';
  const impr = p['Impressions'] || 0;
  const clicks = p['Clicks'] || 0;
  const likes = p['Likes'] || 0;
  const comments = p['Comments'] || 0;
  const reposts = p['Reposts'] || 0;
  const engRate = p['Engagement rate'] || 0;
  const ctr = impr > 0 ? ((clicks / impr) * 100).toFixed(2) : '0.00';
  const engScore = p['engagement_score'] || 0;

  let benchmarkSection = '';
  if (benchmarks) {
    const b = benchmarks;
    const imprVsAvg = b.avgImpressions > 0 ? (((impr - b.avgImpressions) / b.avgImpressions) * 100).toFixed(0) : 'N/A';
    const engVsAvg = b.avgEngRate > 0 ? (((engRate - b.avgEngRate) / b.avgEngRate) * 100).toFixed(0) : 'N/A';
    benchmarkSection = `
BENCHMARKS (vs ${client}'s ${type.toLowerCase()} post averages):
• This post: ${impr.toLocaleString()} impressions (${imprVsAvg}% vs avg of ${Math.round(b.avgImpressions).toLocaleString()})
• This post: ${(engRate * 100).toFixed(2)}% engagement (${engVsAvg}% vs avg of ${(b.avgEngRate * 100).toFixed(2)}%)
• This post: ${clicks} clicks, CTR ${ctr}% (avg CTR: ${b.avgCTR}%)
• Total ${type.toLowerCase()} posts analyzed: ${b.totalPosts}
• Best post impressions: ${b.maxImpressions.toLocaleString()} | Worst: ${b.minImpressions.toLocaleString()}`;
  }

  return `Post analysis for ${client}.

POST DETAILS:
• Title: "${title.substring(0, 300)}"
• Type: ${type}
• Date: ${p['Created date'] || 'N/A'}
• Content Type: ${p['Content Type'] || 'N/A'}
• Author: ${p['Posted by'] || 'N/A'}

METRICS:
• Impressions: ${impr.toLocaleString()}
• Clicks: ${clicks} (CTR: ${ctr}%)
• Likes: ${likes}
• Comments: ${comments}
• Reposts: ${reposts}
• Engagement Rate: ${(engRate * 100).toFixed(2)}%
• Engagement Score: ${engScore}
${benchmarkSection}

Provide:

1. Performance Verdict
Was this a strong, average, or weak post? ${benchmarks ? 'Use the benchmarks to quantify — say exactly how much above or below average.' : 'Assess based on the raw engagement signals.'}

2. What Worked / What Didn't
Identify 1-2 specific factors (content type, timing, topic) that likely helped or hurt performance.

3. Recommendation
One specific, actionable suggestion to improve the next similar post. Be precise — reference actual numbers.`;
}

function buildBrandSignalPrompt(data, client) {
  // data is scoped to last 2 weeks + demographics (aggregate)
  const { contentSummary, followerSummary, visitorSummary, followerDemographics, visitorDemographics } = data || {};
  const period = data?.period || 'recent';

  let sections = [];

  if (contentSummary) {
    const cs = contentSummary;
    let contentBlock = `CONTENT PERFORMANCE (${period}):
• Impressions: ${(cs.totalImpressions || 0).toLocaleString()}
• Avg Engagement Rate: ${((cs.avgEngagement || 0) * 100).toFixed(2)}%
• Posts published: ${cs.totalPosts || 0}`;
    if (cs.weekOverWeek) {
      const wow = cs.weekOverWeek;
      // Precomputed percentages ride along — the model must QUOTE these, not
      // derive its own (it divided by the wrong denominator twice).
      contentBlock += `\n• Week-over-week impressions change: ${wow.impressionsDelta > 0 ? '+' : ''}${wow.impressionsDelta.toLocaleString()}${wow.impressionsPctChange ? ` (${wow.impressionsPctChange} — use this exact percentage)` : ''}`;
      contentBlock += `\n• Week-over-week engagement change: ${wow.engagementDeltaPoints || `${wow.engagementDelta > 0 ? '+' : ''}${(wow.engagementDelta * 100).toFixed(2)}pp`} (percentage points — use exactly)`;
    }
    sections.push(contentBlock);
  }

  if (Array.isArray(data?.recentPostsDetail) && data.recentPostsDetail.length) {
    sections.push(postsSection(data.recentPostsDetail, 'POSTS in this window').trim());
  }

  if (followerSummary) {
    sections.push(`FOLLOWER GROWTH (last ${followerSummary.days} days):
• New followers: ${followerSummary.newFollowers}`);
  }

  if (visitorSummary) {
    sections.push(`PAGE VISITORS (last ${visitorSummary.days} days):
• Unique visitors: ${visitorSummary.totalVisits}`);
  }

  if (followerDemographics) {
    const fd = followerDemographics;
    const topIndustries = (fd.industry || []).slice(0, 5).map(i => `${i.name}: ${i.count}`).join(', ');
    const topFunctions = (fd.job_function || []).slice(0, 5).map(i => `${i.name}: ${i.count}`).join(', ');
    const topSeniority = (fd.seniority || []).slice(0, 5).map(i => `${i.name}: ${i.count}`).join(', ');
    sections.push(`FOLLOWER DEMOGRAPHICS (aggregate):
• Top Industries: ${topIndustries}
• Top Job Functions: ${topFunctions}
• Top Seniority Levels: ${topSeniority}`);
  }

  if (visitorDemographics) {
    const vd = visitorDemographics;
    const topIndustries = (vd.industry || []).slice(0, 5).map(i => `${i.name}: ${i.count}`).join(', ');
    const topFunctions = (vd.job_function || []).slice(0, 5).map(i => `${i.name}: ${i.count}`).join(', ');
    sections.push(`VISITOR DEMOGRAPHICS (aggregate):
• Top Industries: ${topIndustries}
• Top Job Functions: ${topFunctions}`);
  }

  if (!sections.length) {
    return `No data available for brand signal analysis for ${client}.`;
  }

  return `Week-on-week brand signal analysis for ${client} (${period}).

${sections.join('\n\n')}

Structure the answer EXACTLY as these three labeled sections — no preamble, no closing summary:

1. Signal
2-3 bullets: what moved week-over-week and by how much (actual numbers + %), with the likely driver where the data shows one.

2. Audience Fit
1-2 bullets: how the audience profile aligns with a B2B brand targeting pharma, biotech, and research decision-makers.

3. Next Week
1 bullet: one specific tactical move the team can execute this week.

Each bullet is ONE sentence starting with "• ". Never merge sections into a paragraph.`;
}

