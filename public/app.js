import { JOURNAL_RE, CHECKS_TEXT, FetchError, loadJournal, loadPaper, rate, setToken, waitingOnEditors } from './data.js';

const TOKEN_KEY = 'oak.token';
const OAUTH_KEY = 'oak.oauth';
const SNAPSHOT_KEY = 'oak.snapshot';

const store = {
  get(k) {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      sessionStorage.setItem(k, v);
    } catch {}
  },
  del(k) {
    try {
      sessionStorage.removeItem(k);
    } catch {}
  },
};

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
const link = (href, text, cls) => h('a', { href, class: cls, rel: 'noopener' }, text);
const hhmm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const journal = params.get('journal');
let config = { clientId: null, defaultJournal: null };
let viewer = null;
let busy = false;

/* Login */

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function login() {
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  store.set(OAUTH_KEY, JSON.stringify({ state, verifier, journal: journal && JOURNAL_RE.test(journal) ? journal : null }));
  const q = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${location.origin}/auth/callback`,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    allow_signup: 'false',
  });
  location.assign(`https://github.com/login/oauth/authorize?${q}`);
}

function logout() {
  store.del(TOKEN_KEY);
  setToken(null);
  viewer = null;
  renderAccount();
}

function renderAccount() {
  const box = $('account');
  box.replaceChildren();
  if (viewer) {
    box.append(h('span', { class: 'muted' }, `@${viewer}`), ' ', h('button', { type: 'button', onclick: logout }, 'Log out'));
  } else if (config.clientId) {
    box.append(h('button', { type: 'button', class: 'primary', onclick: login }, 'Log in with GitHub'));
  } else {
    box.append(h('span', { class: 'muted', title: 'This deployment has no GitHub OAuth App set. See the README.' }, 'Login not configured'));
  }
}

/* Rendering */

function stateBadge(p) {
  if (p.error) return h('span', { class: 'badge bad' }, 'error');
  const cls = p.state.bad ? 'bad' : p.state.ok ? 'ok' : ['approve', 'draft', 'doipr'].includes(p.state.key) ? 'warn' : '';
  return h('span', { class: `badge ${cls}` }, p.state.key === 'published' ? 'published' : labelFor(p.state.key));
}
function labelFor(key) {
  return {
    unlinked: 'unlinked',
    setup: 'setup',
    failed: 'deposit failed',
    approve: 'approval',
    running: 'depositing',
    draft: 'Zenodo draft',
    doipr: 'DOI PR',
    tag: 'ready to tag',
    nodoi: 'no DOI yet',
    unknown: 'unknown',
    nodeposit: 'tagged',
  }[key] ?? key;
}

function prLine(pr) {
  const notes = [];
  if (pr.draft) notes.push('draft');
  if (pr.kind === 'doi') notes.push('DOI PR');
  if (pr.kind === 'upgrade') notes.push('engine upgrade');
  if (!pr.noJournalChecks) notes.push(`checks ${CHECKS_TEXT[pr.checks]}`);
  if (pr.gated.length) notes.push(pr.approved ? 'code owner approved' : `needs code-owner review (${pr.gated.length === 1 ? pr.gated[0] : `${pr.gated.length} gated files`})`);
  if (pr.noJournalChecks) notes.push('no checks ran: close and reopen it');
  const extra = [];
  if (pr.heldRun) extra.push(' ', link(pr.heldRun, 'approve runs'));
  if (pr.newVersion !== undefined) extra.push(' ', link(pr.newVersion ?? pr.url, 'New version on Zenodo first'));
  return h('li', {}, link(pr.url, `#${pr.number}`), ` ${pr.title} `, h('span', { class: 'muted' }, `by ${pr.author}; ${notes.join('; ')}`), extra);
}

function paperRow(p) {
  const name = p.repo.split('/')[1];
  const head = h(
    'div',
    { class: 'paper-head' },
    h('div', { class: 'paper-name' }, link(p.url, name), p.registered ? null : h('span', { class: 'tag' }, 'not in registry')),
    stateBadge(p),
  );
  const body = [];
  if (p.error) {
    body.push(h('p', { class: 'state bad-text' }, p.error));
  } else {
    body.push(h('p', { class: 'state' }, p.state.href ? link(p.state.href, p.state.text) : p.state.text, p.state.run ? [' ', link(p.state.run, 'failed run')] : null));
    if (p.state.command) body.push(h('code', { class: 'cmd' }, p.state.command));
    const facts = [];
    facts.push(p.doi ? h('span', {}, 'DOI ', p.publishedOnZenodo ? link(p.zenodo.recordUrl, p.doi) : p.doi) : h('span', {}, 'no DOI'));
    if (p.sandbox) facts.push(h('span', { class: 'tag warn-tag', title: 'Zenodo sandbox DOI; run prepare with sandbox off for a real one' }, 'sandbox'));
    if (p.latestTag) facts.push(h('span', {}, `latest tag ${p.latestTag}`));
    facts.push(link(p.links.prepare, 'prepare'));
    body.push(h('p', { class: 'facts muted' }, facts.flatMap((f, i) => (i ? [' · ', f] : [f]))));
    if (p.prs.length) body.push(h('ul', { class: 'prs' }, p.prs.map(prLine)));
  }
  return h('li', { class: 'paper' }, head, body);
}

