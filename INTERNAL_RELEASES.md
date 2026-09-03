# Internal package releases

The Tennr fork publishes the four packages used by the monorepo to GitHub Packages. Source package names and imports remain `@flue/*`; consumers use npm aliases so this fork does not require a repo-wide rename.

| Source/import name    | GitHub Packages name            |
| --------------------- | ------------------------------- |
| `@flue/runtime`       | `@tennr-inc/flue-runtime`       |
| `@flue/sdk`           | `@tennr-inc/flue-sdk`           |
| `@flue/vite`          | `@tennr-inc/flue-vite`          |
| `@flue/opentelemetry` | `@tennr-inc/flue-opentelemetry` |

## Publish a release

1. Commit the workflow to the fork's default branch. GitHub only enables `workflow_dispatch` for workflows present on the default branch.
2. In GitHub, open **Actions → Publish Internal Flue Packages → Run workflow**.
3. Select the commit or branch to publish. After the workflow exists on the default branch, the selected release ref may be another branch.
4. Enter one new semver for all packages, such as `2.0.3-tennr.2`. Leave the dist-tag as `internal` unless you intentionally need another channel.

The workflow installs from the lockfile, formats-checks the release tooling, builds and typechecks all four packages, runs the runtime and SDK test suites plus dedicated package-staging tests, stages all four packages with private names, validates every tarball, and then publishes with the workflow's `GITHUB_TOKEN`. The source manifests are not modified.

All tarballs are prepared and dry-run before the first upload. Uploads use a release-specific staging tag; the workflow verifies all four immutable versions before promoting the requested consumer tag. If tag promotion fails partway through, the publisher makes a best-effort rollback to each package's previous tag value. If a run stops after publishing only some packages or while promoting tags, rerun it from the same commit with the same version. Existing packages are skipped only when their registry integrity exactly matches the local tarball; a conflicting immutable version fails before any new package is uploaded. Internal applications should still pin the exact version shown below so installation never depends on a tag moving across four separate package records.

To pack and inspect the staged package contents locally without contacting the registry:

```sh
pnpm build
pnpm release:internal:prepare --version 2.0.3-tennr.2
pnpm release:internal:publish --dry-run
```

GitHub links packages to `Tennr-Inc/flue`. In each package's settings, grant the consuming monorepo **Actions access** so its `GITHUB_TOKEN` can read the package. Developers need a classic personal access token with `read:packages` and access to the organization.

## Install in the monorepo

Add a project `.npmrc` without a literal token:

```ini
@tennr-inc:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Set `NODE_AUTH_TOKEN` to a classic GitHub personal access token with `read:packages` for local installs. In GitHub Actions, set it to `${{ secrets.GITHUB_TOKEN }}` after granting that repository package access.

Keep the application-facing dependency names unchanged and alias them to the private packages:

```json
{
  "dependencies": {
    "@flue/opentelemetry": "npm:@tennr-inc/flue-opentelemetry@2.0.3-tennr.2",
    "@flue/runtime": "npm:@tennr-inc/flue-runtime@2.0.3-tennr.2",
    "@flue/sdk": "npm:@tennr-inc/flue-sdk@2.0.3-tennr.2",
    "@flue/vite": "npm:@tennr-inc/flue-vite@2.0.3-tennr.2"
  }
}
```

For a pnpm workspace, also pin the aliases at the root so transitive dependencies cannot resolve the public `@flue/*` packages:

```yaml
# pnpm-workspace.yaml
overrides:
  '@flue/opentelemetry': 'npm:@tennr-inc/flue-opentelemetry@2.0.3-tennr.2'
  '@flue/runtime': 'npm:@tennr-inc/flue-runtime@2.0.3-tennr.2'
  '@flue/sdk': 'npm:@tennr-inc/flue-sdk@2.0.3-tennr.2'
  '@flue/vite': 'npm:@tennr-inc/flue-vite@2.0.3-tennr.2'
```

If the monorepo uses pnpm's `minimumReleaseAge`, exclude `@tennr-inc/*` so a just-published internal release is immediately installable:

```yaml
minimumReleaseAgeExclude:
  - '@tennr-inc/*'
```

Then install normally:

```sh
NODE_AUTH_TOKEN=github_pat_... pnpm install
pnpm why -r @flue/runtime
```

The staged `@tennr-inc/flue-vite` dependency and `@tennr-inc/flue-opentelemetry` peer dependency both point to the same internal runtime version through an npm alias. This keeps generated imports such as `@flue/runtime/cloudflare` working while preventing an accidental public-runtime install.
