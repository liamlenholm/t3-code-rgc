# Liam's T3 Code

Fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) with my own features on top.
`main` is upstream's latest release tag plus this fork's tooling and every merged feature.
Not intended for upstream PRs (`upstream` push is disabled).

## Features

Each feature is developed on its own branch and merged into `main` by pull request.

- **Docker Compose links.** A thread's sidebar hover card links the app its worktree's (or project root's) Compose
  stack serves, and the thread details panel gets an **Open app** row above "Open in editor". Its menu opens any
  other running service and sets the project's main link in place. Docker is only queried when the setting is on and
  the workspace is a known project or worktree with a compose file, at its root or in `docker/`, `.docker/`,
  `infra/`, `deploy/`, or `.devcontainer/`.
  - Configured in **Settings → Integrations → Docker Compose**: on/off, main link, and link path, at any settings
    scope. With a project selected, the main link is picked from the services `docker compose config` reports
    (falling back to `--no-interpolate` for projects that need a wrapper script). Automatic prefers
    proxy/frontend/web-like services and never offers database or cache ports.
  - The client builds the URL: `localhost` when it runs on the server's machine (which also allows ports bound to
    127.0.0.1), the host it connected with over LAN or a tailnet, and the server's hostname over SSH or relay.
  - Fork servers advertise the `dockerComposeLinks` capability; against an official server the links and their
    settings are hidden.
  - Server: `apps/server/src/preview/DockerComposeServers.ts`. UI: `apps/web/src/components/useDockerComposeStack.ts`
    and `settings/DockerComposeSettings.tsx`.
- **Filter by several projects.** The sidebar's project filter picks any number of projects: clicking one adds or
  removes it, **All projects** clears the filter, and a thread's right-click menu adds or removes its project. An
  older single-project filter carries over. Works in the Mac and Linux desktop apps and the web app; mobile keeps
  its single-project filter.

## Working on the fork

- **New feature:** branch from `main`, open a PR into `main` on this repo:
  `gh pr create --repo liamlenholm/t3-code-rgc --base main`. Don't bump versions on feature branches.
- **Shipping a build:** bump the version on `main` (see below), then build from `main`.

## How it runs

A desktop app adding an SSH environment launches the server on the remote host using the runtime in
`~/.t3/runtime/versions/<app version>/`. When that folder is missing, the launcher downloads the CLI archive for
that exact version from **this fork's** GitHub Releases (`CLI_RELEASE_REPOSITORY` in
`packages/shared/src/cliRelease.ts`; `t3 update` and the install scripts use the same source). So every version
shipped from `main` needs a release here, and every app and host runs the same version, a SemVer prerelease such as
`0.1.1-liam.1`, stored in `apps/server/package.json`.

1. **Bump and tag `main`:**

   ```bash
   node scripts/update-release-package-versions.ts 0.1.1-liam.2
   git commit -am "chore: version 0.1.1-liam.2"
   git tag v0.1.1-liam.2 && git push origin main v0.1.1-liam.2
   ```

2. **Release:** the tag runs `.github/workflows/fork-release.yml`, which builds, smoke-tests, and publishes
   `t3-<version>-{linux-x64,linux-arm64,darwin-arm64}.tar.gz` plus `SHA256SUMS` as a prerelease. Wait for it
   before installing the new app: until it exists, adding an SSH host fails with a curl 404. Re-run it from the
   Actions tab with the tag if it fails.
3. **Desktop apps:** build from the same commit: `scripts/fork/build-mac.sh` (unsigned DMG in `release/`) on a Mac,
   or `vp run dist:desktop:linux` for the AppImage. Local builds have no update feed, so they never auto-update to an
   official release.
4. **Cut over:** quit the app, install the new build over it (same name and bundle ID, so settings and connections
   carry over), and reopen it. Remote hosts download the new runtime on the next connect. If the app adopts the
   server that's already running instead of restarting it (check
   `readlink /proc/$(ss -H -ltnp | grep -oP ':3773 .*pid=\K\d+')/exe` on the remote), stop that `t3 serve` process by
   its PID and restart the app. Restarting the server interrupts any agent threads running on that host.

Always bump the version when shipping a new build: the launcher only switches runtimes when the version changes.

`scripts/fork/build-linux-runtime.sh` still builds and installs a Linux runtime locally, for testing an untagged
build on a Linux host without publishing it.

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
