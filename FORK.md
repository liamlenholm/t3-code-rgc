# Liam's T3 Code

Fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) with my own features on top.
`main` is upstream's latest release tag plus this fork's tooling and every merged feature.
Not intended for upstream PRs (`upstream` push is disabled).

## Features

Each feature is developed on its own branch and merged into `main` by pull request.

## Working on the fork

- **New feature:** branch from `main`, open a PR into `main` on this repo:
  `gh pr create --repo liamlenholm/t3-code-rgc --base main`. Don't bump versions on feature branches.
- **Shipping a build:** bump the version on `main` (see below), then build from `main`.

## How it runs

The Mac app launches the server on the remote Linux host over SSH, using the runtime in
`~/.t3/runtime/versions/<app version>/`. It downloads an official release only when that folder is missing,
so both sides must be built with the same version, a SemVer prerelease such as `0.1.1-liam.1`, stored in
`apps/server/package.json`.

1. **Linux runtime** (on the remote host): `scripts/fork/build-linux-runtime.sh` builds the server and web bundle,
   packs it like an official release, smoke-tests it, and installs it into `~/.t3/runtime/versions/<version>/`.
2. **Mac app** (on the Mac): `scripts/fork/build-mac.sh` builds an unsigned DMG in `release/`. Local builds
   have no update feed, so the app never auto-updates to an official release.
3. **Cut over:** quit the app, install the forked DMG over it (same name and bundle ID, so settings and
   connections carry over), and reopen it. If the app adopts the server that's already running instead of
   restarting it (check `readlink /proc/$(ss -H -ltnp | grep -oP ':3773 .*pid=\K\d+')/exe` on the remote),
   stop that `t3 serve` process by its PID and restart the app: the launcher then starts the new runtime.
   Restarting the server interrupts any agent threads running on that host.

Always bump the version when shipping a new build: the launcher only switches runtimes when the version changes.

```bash
node scripts/update-release-package-versions.ts 0.1.1-liam.2
git commit -am "chore: version 0.1.1-liam.2"
```

## Syncing with upstream

Merge each new release tag into `main`. Don't rebase `main`: merged PRs point at its history.

```bash
git fetch upstream --tags
git checkout main && git merge vX.Y.Z           # e.g. v0.1.2
node scripts/update-release-package-versions.ts X.Y.Z-liam.1
git commit -am "chore: version X.Y.Z-liam.1"
scripts/fork/build-linux-runtime.sh             # then rebuild the Mac app and reinstall it
```

Open feature branches then rebase onto `main`.

`.github/workflows/upstream-release-check.yml` runs every Monday and opens an issue on this repo when upstream
publishes a stable release newer than the fork's base (the version prefix in `apps/server/package.json`). The issue
lists the files both sides changed, where the merge can conflict. Run it by hand from the Actions tab; `base` and
`dry_run` inputs let you test it without a new release.

Upstream's own workflows are disabled in this repo's Actions settings. A sync can bring in new ones, so disable
everything except the release check after pushing:

```bash
gh workflow list --all --json name,state -q '.[] | select(.state == "active" and .name != "Upstream release check") | .name' \
  | while read -r name; do gh workflow disable "$name"; done
```

## Caveats

- The fork's server migrates the live `~/.t3/userdata` database. Going back to an older official release may
  not work after the fork has run newer migrations.
- The app keeps the official bundle ID and name, so it replaces the official app and shares its data.
- CI-injected settings (T3 Connect / relay, Clerk) are absent from local builds, so those features are
  inactive. SSH connections don't use them.
