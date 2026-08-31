# Publish fork runbook

Publishes only `@jamwil/pi-coding-agent`. Internal `@earendil-works/pi-*`
dependencies remain pinned to one upstream release version.

## Versions

Stable: the upstream release version, unchanged. The fork identity lives in
the package name, so versions stay directly comparable with upstream.

```text
upstream 1.0.0 -> 1.0.0
```

Fork hotfix on the same upstream version (rare): a prerelease of the NEXT
upstream patch with a `-jamwil.N` identifier. It sorts between the current and
the anticipated upstream release, and is superseded when that release ships.

```text
1.0.0 < 1.0.1-jamwil.0 < 1.0.1-jamwil.1 < 1.0.1
```

Dev: a prerelease of the version the build precedes, published with the `dev`
dist-tag.

```text
1.0.1-dev.0 -> 1.0.1-dev.1 -> 1.0.1
```

Full ordering across slots: `1.0.0 < 1.0.1-dev.0 < 1.0.1-jamwil.0 < 1.0.1`.

Prereleases do not satisfy plain `^X.Y.Z` ranges, so range-based consumers
receive upstream-sync releases only; tag-based installs (`@latest`, `@dev`)
and exact pins (install-lock) receive everything. If upstream skips the
anticipated patch (for example ships `1.1.0` instead of `1.0.1`), the
prerelease is simply orphaned; nothing collides.

## Tags

Upstream release tags are mirrored into this repository: the daily sync
pushes upstream's tags to origin, so plain `vX.Y.Z` names are taken. Every
fork release tag therefore appends `+jamwil` to the version. The npm version
cannot carry the suffix — npm strips semver build metadata (`npm version
1.0.0+jamwil` fails with "Version not changed"; `npm publish` silently
republishes it as `1.0.0`) — so only the tag carries it.

```text
npm 1.0.0          -> tag v1.0.0+jamwil
npm 1.0.1-jamwil.0 -> tag v1.0.1-jamwil.0+jamwil
npm 1.0.1-dev.0    -> tag v1.0.1-dev.0+jamwil
```

CI's released-changelog check compares released sections against the newest
tag: a branch rebased onto the newest upstream release passes, and a branch
older than it fails by design (it is stale).

## Stable release

Run from the repository root.

```bash
# Rebase onto the upstream release first. After the rebase the workspace
# version already equals the upstream version; no bump is needed. `npm run
# check` verifies the lockfiles, shrinkwrap, and install-lock are current.
npm run check

# Runs prepublishOnly and builds dist/standalone/.
npm run publish:dry:coding-agent
```

### Smoke test

Set `NODE24` to the Node 24 executable shipped by `nodejs-wheel-binaries`. Set
provider credentials plus `PI_SMOKE_PROVIDER` and `PI_SMOKE_MODEL` for the pi4py
deployment, then run the smoke wrapper from the repository root:

```bash
export NODE24=/path/to/nodejs_wheel/bin/node
export PI_SMOKE_PROVIDER=openrouter
export PI_SMOKE_MODEL=openai/gpt-5.4
# Export the corresponding provider credential, such as OPENROUTER_API_KEY.

scripts/smoke-fork-release.sh
```

### Publish

A stable release publishes the rebased tree as-is; there is no release commit.
The tag points at the rebased HEAD.

```bash
npm run publish:coding-agent
git tag "v1.0.0+jamwil"
git push origin HEAD
git push origin "v1.0.0+jamwil"
```

## Fork hotfix release

Only when a second release is needed on the same upstream version. The version
prereleases the next upstream patch; increment the `-jamwil.N` counter for
subsequent hotfixes on the same base.

```bash
VERSION=1.0.1-jamwil.0
npm version "$VERSION" -w packages/coding-agent --no-git-tag-version

npm install --package-lock-only --ignore-scripts
npm run shrinkwrap:coding-agent
npm run install-lock:coding-agent
npm run check
npm run publish:dry:coding-agent
```

Run the stable smoke test, then:

```bash
git add packages/coding-agent/package.json package-lock.json \
  packages/coding-agent/npm-shrinkwrap.json \
  packages/coding-agent/install-lock/package.json \
  packages/coding-agent/install-lock/package-lock.json
git commit -m "Release @jamwil/pi-coding-agent v$VERSION"

npm run publish:coding-agent
git tag "v$VERSION+jamwil"
git push origin HEAD
git push origin "v$VERSION+jamwil"
```

## Dev release

```bash
VERSION=1.0.1-dev.0
npm version "$VERSION" -w packages/coding-agent --no-git-tag-version
npm install --package-lock-only --ignore-scripts
npm run shrinkwrap:coding-agent
npm run install-lock:coding-agent
npm run check
npm run publish:dry:dev:coding-agent
```

Run the stable smoke test, then:

```bash
git add packages/coding-agent/package.json package-lock.json \
  packages/coding-agent/npm-shrinkwrap.json \
  packages/coding-agent/install-lock/package.json \
  packages/coding-agent/install-lock/package-lock.json
git commit -m "Dev @jamwil/pi-coding-agent v$VERSION"

npm run publish:dev:coding-agent
git push origin HEAD

# Optional
git tag "v$VERSION+jamwil"
git push origin "v$VERSION+jamwil"
```

After rebasing onto a new upstream release, no version arithmetic is needed:
the stable version is the upstream version itself, dev builds prerelease the
version they precede, and hotfixes (rare) prerelease the next upstream patch.
Tags always append `+jamwil`.
