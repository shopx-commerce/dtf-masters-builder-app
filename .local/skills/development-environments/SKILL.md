---
name: development-environments
description: Create, configure, build, and manage the org's Development Environments — prebuilt codebase images that sandboxes provision from — including setting one up from scratch for a GitHub repository.
---

# Development Environments

A Development Environment is an org-scoped, declarative definition of a codebase: a list of git repositories (plus an optional base OCI image) that the platform periodically clones and builds into an image. Sandboxes provision from an environment's **latest successful build**, so a freshly created or reconfigured environment is not provisionable until a build succeeds.

Your system prompt teaches the attach flow (`provisionSandboxEnvironment`, `connectToSandbox`, `listAttachedSandboxEnvironments`, `disconnect`) — that is the common case. This skill covers the rest of the lifecycle: creating environments, changing their config, running and inspecting builds, and the recipe for configuring an environment from a bare GitHub repository.

All functions below run in code execution. Mutations are org-wide: every member sees the environments you create, change, or delete.

## Available Functions

### listDevelopmentEnvironments({})

The org's environment catalog. **Returns:** `{ developmentEnvironments }` — each with `developmentEnvironmentId`, `name`, `latestSuccessfulBuildId` (null = never built successfully = not provisionable), and `syncedRepositories` (`{ url, ref, path }`).

### getDevelopmentEnvironment({ developmentEnvironmentId })

The full config, unlike the truncated catalog listing. **Returns:** `{ ok: true, environment: { developmentEnvironmentId, name, repositories, baseOciImage, rebuildIntervalSeconds } }` or a failure (see Errors).

### createDevelopmentEnvironment({ name, repositories, baseOciImage?, rebuildIntervalSeconds? })

Create an environment. `repositories` is 1+ of `{ url, ref, path }`, all required — `url` must be a plain HTTPS git URL (no credentials, query strings, or fragments); `ref` is the branch/tag/commit to check out (use the repository's default branch when unsure); `path` is the workspace-relative checkout directory (conventionally the repository name). `rebuildIntervalSeconds` defaults to 86400 (24h; min 900, max 30 days).

**Returns:** `{ ok: true, developmentEnvironmentId, name, warning? }` or a failure. Creation does **not** build — call `buildEnvironment` next.

### updateDevelopmentEnvironment({ developmentEnvironmentId, name, repositories, baseOciImage?, rebuildIntervalSeconds? })

**Whole-config replace, not a merge** — pass the complete desired state (fetch it first with `getDevelopmentEnvironment` when editing incrementally). The platform auto-enqueues a rebuild on every update.

**Returns:** `{ ok: true, developmentEnvironmentId, name, enqueuedBuildId, warning? }` or a failure. `enqueuedBuildId` is the auto-enqueued rebuild when it could be observed (null otherwise — use `listBuilds` to find it). Until that build succeeds, provisioning still uses the **old** image; await the build before re-provisioning to verify a config change.

### deleteDevelopmentEnvironment({ developmentEnvironmentId })

Deletes the environment for the whole org. **Only delete environments you created in this conversation** unless the user explicitly asks for another; other environments may be curated by humans or used by other members. **Returns:** `{ ok: true, developmentEnvironmentId, name, warning? }` or a failure.

### buildEnvironment({ developmentEnvironmentId })

Triggers a build and resolves when it reaches a terminal state. Runs as a background job: start it early, keep doing other work, and await the promise when you need the result — builds routinely take several minutes.

**Returns:** `{ ok: true, buildId, status: 'SUCCEEDED', warning? }` or `{ ok: false, buildId, status: 'FAILED' | 'CANCELLED', error: { code, step, message } | null }`. A failed build is a normal resolved result — read `error.step` (e.g. `checkout-repository-0`, `run-build-hook-0`) and `error.message` to diagnose. Cancelling the job (or timing out while awaiting) does **not** cancel the server-side build — find it again with `getBuild`.

### getBuild({ buildId })

One build's current state. **Returns:** `{ ok: true, build: { buildId, developmentEnvironmentId, status, error, createdAt, startedAt, finishedAt } }` or a failure. `status` is one of `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`.

### listBuilds({ developmentEnvironmentId })

Recent builds, newest first. Use it to find the rebuild an update auto-enqueued, or periodic rebuilds. **Returns:** `{ ok: true, builds }` or a failure.

## Errors

Failures return `{ ok: false, error, errorKind }`:

- `already_exists` — a name collision. Call `listDevelopmentEnvironments({})` and reuse or rename; never blind-retry a create.
- `invalid_config` — the platform rejected the config (bad URL, overlapping paths, credentials embedded in a URL, out-of-range rebuild interval). Fix the config; do not retry unchanged.
- `not_found` — unknown environment/build id. Refresh with `listDevelopmentEnvironments({})` / `listBuilds`.
- `service_unavailable` — transient; retry later.

A success carrying `warning` means the change committed but the catalog snapshot refresh failed — run `listDevelopmentEnvironments({})` before provisioning.

## The Build Hook

During a build, each repository is cloned and then `.nexus/hooks/on_build` is executed **from inside that repository** (cwd = the repo's directory) when the file exists and is executable. Its job is to make the image ready to work in: install dependencies, run codegen, warm caches. A missing hook is fine (the build is clone-only); a non-executable hook or nonzero exit **fails the build**.

Write hooks as plain executable shell scripts (`#!/usr/bin/env bash`, `set -euo pipefail`) and `chmod +x` them. Keep them idempotent and non-interactive.

## Configuring an Environment for a GitHub Repository

The goal: the user gives you a repo URL; you produce an environment whose image has the code checked out and dependencies installed, verified by a sandbox that can actually run the project's checks.

1. **Create clone-only.** `createDevelopmentEnvironment` with the repository URL, its default branch as `ref` (check the repo when unsure; it is often `main`), and the repository name as `path`. Then `buildEnvironment` — a clone-only build needs no hook and should succeed if the repo is reachable. This validates the config and gives you a provisionable image.
2. **Explore in a sandbox.** `provisionSandboxEnvironment` + `connectToSandbox` (system prompt). Inspect the repo: package manager, lockfiles, setup docs, build/test commands. Run the setup steps by hand in the sandbox until the project's checks pass — this is your draft of the hook.
3. **Author the hook.** Write `.nexus/hooks/on_build` in the sandbox's repo clone capturing exactly the steps that worked; `chmod +x` it and re-run it from the repo root to prove it works from a clean-ish state.
4. **Get the hook into the repo.** Commit it on a branch and try `git push`. Sandbox clones usually have **no push credentials** — if the push is rejected, fall back to user handoff: show the user the full hook file contents and a `git format-patch`/diff, ask them to commit it (on a branch or their default branch), and wait for their confirmation before continuing.
5. **Point the environment at the hook.** `updateDevelopmentEnvironment` with the same config but `ref` set to the branch that now contains the hook (skip when it landed on the default branch). Update auto-rebuilds; otherwise `buildEnvironment` again.
6. **Await and verify.** Await the build (or `getBuild` on `enqueuedBuildId`). On failure, diagnose from `error.step`/`error.message`, fix the hook (repeat 3-5). On success, provision a **fresh** sandbox and confirm the environment is ready — dependencies present, checks runnable — before telling the user it works. Remember: sandboxes provisioned before the build finished still run the old image.

Report progress to the user between long steps, and surface the final environment name and id so they can find it in the workspace UI.
