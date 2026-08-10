---
name: Authenticated GitHub sync
description: Repository sync behavior when the local GitHub HTTPS credential is rejected.
---

When local `git fetch`, `git pull`, or `git ls-remote` fails with GitHub's invalid username/token error, the repository may still be accessible through the attached Replit GitHub connection. Use the connector to read commit metadata or retrieve a patch, then apply it locally while preserving a safety branch.

**Why:** The workspace's `origin` credential can be stale even when the account-level GitHub OAuth connection is valid. Retrying raw HTTPS does not fix the authentication path.

**How to apply:** Search integrations for GitHub, attach an authorized `connection:` if it is `not_added`, fetch commit metadata/patch through the connector, and verify protected paths before committing.