---
name: Publish snapshots working tree
description: A user-initiated publish auto-commits uncommitted workspace changes and deploys them.
---

When the user clicks Publish/Republish, Replit snapshots the current working tree — including any uncommitted in-progress agent work — into a "Published your App" commit and deploys that. There is no staging boundary between "work in the tree" and "what ships".

**Why:** Mid-session, a user republished while an unreviewed canvas-rendering rework sat uncommitted in the tree; production silently received unverified code and the user asked to undo everything after the prior publish. The clean undo was `git revert` of the auto-created "Published your App" snapshot commit (never reset/rewrite — gitsafe and the publish record reference it), which restored the tree byte-exact to the previously published commit.

**How to apply:** Treat any risky multi-edit rework as shippable the moment it touches the tree — the user can publish at any time. When asked to "undo what you did after we published", diff against the last non-snapshot commit on origin, revert the snapshot commit(s), and remind the user to republish so production drops the experimental code too.