function render(model, { cached = false } = {}) {
  const { j, papers, waiting, at } = model;
  document.title = `${j.name} | oak dashboard`;
  const main = $('main');
  main.replaceChildren();

  main.append(
    h(
      'section',
      { class: 'journal' },
      h('h1', {}, j.name),
      h('p', { class: 'muted' }, link(`https://github.com/${j.journal}`, j.journal), ` · ${papers.length} paper${papers.length === 1 ? '' : 's'} · ${waiting.length} waiting on editors`),
      h(
        'p',
        { class: 'facts' },
        'Site build: ',
        j.site ? link(j.site.url, j.site.status !== 'completed' ? 'running' : j.site.conclusion === 'success' ? 'ok' : j.site.conclusion) : h('span', { class: 'muted' }, 'no runs'),
        ' · ',
        link(`https://github.com/${j.journal}/blob/${j.branch}/registry/papers.yml`, 'registry'),
      ),
      j.problems.map((t) => h('p', { class: 'bad-text' }, t)),
    ),
  );

  main.append(
    h(
      'section',
      {},
      h('h2', {}, 'Waiting on editors'),
      waiting.length
        ? h(
            'ul',
            { class: 'todo' },
            waiting.map((w) => h('li', {}, h('span', { class: 'where' }, w.where), ' ', link(w.href, w.text), w.pr ? [' ', link(w.pr, 'PR')] : null, w.run ? [' ', link(w.run, 'run')] : null)),
          )
        : h('p', { class: 'muted' }, 'Nothing right now.'),
    ),
  );

  const order = (p) => (p.registered ? 0 : 1);
  const sorted = [...papers].sort((a, b) => order(a) - order(b) || a.repo.localeCompare(b.repo));
  main.append(
    h(
      'section',
      {},
      h('h2', {}, 'Papers'),
      sorted.length ? h('ul', { class: 'papers' }, sorted.map(paperRow)) : h('p', { class: 'muted' }, 'No papers found in the registry or among the owner\'s repos.'),
      h('p', { class: 'muted small' }, `Papers come from registry/papers.yml and from the ${j.scanned} repos of ${j.journal.split('/')[0]} checked for a pins.yml that points at this journal.`),
    ),
  );

  $('updated').textContent = `${cached ? 'Cached' : 'Updated'} ${hhmm(new Date(at))}`;
  renderRate();
}

function renderRate() {
  const el = $('rate');
  if (rate.remaining == null) return el.replaceChildren();
  const reset = rate.reset ? `, resets ${hhmm(new Date(rate.reset * 1000))}` : '';
  el.textContent = `GitHub API: ${rate.remaining} of ${rate.limit} calls left${reset}.${viewer ? '' : ' Logging in raises the limit.'}`;
}

function showError(text) {
  $('status').replaceChildren(h('p', { class: 'error' }, text));
}

async function refresh() {
  if (busy) return;
  busy = true;
  $('refresh').disabled = true;
  $('status').replaceChildren(h('p', { class: 'muted' }, 'Loading...'));
  try {
    const j = await loadJournal(journal);
    const papers = await Promise.all(j.papers.map((p) => loadPaper(p, j).catch((e) => ({ ...p, url: `https://github.com/${p.repo}`, error: e.message }))));
    const { meta, ...jj } = j;
    const model = { j: jj, papers, waiting: waitingOnEditors(j, papers), at: Date.now() };
    store.set(SNAPSHOT_KEY, JSON.stringify({ journal, model }));
    $('status').replaceChildren();
    render(model);
  } catch (e) {
    if (e instanceof FetchError && e.status === 401) logout();
    showError(e.message);
    renderRate();
  } finally {
    busy = false;
    $('refresh').disabled = false;
  }
}

// Logged out, GitHub allows 60 calls an hour, so the page refreshes less often. A hidden tab
// skips its turn and catches up when shown again.
function autoRefresh() {
  const every = () => (viewer ? 3 : 15) * 60 * 1000;
  let last = Date.now();
  const tick = () => {
    if (document.hidden || busy || Date.now() - last < every()) return;
    last = Date.now();
    refresh();
  };
  setInterval(tick, 30 * 1000);
  document.addEventListener('visibilitychange', tick);
  $('refresh').addEventListener('click', () => (last = Date.now()));
}

function renderPicker() {
  $('controls').hidden = true;
  const examples = ['pollomarzo/oak-demo-journal', 'pollomarzo/oak-demo2-journal'];
  $('main').replaceChildren(
    h(
      'section',
      { class: 'picker' },
      h('h1', {}, 'oak editor dashboard'),
      h('p', {}, 'What waits on a journal\'s editors, across the journal repo and every paper repo. It only reads; each item links to the GitHub or Zenodo page where you act.'),
      h(
        'form',
        { method: 'get', action: '/' },
        h('label', { for: 'journal' }, 'Journal repo'),
        h('div', { class: 'row' }, h('input', { id: 'journal', name: 'journal', placeholder: 'owner/name', required: true, autocomplete: 'off', spellcheck: 'false' }), h('button', { type: 'submit', class: 'primary' }, 'Open')),
      ),
      journal ? h('p', { class: 'error' }, 'That is not a GitHub repo name. Use owner/name.') : null,
      h('p', { class: 'muted' }, 'Examples: ', examples.flatMap((x, i) => [i ? ', ' : '', link(`/?journal=${x}`, x)])),
    ),
  );
}

async function main() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) config = await res.json();
  } catch {}
  const token = store.get(TOKEN_KEY);
  if (token) {
    setToken(token);
    try {
      const res = await fetch('https://api.github.com/user', { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` } });
      if (res.ok) viewer = (await res.json()).login;
      else if (res.status === 401) logout();
    } catch {}
  }
  renderAccount();

  if (!journal && config.defaultJournal) {
    location.replace(`/?journal=${config.defaultJournal}`);
    return;
  }
  if (!journal || !JOURNAL_RE.test(journal)) return renderPicker();

  $('refresh').addEventListener('click', refresh);
  autoRefresh();
  try {
    const snap = JSON.parse(store.get(SNAPSHOT_KEY) || 'null');
    if (snap?.journal === journal) render(snap.model, { cached: true });
  } catch {}
  refresh();
}

main();
