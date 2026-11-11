exports.handler = async () => {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify({
      supabaseUrl: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null,
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null,
      // Public endpoint, served on Circle too: the anon key and feature flags
      // only. appBaseUrl + allowedDomain were dropped 22 Sep 2026 (access
      // parity audit): no client code read them, and appBaseUrl named the
      // staff host to every Circle client. tests/functions-authz pins the keys.
      // The app shows "Create account" instead of "Open reseller request" only
      // when the service account is configured — a half-set-up deploy must
      // fall back to the old path, not to a button that errors.
      workspaceProvisioning: Boolean(process.env.GOOGLE_SA_JSON && process.env.GOOGLE_ADMIN_IMPERSONATE),
      papersign: Boolean(process.env.PAPERSIGN_API_TOKEN),
      ai: Boolean(process.env.ANTHROPIC_API_KEY),
      // Set by the installer. Undefined on a hand-configured site: Google stays.
      loginGoogle: process.env.LOGIN_GOOGLE === undefined ? undefined : process.env.LOGIN_GOOGLE === '1',
      loginEmail: process.env.LOGIN_EMAIL === '1',
      // Drive mirror rides on the same service account; the folder id lives
      // in app_config so it needs no env slot.
      driveMirror: Boolean(process.env.GOOGLE_SA_JSON && process.env.GOOGLE_ADMIN_IMPERSONATE)
    })
  };
};
