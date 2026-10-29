# Node.js security updates

A GitHub Action that opens a pull request raising `package.json`'s `engines.node`
minimum when Node.js publishes a qualifying security release. HIGH and CRITICAL
releases qualify by default. Ordinary releases do not create PRs.

Keep Docker tags such as `node:24-bookworm-slim` floating. Merging the engine update
can trigger your existing build/release pipeline, while later normal rebuilds
continue to pick up ordinary fixes. Builds must pull fresh base images, for example
with `docker build --pull` or `pull: true` in `docker/build-push-action`.

## Usage

Once this repository has been published and tagged `v1`, add this workflow to each
participating repository:

```yaml
name: Node.js security updates

on:
  schedule:
    - cron: '23 7 * * *'
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: node-security-updates
  cancel-in-progress: false

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.repository.default_branch }}
          fetch-depth: 50
      - uses: jsdelivr/action-node-security-updates@v1
        with:
          token: ${{ secrets.NODE_SECURITY_UPDATES_TOKEN }}
```

For the example above, create a fine-grained PAT with **Contents: write** and
**Pull requests: write**, then save it as the organization Actions secret
`NODE_SECURITY_UPDATES_TOKEN`. Grant both the PAT and the secret access to the
participating repositories. Each workflow references that same secret; no separate
token or repository secret is needed per repository. Renew the shared PAT when it
expires.

A GitHub App avoids storing a long-lived PAT. Install it on the participating
repositories with the same permissions. Store its client ID as the organization
variable `NODE_SECURITY_APP_CLIENT_ID` and its private key as the organization
Actions secret `NODE_SECURITY_APP_PRIVATE_KEY`, accessible to those repositories.
Replace the job's steps above with:

```yaml
steps:
  - uses: actions/checkout@v6
    with:
      ref: ${{ github.event.repository.default_branch }}
      fetch-depth: 50
  - uses: actions/create-github-app-token@v3
    id: app-token
    with:
      client-id: ${{ vars.NODE_SECURITY_APP_CLIENT_ID }}
      private-key: ${{ secrets.NODE_SECURITY_APP_PRIVATE_KEY }}
      permission-contents: write
      permission-pull-requests: write
  - uses: jsdelivr/action-node-security-updates@v1
    with:
      token: ${{ steps.app-token.outputs.token }}
```

Installation tokens expire after one hour, so generate one on every run rather
than saving the generated token as a persistent secret. The App credentials are
shared across repositories; each run generates a token scoped to its own repo.

Without the `token` input, the action uses `GITHUB_TOKEN`. Its PR workflows require
approval before running, so use either setup above for fully automatic CI.
The repository must also allow GitHub Actions to create pull requests when using
`GITHUB_TOKEN`; workflow permissions cannot override that setting.

The checkout should be clean and on the default branch. This action does not merge
PRs, deploy services, edit Dockerfiles, inspect image versions, or enforce engines.
It sets up Node.js 24 for its own steps, so put it in a dedicated update job.

## Version ranges

For example:

```json
{
  "engines": {
    "node": ">=24.0.0 <25"
  }
}
```

A qualifying security release in Node.js 24 raises the lower bound, preserving the
upper bound. `>=24` stays open-ended and only its Node.js 24 minimum is advanced;
it does not cause an upgrade of that minimum to Node.js 26.

Each `||` branch is handled independently, so `^22.0.0 || ^24.0.0` can retain
separate security minimums for both majors. Caret notation is preserved, and
equivalent major bounds use caret notation: `22 || 24` becomes, for example,
`^22.23.4 || ^24.22.1`. Tighter and open-ended bounds are preserved. Other
valid semver ranges with a stable minimum are supported; wildcard ranges without
a major minimum are rejected. A fix outside an existing upper bound fails visibly
instead of widening the range. Exact versions are advanced within the same major.

For a fix in `24.22.1`, common inputs become:

| Before | After |
| --- | --- |
| `24` | `^24.22.1` |
| `^24` | `^24.22.1` |
| `>= 24` | `>=24.22.1` |
| `~24` | `^24.22.1` |

Existing npm lockfile v2/v3 root engine metadata is synchronized without changing
dependency versions. No dependency installation runs in the caller's project.

## Inputs and outputs

| Input | Default | Purpose |
| --- | --- | --- |
| `token` | `github.token` | Token for PR creation. |
| `package-file` | `package.json` | One manifest relative to the checkout root. |
| `minimum-severity` | `high` | `low`, `medium`, `high`, or `critical`. |
| `branch` | `node-security-updates` | One maintained PR branch per repository. |
| `dry-run` | `false` | Set to `true` to modify local files without creating a PR. |

Outputs: `updated` (`true`/`false`), `node-range`, `pull-request-number`, and
`pull-request-url`. PR outputs are empty when no PR is created.

Use a different branch input for each caller if updating several manifests in the
same repository. Existing PRs are refreshed rather than creating one per run.
Commit messages and PR titles follow the majority style among the latest 50
available non-merge commit subjects. Conventional Commit style produces
`chore: update node.js to v24.22.1`; otherwise the text is
`Update node.js to v24.22.1`. Ties and empty history use the plain form. Updates
covering more than one version use `Update node.js versions` or
`chore: update node.js versions`. All non-merge commits count, including earlier
updates from this action. Set checkout's `fetch-depth: 50` as shown above to give
the detector recent history; a shallow checkout limits the available sample.

Successful non-dry runs also let the PR action retire obsolete PR branches when
their changes are already on the default branch. A clean run creates no new PR.

## Detection

The action reads the individual advisory JSON files in the official
[Node.js security repository](https://github.com/nodejs/security-wg/tree/main/vuln/core).
It downloads one repository archive and reads those records in memory; it does
not parse blogs or RSS. The generated aggregate `index.json` is ignored because
it can lag behind the individual records.

An advisory's `patched` semver branches identify the first fixed version in each
major, and its `severity` determines whether that release qualifies. The action
cross-checks those versions against the official
[Node.js release index](https://nodejs.org/dist/index.json) (`security: true`).
Only published security releases qualify; a newer ordinary release does not
produce a PR. The highest severity among advisories fixed in that particular
release is used, so a HIGH fix in one major does not promote a MEDIUM fix in another.
PRs include available advisory descriptions, CVEs, and official announcement links,
with direct links to the structured records for reference.

Every run refreshes the sources. Unclassifiable published security releases,
unknown severity, invalid data, and network errors fail visibly rather than
silently reporting that no update is needed. If the advisory repository lags
behind a release, a later scheduled run retries with fresh data.

This covers Node.js runtime security releases, not distribution package or npm
dependency vulnerabilities. It cannot provide fixes for unsupported Node.js
majors. Docker image publication and architecture availability are not checked.
Only the minimum major in each range branch is tracked: use separate `||` branches
to track multiple Node.js majors explicitly.

## Development

```sh
npm ci
npm test
npm run check
```

The action installs its own locked dependencies at runtime instead of checking in
a generated JavaScript bundle. Tests use local fixtures and do not create GitHub
branches or PRs.
