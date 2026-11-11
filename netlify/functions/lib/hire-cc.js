// Alex is copied on every email a new hire receives, so she sees the whole
// joining experience from their side (8 Oct 2026: "until I ask you to remove
// me"). app_config 'hire_email_cc' (a list) overrides; set it to [] to stop.
const DEFAULT_HIRE_EMAIL_CC = ['admin@youragency.com'];

async function hireEmailCc(supabase) {
  try {
    const { data } = await supabase.from('app_config').select('value').eq('key', 'hire_email_cc').maybeSingle();
    if (Array.isArray(data?.value)) return data.value.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  } catch (e) { /* fall back */ }
  return DEFAULT_HIRE_EMAIL_CC;
}

module.exports = { DEFAULT_HIRE_EMAIL_CC, hireEmailCc };
