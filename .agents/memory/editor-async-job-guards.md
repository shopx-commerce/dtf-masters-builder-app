---
name: Editor async job guards
description: The invariant every long-running editor tool (color change, halftone, upscale) must satisfy before it commits a result.
---

Every editor tool that runs seconds-long work (recolor, halftone screen, AI upscale) must satisfy three rules before it commits:

1. The in-flight guard is a ref claimed synchronously, never React state. Two clicks in one tick read the same pre-update state value, so a state check alone starts duplicate work.
2. Claim the guard AFTER whatever helper starts/supersedes the job, because that helper is usually what resets the guard. Release is ownership-scoped: a superseded job that finishes late must check the job token still belongs to it before clearing anything.
3. Re-read the design live (ref or freshly mirrored props) after every await and compare source identity before committing. The closed-over source is stale; committing it silently reverts whatever edit landed in the meantime.
4. Unmount must invalidate the run. Asking a worker or GPU session to cancel does not stop a run already past its last checkpoint, so the commit path needs its own run token that teardown bumps.

A companion rule for undo: when a second gesture supersedes an in-flight one, do not take a second snapshot — nothing committed between them, so the customer would have to undo twice for one visible change. Track whether the in-flight job already snapshotted rather than merely that one is running, because maintenance rebuilds run without snapshotting.

**Why:** these races are invisible in manual use — they need a fast double click, a mid-job edit, or a close while work is running — and the incorrect ordering reads as correct on the page. Reviewing the code is not enough to settle it; a test that performs the gesture is.

**How to apply:** any new tool with an await between gesture and commit, and any review of one.
