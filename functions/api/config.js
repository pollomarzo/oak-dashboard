// Public settings for the page. GITHUB_CLIENT_ID is public by design; the secret never leaves
// functions/api/token.js.
const JOURNAL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

export function onRequestGet({ env }) {
  const journal = env.DEFAULT_JOURNAL && JOURNAL_RE.test(env.DEFAULT_JOURNAL) ? env.DEFAULT_JOURNAL : null;
  return Response.json(
    { clientId: env.GITHUB_CLIENT_ID || null, defaultJournal: journal },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
