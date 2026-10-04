# oak dashboard

One page that shows what waits on a journal's editors across an [oak](https://github.com/Open-Scholar-Nexus/oaktree-sapling) journal repo and its paper repos: runs to approve, PRs to review or merge, DOIs to reserve, tags to push, Zenodo drafts to publish, failed deposits, registry gaps. It only reads. Each item links to the GitHub or Zenodo page where the editor acts.

Hosted copy: https://oak-dashboard.pages.dev. Pick a journal with `?journal=owner/repo`, for example https://oak-dashboard.pages.dev/?journal=pollomarzo/oak-demo-journal.

## How it works

- A static page (`public/`, plain JS modules, no build step) calls `api.github.com`, `raw.githubusercontent.com` and Zenodo's public API from the browser.
- Papers are the union of the journal's `registry/papers.yml` and the repos of the journal's owner whose `.github/actions/engine/pins.yml` has `instance_repo: <journal>`.
- It works without login, on GitHub's anonymous limit of 60 API calls per hour (about 2 calls for the journal plus 4 per paper and 2 per open PR). Logging in raises the limit to 5000.
- Login is GitHub's OAuth web flow with PKCE and no scopes, so the token can read public data only. The token is kept in `sessionStorage` and is gone when the tab closes. `functions/api/token.js` is the only server code: it swaps the OAuth code for a token with the client secret.
- Names copied from the engine (labels, branches, workflow files) live in `public/oak.js`.

`node test/live.mjs owner/journal` prints what the page would show, as JSON. Set `GITHUB_TOKEN` to avoid the anonymous limit.

## Deploy your own copy

You need a Cloudflare account and Node.

```sh
git clone https://github.com/pollomarzo/oak-dashboard && cd oak-dashboard
npx wrangler@4 pages project create oak-dashboard --production-branch main
npx wrangler@4 pages deploy
```

Use another project name if `oak-dashboard` is taken; the page is then at `https://<name>.pages.dev`. Change `name` in `wrangler.toml` to match.

Optional: set `DEFAULT_JOURNAL` (for example `my-org/my-journal`) to open that journal when no `?journal=` is given:

```sh
npx wrangler@4 pages secret put DEFAULT_JOURNAL --project-name oak-dashboard
```

## Turn on login

1. Open https://github.com/settings/applications/new (for an organization: the organization's Settings, Developer settings, OAuth Apps, New OAuth App) and fill in:
   - Application name: `oak dashboard`
   - Homepage URL: `https://oak-dashboard.pages.dev`
   - Authorization callback URL: `https://oak-dashboard.pages.dev/auth/callback`
   - Enable Device Flow: leave off
2. Register it, then click "Generate a new client secret".
3. Store both values in the Pages project. Each command prompts for the value:

   ```sh
   npx wrangler@4 pages secret put GITHUB_CLIENT_ID --project-name oak-dashboard
   npx wrangler@4 pages secret put GITHUB_CLIENT_SECRET --project-name oak-dashboard
   ```

4. Deploy again (`npx wrangler@4 pages deploy`) so the new values reach the running site. The "Log in with GitHub" button appears once `GITHUB_CLIENT_ID` is set.

The client ID is public; it is stored with `secret put` only because wrangler has no command for plain Pages variables. Never commit the client secret.

## What it shows

Per paper, one state (first match wins): tagged but no DOI in `myst.yml`; setup (placeholder `project.id`); deposit failed; Publish run waiting for approval; deposit running; Zenodo draft waiting for Publish; DOI PR open; ready to tag; no DOI yet; published. Under each paper, its open PRs with checks, code-owner review on gated paths, held runs from first-time contributors, the "click New version on Zenodo" reminder, and engine upgrade PRs. For the journal: the latest site build, and published papers missing from the registry or missing a DOI there.

Not shown: environment secrets (needs a token that can write), anything in private repos.

## License

MIT. `public/vendor/js-yaml.mjs` is js-yaml 4.3.2 (MIT, see `public/vendor/js-yaml.LICENSE.txt`).
