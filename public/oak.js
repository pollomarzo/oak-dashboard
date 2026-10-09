// Names copied from the oak engine (Open-Scholar-Nexus/oaktree-sapling). Keep in step with:
// LABEL_EDITOR_ACTION and LABEL_ZENODO_FAILED in src/preview.ts, the branch in openDoiPr in
// src/gh.ts, UPGRADE_BRANCH in src/upgrade.ts, ENGINE_ID_SENTINEL in src/schema.ts,
// recordUrlForDoi in src/preview.ts, and the workflow files in templates/*/.github/workflows.

export const LABEL_EDITOR_ACTION = 'editor-action-needed';
export const LABEL_ZENODO_FAILED = 'zenodo-publish-failed';
export const DOI_BRANCH = 'zenodo-doi';
// The weekly bump uses UPGRADE_BRANCH; a picked version gets `${UPGRADE_BRANCH}-<tag>`.
export const UPGRADE_BRANCH = 'oak/upgrade';
export const isUpgradeBranch = (ref) => ref === UPGRADE_BRANCH || ref.startsWith(`${UPGRADE_BRANCH}-`);
export const ENGINE_ID_SENTINEL = 'CHANGE-ME-template-placeholder';

export const PINS_PATH = '.github/actions/engine/pins.yml';
export const REGISTRY_PATH = 'registry/papers.yml';
export const JOURNAL_CONFIG_PATH = 'journal.yml';

export const WORKFLOW = {
  publish: 'publish.yml',
  prepare: 'prepare.yml',
  checks: 'check.yml',
  site: 'site.yml',
};

// Used when a paper repo has no readable CODEOWNERS (templates/paper/CODEOWNERS).
export const GATED_PATHS_DEFAULT = ['/.github/', '/CODEOWNERS', '/paper-environment.yml'];

export const ZENODO_HOSTS = [
  ['10.5281/zenodo.', 'https://zenodo.org'],
  ['10.5072/zenodo.', 'https://sandbox.zenodo.org'],
];
export const SANDBOX_DOI_PREFIX = '10.5072/';

// The status the protect-main ruleset requires (src/bootstrap.ts), posted by src/checks.ts.
export const REQUIRED_CHECK = 'Journal checks';
