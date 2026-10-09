// Reads a journal and its papers from public GitHub and Zenodo data, and works out what waits
// on the editors. It never writes. Runs in the browser and in Node (see test/live.mjs).
import { load as parseYaml } from './vendor/js-yaml.mjs';
import * as oak from './oak.js';

export const JOURNAL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

export class FetchError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const rate = { remaining: null, limit: null, reset: null };
let token = null;
export function setToken(t) {
  token = t || null;
}

async function gh(path) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch('https://api.github.com' + path, { headers });
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining !== null) {
    rate.remaining = Number(remaining);
    rate.limit = Number(res.headers.get('x-ratelimit-limit'));
    rate.reset = Number(res.headers.get('x-ratelimit-reset'));
  }
  if (res.ok) return res.json();
  // 409: an empty repo has no refs.
  if (res.status === 404 || res.status === 409) return null;
  if (res.status === 401 && token) throw new FetchError('The GitHub login expired. Log in again.', 401);
  if ((res.status === 403 || res.status === 429) && rate.remaining === 0) {
    const at = rate.reset ? new Date(rate.reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'later';
    const hint = token ? '' : ' Log in to raise the limit from 60 to 5000 calls per hour.';
    throw new FetchError(`GitHub rate limit reached; it resets at ${at}.${hint}`, res.status);
  }
  throw new FetchError(`GitHub answered ${res.status} for ${path}`, res.status);
}

