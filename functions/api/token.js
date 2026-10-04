// Swaps an OAuth code for a token. It is the only code that sees GITHUB_CLIENT_SECRET, and it
// stores and logs nothing.
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  const origin = new URL(request.url).origin;
  if (request.headers.get('Origin') !== origin) return json({ error: 'Cross-origin request refused.' }, 403);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return json({ error: 'Login is not configured on this deployment.' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Bad request.' }, 400);
  }
  const { code, code_verifier: verifier } = body ?? {};
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(code)) return json({ error: 'Bad code.' }, 400);
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return json({ error: 'Bad verifier.' }, 400);

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'oak-dashboard' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      redirect_uri: `${origin}/auth/callback`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) return json({ error: data.error_description || data.error || `GitHub answered ${res.status}.` }, 400);
  return json({ access_token: data.access_token });
}
