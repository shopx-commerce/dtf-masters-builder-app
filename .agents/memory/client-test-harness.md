---
name: Client unit test harness
description: How the browser-side unit tests run, and what has to be stubbed for editor hooks to be testable at all.
---

The client has a Vitest + jsdom harness for React hook logic, run through the project's test script and registered as a validation check. It is separate from the hand-written verifier scripts, which stay the right tool for pure pixel/geometry logic in plain Node.

**Why:** the editor's hardest bugs are ordering bugs in hook state (which async result may win, which guard belongs to which job). No amount of pixel-level verification reaches them, and reasoning alone missed a real defect that the first test run caught immediately.

**How to apply:**
- Give the test run its own Vite config. The app config exists to build a bundle: it copies pdf.js/onnxruntime assets on buildStart and loads dev-only plugins. Only the module aliases must be kept in sync.
- jsdom has no blob URL store and never fires an image load event, so anything that decodes a Blob into an image hangs forever. The shared setup file stubs object URLs (unique per call, so caches keyed on image src stay meaningful) and resolves image loads on a microtask.
- Modules that import a Web Worker through Vite's worker query cannot be imported for real in tests. Mock them at the module boundary and hand-resolve their promises; keep any cheap predicate they export (such as the abort-error test) faithful to the real rule so a contract change still fails the suite.
- Prefer driving the hook through its returned callbacks over asserting internal refs: the refs are the mechanism, the observable rule is how many expensive jobs actually started.

## jsdom gaps, and how honest the fills are

jsdom implements neither image decoding nor canvas rendering, and is missing pieces of Blob. The setup fills those gaps rather than pulling in a native canvas build, but the fills are bookkeeping-grade, not imaging-grade: image loading is a PNG header check, and the canvas keeps a real pixel buffer yet cannot rasterise a draw. So hook ordering, guards and commit decisions are testable here; anything that asserts on drawn or decoded pixels is not, and a test that appears to do so is passing on a stub.

## Tests must be inside the type check

Typed test fixtures only protect against upstream renames if tsconfig actually compiles the test files. Excluding test globs — easy to inherit from a starter config — silently defeats a fixture built from the real types.