// raw.githubusercontent.com does not count against the API rate limit. A branch name is cached
// for 5 minutes there; a commit sha is not stale.
async function raw(repo, ref, path) {
  const enc = (s) => s.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${enc(path)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new FetchError(`raw.githubusercontent.com answered ${res.status} for ${repo}/${path}`, res.status);
  return res.text();
}

function yaml(text) {
  if (text == null) return { ok: true, value: null };
  try {
    return { ok: true, value: parseYaml(text) };
  } catch (e) {
    return { ok: false, error: String(e.reason || e.message) };
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const lc = (s) => String(s).toLowerCase();
const joinPath = (dir, file) => (!dir || dir === '.' || dir === './' ? file : `${dir.replace(/^\.\/|\/$/g, '')}/${file}`);
const workflowFile = (run) => (run.path || '').split('@')[0].split('/').pop();

function semverKey(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)(.*)$/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 0 : 1] : [-1, -1, -1, 0];
}
function latestTag(tags) {
  return [...tags].sort((a, b) => {
    const x = semverKey(a.name);
    const y = semverKey(b.name);
    for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  })[0];
}

export function zenodoFor(doi) {
  for (const [prefix, host] of oak.ZENODO_HOSTS) {
    if (doi.startsWith(prefix)) {
      const recid = doi.slice(prefix.length);
      if (/^\d+$/.test(recid)) return { host, recid, recordUrl: `${host}/records/${recid}` };
    }
  }
  return null;
}

async function ownerRepos(owner) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await gh(`/users/${owner}/repos?type=owner&per_page=100&page=${page}`);
    if (batch === null) throw new FetchError(`GitHub has no user or organization named ${owner}.`, 404);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** The journal repo, its registry and the owner scan by pins.yml. */
export async function loadJournal(journal) {
  if (!JOURNAL_RE.test(journal)) throw new FetchError('The journal must be a GitHub repo written as owner/name.', 400);
  const owner = journal.split('/')[0];
  const cfgText = await raw(journal, 'HEAD', oak.JOURNAL_CONFIG_PATH);
  if (cfgText === null) {
    throw new FetchError(`${journal} has no ${oak.JOURNAL_CONFIG_PATH}. Check the name; the repo must be public and an oak journal.`, 404);
  }
  const [regText, repos, siteRuns] = await Promise.all([
    raw(journal, 'HEAD', oak.REGISTRY_PATH),
    ownerRepos(owner),
    gh(`/repos/${journal}/actions/workflows/${oak.WORKFLOW.site}/runs?per_page=1`),
  ]);
  const cfg = yaml(cfgText);
  const reg = yaml(regText);
  const config = cfg.ok && cfg.value && typeof cfg.value === 'object' ? cfg.value : {};
  const meta = new Map(repos.map((r) => [lc(r.full_name), r]));
  const journalMeta = meta.get(lc(journal));
  const branch = journalMeta?.default_branch || 'main';

  const problems = [];
  if (!cfg.ok) problems.push(`journal.yml does not parse: ${cfg.error}`);
  if (!reg.ok) problems.push(`registry/papers.yml does not parse: ${reg.error}`);
  const entries = reg.ok && Array.isArray(reg.value) ? reg.value : [];

  const papers = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    let repo = entry.location?.repo;
    if (repo === '.') repo = journal;
    if (typeof repo !== 'string' || !JOURNAL_RE.test(repo)) {
      problems.push(`registry entry ${entry.id ?? '(no id)'} has no usable location.repo`);
      continue;
    }
    const path = typeof entry.location?.path === 'string' ? entry.location.path : '.';
    papers.set(`${lc(repo)}:${path}`, { repo, path, registered: true, entry: { id: entry.id ?? null, doi: entry.doi ?? null } });
  }

  const candidates = repos.filter((r) => !r.fork && !r.archived);
  const pins = await pool(candidates, 8, (r) => raw(r.full_name, 'HEAD', oak.PINS_PATH).catch(() => null));
  candidates.forEach((r, i) => {
    const m = /^instance_repo:\s*["']?([^"'\s#]+)/m.exec(pins[i] || '');
    if (!m) return;
    const points = lc(m[1]) === lc(journal) || (m[1] === '.' && lc(r.full_name) === lc(journal));
    if (!points) return;
    const already = [...papers.values()].some((p) => lc(p.repo) === lc(r.full_name));
    if (!already) papers.set(`${lc(r.full_name)}:.`, { repo: r.full_name, path: '.', registered: false, entry: null });
  });

  const run = siteRuns?.workflow_runs?.[0] ?? null;
  return {
    journal,
    name: typeof config.name === 'string' ? config.name : journal,
    branch,
    sentinels: [...new Set([oak.ENGINE_ID_SENTINEL, config.id_sentinel].filter((s) => typeof s === 'string' && s))],
    site: run ? { status: run.status, conclusion: run.conclusion, url: run.html_url } : null,
    scanned: candidates.length,
    problems,
    papers: [...papers.values()],
    meta,
  };
}

function gatedMatcher(codeowners) {
  const patterns = [];
  for (const line of (codeowners ?? '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    patterns.push(t.split(/\s+/)[0]);
  }
  const list = patterns.length ? patterns : oak.GATED_PATHS_DEFAULT;
  const regs = list.map((p) => {
    const anchored = p.startsWith('/');
    let body = p.replace(/^\//, '');
    const dir = body.endsWith('/');
    body = body.replace(/\/$/, '');
    const glob = body
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*');
    return new RegExp(`${anchored ? '^' : '(^|/)'}${glob}${dir ? '/' : '(/|$)'}`);
  });
  return (file) => regs.some((r) => r.test(file));
}

// The check runs GitHub shows on the PR; "Journal checks" is the one protect-main requires.
function checksSummary(checkRuns, held) {
  if (held) return 'held';
  if (!checkRuns.length) return 'none';
  if (checkRuns.some((r) => r.status !== 'completed')) return 'running';
  if (checkRuns.some((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion))) return 'failing';
  if (!checkRuns.some((r) => r.name === oak.REQUIRED_CHECK)) return 'incomplete';
  return 'passing';
}

async function loadPr(pr, ctx) {
  const { repo, runs, gated, zen } = ctx;
  const sha = pr.head.sha;
  const held = runs.find((r) => r.head_sha === sha && r.status === 'action_required') ?? null;
  const [checkRes, files] = await Promise.all([
    gh(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`),
    gh(`/repos/${repo}/pulls/${pr.number}/files?per_page=100`),
  ]);
  const checkRuns = checkRes?.check_runs ?? [];
  const bot = pr.user?.type === 'Bot';
  const sameRepo = lc(pr.head.repo?.full_name ?? '') === lc(repo);
  const labels = (pr.labels ?? []).map((l) => l.name);
  const out = {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: pr.user?.login ?? 'unknown',
    draft: !!pr.draft,
    kind: sameRepo && pr.head.ref === oak.DOI_BRANCH ? 'doi' : sameRepo && oak.isUpgradeBranch(pr.head.ref) ? 'upgrade' : 'author',
    checks: checksSummary(checkRuns, held),
    heldRun: held?.html_url ?? null,
    noJournalChecks: bot && !held && !checkRuns.some((r) => r.name === oak.REQUIRED_CHECK),
    newVersion: labels.includes(oak.LABEL_EDITOR_ACTION) ? zen?.recordUrl ?? null : undefined,
    gated: (files ?? []).map((f) => f.filename).filter(gated),
    approved: false,
  };
  if (out.gated.length) {
    const reviews = (await gh(`/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`)) ?? [];
    const last = new Map();
    for (const r of reviews) if (r.state !== 'COMMENTED') last.set(r.user?.login, r.state);
    out.approved = [...last.values()].includes('APPROVED');
  }
  return out;
}

async function loadZenodo(zen) {
  try {
    const res = await fetch(`${zen.host}/api/records?q=conceptrecid:${zen.recid}&all_versions=true&size=25&sort=mostrecent`);
    if (!res.ok) return { error: `Zenodo answered ${res.status}` };
    const data = await res.json();
    return { versions: (data.hits?.hits ?? []).map((h) => String(h.metadata?.version ?? '')).filter(Boolean) };
  } catch (e) {
    return { error: `Zenodo did not answer (${e.message})` };
  }
}

/** One paper's state, its open PRs and what waits on the editors. */
export async function loadPaper(p, j) {
  const { repo } = p;
  const base = { ...p, url: `https://github.com/${repo}` };
  const [refs, pulls, issues, runsRes] = await Promise.all([
    gh(`/repos/${repo}/git/refs?per_page=100`),
    gh(`/repos/${repo}/pulls?state=open&per_page=50`),
    gh(`/repos/${repo}/issues?state=open&labels=${oak.LABEL_ZENODO_FAILED}&per_page=20`),
    gh(`/repos/${repo}/actions/runs?per_page=100`),
  ]);
  if (pulls === null) return { ...base, error: 'Repo not found or not public.' };
  if (!refs) return { ...base, error: 'Repo is empty.' };

  const meta = j.meta.get(lc(repo));
  const heads = new Map(refs.filter((r) => r.ref.startsWith('refs/heads/')).map((r) => [r.ref.slice(11), r.object.sha]));
  const branch = meta?.default_branch && heads.has(meta.default_branch) ? meta.default_branch : heads.has('main') ? 'main' : heads.keys().next().value;
  const mainSha = heads.get(branch);
  const tagRefs = refs.filter((r) => r.ref.startsWith('refs/tags/v'));
  const tags = await pool(tagRefs, 4, async (r) => {
    let sha = r.object.sha;
    if (r.object.type === 'tag') sha = (await gh(`/repos/${repo}/git/tags/${sha}`))?.object?.sha ?? sha;
    return { name: r.ref.slice(10), sha };
  });

  const [mystText, codeowners] = await Promise.all([raw(repo, mainSha, joinPath(p.path, 'myst.yml')), raw(repo, mainSha, 'CODEOWNERS')]);
  const myst = yaml(mystText);
  if (mystText === null) return { ...base, branch, error: `No myst.yml on ${branch}.` };
  if (!myst.ok) return { ...base, branch, error: `myst.yml does not parse: ${myst.error}` };
  const project = myst.value?.project ?? {};
  const id = project.id == null ? null : String(project.id);
  const doi = typeof project.doi === 'string' && project.doi.trim() ? project.doi.trim() : null;
  const zen = doi ? zenodoFor(doi) : null;
  const zenodo = zen ? { ...zen, ...(await loadZenodo(zen)) } : null;

  const runs = runsRes?.workflow_runs ?? [];
  const publishRuns = runs.filter((r) => workflowFile(r) === oak.WORKFLOW.publish);
  const latestPublish = publishRuns[0] ?? null;
  const waiting = publishRuns.find((r) => r.status === 'waiting') ?? null;
  let reviewers = [];
  if (waiting) {
    const pend = (await gh(`/repos/${repo}/actions/runs/${waiting.id}/pending_deployments`)) ?? [];
    reviewers = pend.flatMap((d) => (d.reviewers ?? []).map((r) => (r.type === 'Team' ? r.reviewer?.slug : `@${r.reviewer?.login}`))).filter(Boolean);
  }

  const gated = gatedMatcher(codeowners);
  const prs = await pool(pulls, 4, (pr) => loadPr(pr, { repo, runs, gated, zen }));
  const latest = tags.length ? latestTag(tags) : null;
  const tagOnMain = tags.find((t) => t.sha === mainSha) ?? null;
  const versionOnZenodo = (tag) => !!zenodo?.versions?.some((v) => v === tag || `v${v}` === tag);
  const failedIssues = (issues ?? []).filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, url: i.html_url }));
  const doiPr = prs.find((x) => x.kind === 'doi') ?? null;

  const s = {
    id,
    doi,
    sandbox: !!doi && doi.startsWith(oak.SANDBOX_DOI_PREFIX),
    branch,
    pages: meta ? !!meta.has_pages : null,
    latestTag: latest?.name ?? null,
    zenodo,
    prs,
    failedIssues,
    links: {
      prepare: `https://github.com/${repo}/actions/workflows/${oak.WORKFLOW.prepare}`,
      myst: `https://github.com/${repo}/blob/${branch}/${joinPath(p.path, 'myst.yml')}`,
    },
  };

  // First match wins (plan section 6).
  if (tags.length && !doi) {
    s.state = { key: 'unlinked', text: `Tagged ${latest.name} but myst.yml has no DOI`, href: s.links.myst, bad: true };
  } else if (id && j.sentinels.includes(id)) {
    s.state = { key: 'setup', text: s.pages === false ? 'Setup: id not set; Pages not deployed' : 'Setup: id not set', href: s.links.myst };
  } else if (failedIssues.length || latestPublish?.conclusion === 'failure') {
    const issue = failedIssues[0];
    s.state = issue
      ? { key: 'failed', text: `Deposit failed: ${issue.title}`, href: issue.url, bad: true, run: latestPublish?.conclusion === 'failure' ? latestPublish.html_url : null }
      : { key: 'failed', text: `Deposit failed for ${latestPublish.head_branch}`, href: latestPublish.html_url, bad: true };
  } else if (waiting) {
    s.state = { key: 'approve', text: `Publish run ${waiting.head_branch} waiting for approval${reviewers.length ? ` by ${reviewers.join(', ')}` : ''}`, href: waiting.html_url };
  } else if (latestPublish && latestPublish.status !== 'completed') {
    s.state = { key: 'running', text: `Publish run ${latestPublish.head_branch} running`, href: latestPublish.html_url };
  } else if (latestPublish?.conclusion === 'success' && zenodo && !zenodo.error && !versionOnZenodo(latestPublish.head_branch)) {
    const comments = (await gh(`/repos/${repo}/commits/${latestPublish.head_sha}/comments?per_page=100`)) ?? [];
    const draft = comments.map((c) => /Zenodo draft populated: (\S+)/.exec(c.body ?? '')?.[1]).filter(Boolean).pop();
    s.state = { key: 'draft', text: `Zenodo draft for ${latestPublish.head_branch} waiting for Publish`, href: draft ?? `${zenodo.host}/me/uploads` };
  } else if (doiPr) {
    const hint = doiPr.noJournalChecks ? '; no checks ran: close and reopen it' : '';
    s.state = { key: 'doipr', text: `DOI PR #${doiPr.number} open: merge it${hint}`, href: doiPr.url };
  } else if (doi && !tagOnMain) {
    const since = latest ? (versionOnZenodo(latest.name) ? `; ${latest.name} is published, main has changed since` : `; latest tag ${latest.name}`) : '';
    s.state = { key: 'tag', text: `Ready to tag${since}`, href: `https://github.com/${repo}/tags`, command: 'git tag vX.Y.Z && git push origin vX.Y.Z' };
  } else if (!doi) {
    s.state = { key: 'nodoi', text: 'No DOI yet: run prepare once the paper is accepted', href: s.links.prepare };
  } else if (tagOnMain && versionOnZenodo(tagOnMain.name)) {
    s.state = { key: 'published', text: `Published ${tagOnMain.name}`, href: zenodo.recordUrl, ok: true };
  } else if (zenodo?.error) {
    s.state = { key: 'unknown', text: `Tagged ${tagOnMain.name}; ${zenodo.error}`, href: zenodo.recordUrl };
  } else {
    s.state = { key: 'nodeposit', text: `Tagged ${tagOnMain.name}; no Publish run found`, href: `https://github.com/${repo}/actions/workflows/${oak.WORKFLOW.publish}` };
  }
  s.publishedOnZenodo = !!zenodo?.versions?.length;
  return { ...base, ...s };
}

export const CHECKS_TEXT = {
  held: 'waiting for approval',
  none: 'not run',
  running: 'running',
  failing: 'failing',
  incomplete: 'missing Journal checks',
  passing: 'passing',
};

/** The editor to-do list across the journal and its papers. */
export function waitingOnEditors(j, papers) {
  const items = [];
  const add = (where, text, href, extra = {}) => items.push({ where, text, href, ...extra });
  if (j.site?.conclusion === 'failure') add('journal', 'Journal site build failed', j.site.url);
  const regEdit = `https://github.com/${j.journal}/edit/${j.branch}/${oak.REGISTRY_PATH}`;
  for (const p of papers) {
    const name = p.repo.split('/')[1];
    if (p.error) continue;
    if (['unlinked', 'failed', 'approve', 'draft', 'doipr'].includes(p.state.key)) add(name, p.state.text, p.state.href, { run: p.state.run });
    for (const pr of p.prs) {
      if (pr.draft) continue;
      if (pr.heldRun) add(name, `PR #${pr.number}: runs waiting for approval`, pr.heldRun);
      if (pr.newVersion !== undefined) add(name, `PR #${pr.number}: click New version on Zenodo before tagging`, pr.newVersion ?? pr.url, { pr: pr.url });
      if (pr.kind === 'upgrade') add(name, `Engine upgrade PR #${pr.number}: ${pr.noJournalChecks ? 'no checks ran: close and reopen it' : `checks ${CHECKS_TEXT[pr.checks]}`}`, pr.url);
      else if (pr.kind === 'author') {
        if (pr.gated.length && !pr.approved) add(name, `PR #${pr.number} needs code-owner review`, pr.url);
        else if (pr.checks === 'passing') add(name, `PR #${pr.number} checks pass: review and merge`, pr.url);
      }
    }
    if (p.publishedOnZenodo && !p.registered) add(name, 'Published, not in the registry', regEdit);
    if (p.publishedOnZenodo && p.registered && !p.entry?.doi) add(name, 'Registry entry has no DOI', regEdit);
  }
  return items;
}
