---
name: Resumable upload sessions
description: Invariants for the client-side multipart resume cache, part-list canonicalization, and wake-lock use during transfers.
---

# Resumable upload sessions

## Session identity must be content-bound
The in-session resume cache for multipart R2 uploads is keyed by filename + byte length + SHA-256 over the first AND last 256 KB of the body.
**Why:** filename + length alone can collide across two renders of an edited sheet; resuming across that boundary finalizes a production file mixing bytes of two different exports — the worst possible outcome for a print shop. Head+tail digest of a compressed stream is cheap and effectively collision-proof.
**How to apply:** any future persistence of upload progress (e.g. cross-reload) must carry the same content fingerprint, and resume must be disabled (not weakened) when SubtleCrypto is unavailable.

## Canonicalize multipart part lists
Dedupe by partNumber (last wins) and sort ascending before any S3-style complete call.
**Why:** concurrent part workers and resumed sessions append etags in completion order; S3/R2 completion requires each part exactly once, ascending.
**How to apply:** canonicalize at the single choke point that returns uploaded parts. Do NOT hard-reject parts with missing etags — R2 CORS setups without ExposeHeaders never surface ETag headers and the external shell/store completes from its own part records; a client-side reject would break deployments that work today.

## Resume must ride the route that prepared it
The shell relay and the direct store endpoint each only know sessions they created. A cached session records its route; an explicit route request that disagrees starts fresh instead of resuming.
**Why:** completing a direct-prepared session through the relay (or vice versa) fails or loops the direct→relay fallback recursion.

## Wake lock while bytes move
iOS has no Background Fetch/Sync for web — locking the screen suspends Safari's network process and kills transfers. The only mitigation is a ref-counted Screen Wake Lock held for the transfer duration (supported iOS 16.4+, no-op elsewhere).
**Why:** screen-lock was the top cause of dead big-file uploads on phones.
**How to apply:** wrap new long-running transfer entry points with the shared helper; keep acquisition serialized and release a sentinel that resolves after the last hold was already released (late-acquire leak).
