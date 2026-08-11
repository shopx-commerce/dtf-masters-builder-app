# Sticker-maker → Anynestapplive port brief (2026-08-10)

**Source:** sticker-maker working tree (uncommitted local changes from today).  
**Target:** Anynestapplive tip (modular `image-editor/` like sticker-maker).  
**Process:** Apply as normal edits/commits on tip. **Do NOT force-push.** **Skip `package-lock.json`.**  
**Also available:** full unified diff in `TODAY-UPDATES.patch` (same folder as this brief).

---

## Goals

1. Stop OOM / freezes on large rasters (30"+ / >4096px / >16MP) during crop, alpha probe, and inline canvas copy.
2. Sanitize import physical sizes: refuse NaN/invalid; when BOTH sides ≥ 24.6", scale longest side to 12".
3. UX: Pixel Clean chooser (selected vs full page); Align/Rotate behind one control; Duplicate+Arrange labeled "Duplicate".
4. Harden uploads: prepare-raster retries; R2 wake lock, fingerprint resume, smaller mobile parts, XHR PUT.

## Acceptance tests

- Import ~25"×25"+ both sides → ~12" long side; `toast.imageResized`.
- Import 24.5"×60" → NOT forced to 12".
- Invalid/NaN inches → `toast.invalidImage`, no corrupt draft.
- >16MP or max edge >4096 → no crash; keep original bytes; no full-frame getImageData.
- Pixel Clean menu: Selected / Full page (desktop + mobile).
- Align/Rotate collapsible with rotate + align cluster.
- Duplicate+Arrange short label + title.
- Prepare: 5xx/408/429/network retries 3×; hard 4xx fails once.
- R2: wake lock; fingerprint resume; mobile 8MB parts; XHR PUT.
- es/fr keys for new strings.

## File mapping

| File | Action |
|---|---|
| `client/src/components/image-editor/utils.ts` | sanitizeDesignInches + imageHasCleanAlpha probe |
| `client/src/components/image-editor/useImageEditorModelUploadCrop.ts` | tooBigForInlineCanvas |
| `client/src/components/image-editor/useImageEditorModelArrangeKeyboard.ts` | apply sanitize + toast |
| `client/src/components/image-editor/editor-action-toolbar.tsx` | Pixel Clean + Align/Rotate UI |
| `client/src/components/image-editor/image-editor-view.tsx` | mobile panels for same |
| `client/src/lib/image-utils.ts` | calculateImageDimensions 24.6/12 |
| `client/src/lib/image-crop.ts` | crop size guards |
| `client/src/lib/prepare-raster-upload.ts` | 3× retry |
| `client/src/lib/r2-direct-upload.ts` | wake lock / resume / XHR / part size |
| `client/src/lib/translations/{en,es,fr}.ts` | new keys |
| `package-lock.json` | SKIP |

---

## 1. utils.ts — oversize sanitize + alpha probe

```ts
const MIN_DESIGN_INCHES = 0.01;
const MAX_DESIGN_INCHES = 10_000;
export const OVERSIZE_IMPORT_MIN_SIDE_IN = 24.6;
export const OVERSIZE_IMPORT_TARGET_IN = 12;

function sanitizeDesignInches(
  widthInches: number,
  heightInches: number,
): {
  widthInches: number;
  heightInches: number;
  oversizeFrom?: { widthInches: number; heightInches: number };
} | null {
  const usable = (n: number) => Number.isFinite(n) && n > 0;
  if (!usable(widthInches) || !usable(heightInches)) return null;

  const overshoot = Math.max(widthInches, heightInches) / MAX_DESIGN_INCHES;
  const scale = overshoot > 1 ? 1 / overshoot : 1;
  let w = Math.max(MIN_DESIGN_INCHES, widthInches * scale);
  let h = Math.max(MIN_DESIGN_INCHES, heightInches * scale);

  const shortest = Math.min(w, h);
  if (shortest >= OVERSIZE_IMPORT_MIN_SIDE_IN) {
    const from = { widthInches: w, heightInches: h };
    const longest = Math.max(w, h);
    const fit = OVERSIZE_IMPORT_TARGET_IN / longest;
    w = Math.max(MIN_DESIGN_INCHES, parseFloat((w * fit).toFixed(4)));
    h = Math.max(MIN_DESIGN_INCHES, parseFloat((h * fit).toFixed(4)));
    return { widthInches: w, heightInches: h, oversizeFrom: from };
  }

  return { widthInches: w, heightInches: h };
}

function imageHasCleanAlpha(img: HTMLImageElement): boolean {
  const PROBE_MAX_EDGE = 512;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!(iw > 0) || !(ih > 0)) return false;
  const scale = Math.min(1, PROBE_MAX_EDGE / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, w, h);
  const { data, width, height } = ctx.getImageData(0, 0, w, h);
  return hasCleanAlpha(data, width, height);
}
```

Export `sanitizeDesignInches` and `imageHasCleanAlpha` with the rest of the module exports.

---

## 2. image-utils.ts

```ts
export function calculateImageDimensions(width: number, height: number, dpi: number) {
  let widthInches = parseFloat((width / dpi).toFixed(1));
  let heightInches = parseFloat((height / dpi).toFixed(1));
  if (widthInches >= 24.6 && heightInches >= 24.6) {
    const maxDimension = Math.max(widthInches, heightInches);
    const scale = 12 / maxDimension;
    widthInches = parseFloat((widthInches * scale).toFixed(1));
    heightInches = parseFloat((heightInches * scale).toFixed(1));
  }
  return { widthInches, heightInches };
}
```

---

## 3. image-crop.ts — guards at start of sync + async crop

```ts
const srcW = image.naturalWidth || image.width;
const srcH = image.naturalHeight || image.height;
if (!(srcW > 0) || !(srcH > 0) || srcW * srcH > 16_000_000 || Math.max(srcW, srcH) > 4096) {
  return null; // sync: return null; async: resolve(null); return;
}
```

---

## 4. useImageEditorModelUploadCrop.ts — tooBigForInlineCanvas

Fallback:
```ts
const fbW = image.naturalWidth || image.width;
const fbH = image.naturalHeight || image.height;
const tooBigForInlineCanvas = fbW * fbH > 16_000_000 || Math.max(fbW, fbH) > 4096;
if (opts?.skipCrop && !tooBigForInlineCanvas) { /* full canvas copy */ }
if (!croppedCanvas && !tooBigForInlineCanvas) {
  try { croppedCanvas = cropImageToContent(image); } catch { /* use original */ }
}
```

Main upload:
```ts
const tooBigForInlineCanvas = srcPxW * srcPxH > 16_000_000 || Math.max(srcPxW, srcPxH) > 4096;
if (tooBigForInlineCanvas) croppedCanvas = null;
else if (matchesArtboard) { /* full canvas */ }
if (!croppedCanvas && !tooBigForInlineCanvas) { /* opaque copy or cropImageToContentAsync */ }
if (!croppedCanvas) {
  if (tooBigForInlineCanvas) {
    // Keep original file as print source; downsample preview only
    exportBlob = file; croppedImg = image; inchWidthPx = sourceW; inchHeightPx = sourceH;
  } else {
    await handleFallbackImage(...); return;
  }
}
```

---

## 5. useImageEditorModelArrangeKeyboard.ts — applyImageDirectly

```ts
const applyImageDirectly = useCallback((newImageInfo, rawWidthInches, rawHeightInches, alphaThresholded?) => {
  const sane = sanitizeDesignInches(rawWidthInches, rawHeightInches);
  if (!sane) {
    toast({ title: t("toast.invalidImage"), description: t("toast.invalidImageDesc"), variant: "destructive" });
    return;
  }
  const { widthInches, heightInches, oversizeFrom } = sane;
  // ... existing artboard / placement using widthInches/heightInches ...
  if (oversizeFrom || initialS < 1) {
    const origDims = formatDimensions(oversizeFrom?.widthInches ?? widthInches, oversizeFrom?.heightInches ?? heightInches, lang);
    const fitDims = formatDimensions(widthInches * initialS, heightInches * initialS, lang);
    toast({ title: t("toast.imageResized"), description: t("toast.imageResizedDesc", { origDims, fitDims }), variant: "destructive" });
  }
}, ...);
```

---

## 6. Translations

en:
```ts
"editor.duplicateArrange": "Duplicate",
"editor.duplicateArrangeTitle": "Duplicate and auto-arrange on the sheet",
"editor.cleanAlphaTitle": "Remove semi-transparencies — choose selected design(s) or the full page",
"editor.cleanAlphaSelected": "Selected design",
"editor.cleanAlphaFullPage": "Full page",
"editor.alignRotate": "Align/Rotate",
"editor.alignRotateTitle": "Rotate and align the selected design",
```

es: Duplicar / Duplicar y organizar… / Limpieza title with chooser copy / Diseño seleccionado / Página completa / Alinear/Rotar / Rotar y alinear…  
fr: Dupliquer / Dupliquer et organiser… / Nettoyage title with chooser copy / Design sélectionné / Page entière / Aligner/Tourner / Tourner et aligner…

---

## 7. UI (surgical — do not wholesale-copy huge files)

**Desktop toolbar (`editor-action-toolbar.tsx`):**
- Pixel Clean: one button + dropdown → Selected (`handleThresholdAlpha`) / Full page (`handleThresholdAlphaAll`); Escape/outside click close; mutually exclusive with Align/Rotate.
- Align/Rotate: one button that expands rotate-90, degree presets, center axes, corner aligns.
- Duplicate+Arrange: label `duplicateArrange`, title `duplicateArrangeTitle`.

**Mobile (`image-editor-view.tsx`):**
- Tool ids `alignRotate` and `cleanAlpha` open panels (do NOT minimiseToolsAndFocus on open — same as halftone).
- Panels call existing handlers then close.

---

## 8. prepare-raster-upload retries

`prepareRasterUpload`: max 3 attempts; retry on status >=500, 408, 429, and network errors; backoff `1000 * 2^(attempt-1) + jitter(0-250)`; hard 4xx fails immediately; final network → friendly interruption message.

---

## 9. r2-direct-upload behaviors

- Mobile preferred part **8MB**, desktop **32MB**; mobile concurrency 2.
- Screen Wake Lock session: start at upload, re-acquire on visibilitychange, release in finally.
- Fingerprint resume: `${totalBytes}:${filename}` → remember sessionId; skip completed parts; clear on success; TTL ~24h.
- PUT via XHR (progress, 600s timeout, no keepalive); retry parts with backoff.
- On CORS/network block + shell available → retry with shell relay.

---

## Constraints

- Edit Anynestapplive tip only. **No force-push.**
- Skip package-lock.
- Prefer surgical patches; Anynest may already have some of sanitize/crop work — merge carefully, do not regress.
- Full line-by-line diff: apply `TODAY-UPDATES.patch` where paths match, or copy from sticker-maker working tree files listed above.
