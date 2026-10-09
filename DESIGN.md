# Design notes

Why the dashboard is built the way it is. What it does and how to deploy it are in `README.md`.

## Editor actions it tracks

Each row is something an oak journal's editors do, and how the page detects that it is waiting. Names in backticks are in the engine (`Open-Scholar-Nexus/oaktree-sapling`) unless they are API paths.

| Action | Detected by | Links to |
|---|---|---|
| Approve a first-time contributor's runs | `actions/runs?status=action_required` | the run (Approve) |
| Review and merge an author PR | open PRs: checks, review decision, files on gated paths (CODEOWNERS) | the PR |
| Run `prepare` to reserve a DOI | no `project.doi` in `myst.yml` on `main`, no open `zenodo-doi` PR; shown as a state, since acceptance is the editor's call | `prepare.yml` (Run workflow) |
| Merge the DOI PR | open PR from `zenodo-doi` | the PR |
| Push the `v*` tag | DOI on `main`, no `v*` tag on the `main` commit | repo, with the tag command |
| Approve the deposit run | `zenodo-publish` has a required reviewer (repos bootstrapped before the engine dropped it): `actions/runs?status=waiting` | the run (Review deployments) |
| Click Publish on the Zenodo draft | Publish run succeeded, "Zenodo draft populated" commit comment, no Zenodo version equal to the tag | the draft |
| Click New version on Zenodo before the next tag | PR labelled `editor-action-needed` | the record and the PR |
| Handle a failed deposit | issue labelled `zenodo-publish-failed`, failed Publish run | the issue, the run |
| Add the paper to the registry | published paper missing from `registry/papers.yml`, or its entry has no DOI | the registry file |
| Merge an engine upgrade PR | open PR from `oak/upgrade` or `oak/upgrade-<tag>` | the PR |
| Unblock a bot PR with no checks | a `GITHUB_TOKEN` PR (DOI, upgrade) with no Journal checks result | the PR, with "close and reopen" |
| Move off the sandbox DOI | `project.doi` starts `10.5072/` | badge only |
| Fix the journal site build | latest `site.yml` run failed | the run |
| Finish a new paper's setup | `project.id` is the placeholder | `myst.yml` |
| Fix "published but unlinked" | `v*` tag present, no `project.doi` | `myst.yml` |

Left out: environment secrets (reading them needs a token that can write) and retired workflow files (the upgrade PR body lists them).

## Which papers

The union of the journal's `registry/papers.yml` and the repos under the journal's owner whose `pins.yml` names the journal as `instance_repo`. It needs no bootstrap change and works for organisations and personal accounts. A bootstrap-set topic would be faster but needs a backfill, and anyone can set a topic. Code search has its own low rate limit, indexes slowly and reads only the default branch. An unregistered paper under another owner is not found; an `extra_repos` list could cover that later.

## Login

Everything the page reads is public, so a token only raises the rate limit (60 to 5000 calls per hour). An OAuth App with no scopes gets read access to public data only, the least GitHub offers. Its web flow needs the client secret, and `github.com/login/oauth/access_token` (like the device flow endpoint) sends no CORS headers, so one small function swaps the code for a token. That function never sees API traffic. Pasting a token was rejected because it is easy to over-grant; a GitHub App because it needs installing on each journal's owner, which only pays off if the dashboard ever writes or reads private repos.

The token lives in `sessionStorage`: it survives a reload and is gone with the tab. `localStorage` would keep a non-expiring token indefinitely. The page loads no third-party scripts.

## Where it lives

A separate repo hosted once, with the journal picked by `?journal=owner/repo`. One OAuth App and one function serve every journal, and fixes reach all of them at once. A page in the journal's website template would never get fixes, since those files are written once and `oak upgrade` never touches them. The engine repo releases tagged bundles for paper CI, which does not fit a continuously deployed page. The cost is that names (labels, branches, workflow files) are copied from the engine into `public/oak.js` and must be kept in step by hand.
