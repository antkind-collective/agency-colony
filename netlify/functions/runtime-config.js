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
      appBaseUrl: process.env.APP_BASE_URL || 'https://app.youragency.com',
      allowedDomain: 'youragency.com',
      // The app shows "Create account" instead of "Open reseller request" only
      // when the service account is configured — a half-set-up deploy must
      // fall back to the old path, not to a button that errors.
      workspaceProvisioning: Boolean(process.env.GOOGLE_SA_JSON && process.env.GOOGLE_ADMIN_IMPERSONATE),
      papersign: Boolean(process.env.PAPERSIGN_API_TOKEN),
      // Drive mirror rides on the same service account; the folder id lives
      // in app_config so it needs no env slot.
      driveMirror: Boolean(process.env.GOOGLE_SA_JSON && process.env.GOOGLE_ADMIN_IMPERSONATE)
    })
  };
};
