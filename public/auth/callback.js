// GitHub sends the browser here with ?code&state. The state must match the one login() stored in
// this tab (CSRF check); /api/token then swaps the code for a token with the client secret.
const msg = document.getElementById('msg');
const fail = (text) => {
  msg.className = 'error';
  msg.textContent = `Login failed: ${text}`;
  const back = document.createElement('a');
  back.href = '/';
  back.textContent = ' Back to the dashboard';
  msg.append(back);
};

const params = new URLSearchParams(location.search);
history.replaceState(null, '', location.pathname);
let saved = null;
try {
  saved = JSON.parse(sessionStorage.getItem('oak.oauth') || 'null');
  sessionStorage.removeItem('oak.oauth');
} catch {}

const home = saved?.journal ? `/?journal=${saved.journal}` : '/';
if (params.get('error')) {
  fail(params.get('error_description') || params.get('error'));
} else if (!saved || !params.get('state') || params.get('state') !== saved.state) {
  fail('the state does not match this tab. Start the login again from the dashboard.');
} else {
  try {
    const res = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: params.get('code'), code_verifier: saved.verifier }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      fail(data.error || `the server answered ${res.status}.`);
    } else {
      sessionStorage.setItem('oak.token', data.access_token);
      location.replace(home);
    }
  } catch (e) {
    fail(e.message);
  }
}
