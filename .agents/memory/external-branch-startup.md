---
name: External branch startup
description: Startup compatibility when checking out a branch whose dev script expects a local env file.
---

When checking out a complete codebase from another repository, do not assume its ignored `.env` file exists in the workspace. If the project already receives configuration from Replit environment variables, remove only the missing `--env-file=.env` startup flag rather than creating or copying secrets into a file.

**Why:** A fetched branch can contain a valid application but still fail before opening its port because its package script references a local-only `.env` file that is not tracked.

**How to apply:** Verify `.env.example` says Replit uses environment variables, then make the smallest script-only adjustment and restart the workflow.