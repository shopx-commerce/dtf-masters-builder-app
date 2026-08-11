/**
 * Hostile-input check for the download filename sanitizer.
 *
 * Export filenames are derived from uploaded design names, so they can contain
 * anything the customer's own filesystem allowed — and the previous code passed
 * them to `link.download` untouched from most call sites. A name like
 * `Logo 3/4" <final>` is ordinary and unwritable on Windows.
 *
 * `safeDownloadFileName` is copied verbatim from client/src/lib/download-file.ts.
 *
 *   node scripts/verify-download-filename.mjs
 */

// ── verbatim from client/src/lib/download-file.ts ─────────────────────────────

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function safeDownloadFileName(filename, fallbackBase = "gangsheet") {
  const raw = String(filename ?? "");
  const dot = raw.lastIndexOf(".");
  const extension = dot > 0 && /^[a-z0-9]{1,8}$/i.test(raw.slice(dot + 1)) ? raw.slice(dot + 1) : "";
  const base = extension ? raw.slice(0, dot) : raw;
  const cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, 120)
    .replace(/[.\s]+$/, "");
  const safeBase = WINDOWS_RESERVED_NAME.test(cleaned) ? `${cleaned}-sheet` : cleaned || fallbackBase;
  return extension ? `${safeBase}.${extension}` : safeBase;
}

// ── invariants every output must satisfy ─────────────────────────────────────

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]/;

function check(input) {
  const out = safeDownloadFileName(input);
  const problems = [];

  if (out.length === 0) problems.push("empty result");
  if (ILLEGAL.test(out)) problems.push("contains a character Windows forbids");
  if (/[.\s]$/.test(out)) problems.push("ends in a dot or space (Windows silently drops it)");
  if (/^[.\s]/.test(out)) problems.push("starts with a dot or space");
  // Reserved names are checked on the base, with or without an extension —
  // `CON.png` is as unwritable as `CON`.
  const base = out.includes(".") ? out.slice(0, out.lastIndexOf(".")) : out;
  if (WINDOWS_RESERVED_NAME.test(base)) problems.push(`reserved device name "${base}"`);
  if (out.length > 200) problems.push(`too long (${out.length})`);

  return { input, out, problems };
}

const HOSTILE = [
  "Logo v1.2 final",
  "sheet.v2",
  "design.2024",
  'Logo 3/4" <final>.png',
  "CON.png",
  "con",
  "PRN.pdf",
  "nul.png",
  "COM1.png",
  "LPT9.svg",
  "aux",
  "trailing dots....png",
  "trailing spaces   .png",
  "   leading spaces.png",
  "...leading dots.png",
  "name.",
  ".",
  "..",
  "...",
  "",
  "   ",
  "\t\n\r.png",
  "tab\there.png",
  "new\nline.png",
  "null\u0000byte.png",
  "del\u007fchar.png",
  "C:\\Users\\me\\Desktop\\file.png",
  "/etc/passwd",
  "..\\..\\..\\windows\\system32\\evil.png",
  "a".repeat(300) + ".png",
  "emoji 🎉🖨️ sheet.png",
  "quote\"and|pipe?and*star.png",
  "semi;colon,comma.png",
  "unicode—dash·dot.png",
  "no extension at all",
  "double..dots.png",
  "UPPERCASE.PNG",
  "22x8in gangsheet @300dpi.png",
  "sheet.tar.gz",
  "v1.2 final",
  null,
  undefined,
  12345,
];

let failed = 0;
for (const input of HOSTILE) {
  const { out, problems } = check(input);
  const shown = typeof input === "string" ? JSON.stringify(input) : String(input);
  const label = shown.length > 46 ? `${shown.slice(0, 43)}...` : shown;
  if (problems.length === 0) {
    console.log(`pass  ${label.padEnd(48)} -> ${JSON.stringify(out)}`);
  } else {
    failed++;
    console.error(`FAIL  ${label.padEnd(48)} -> ${JSON.stringify(out)}`);
    for (const p of problems) console.error(`        ${p}`);
  }
}

// Extensions must survive, or the OS opens the file with the wrong application.
const EXT_PRESERVED = [
  ["sheet.png", "png"],
  ["sheet.pdf", "pdf"],
  ["sheet.svg", "svg"],
  ["sheet.eps", "eps"],
  ['Logo 3/4" <final>.png', "png"],
  ["CON.png", "png"],
];
for (const [input, ext] of EXT_PRESERVED) {
  const out = safeDownloadFileName(input);
  if (!out.toLowerCase().endsWith(`.${ext}`)) {
    failed++;
    console.error(`FAIL  extension lost: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
  }
}

console.log(`\n${HOSTILE.length + EXT_PRESERVED.length - failed} checks passed, ${failed} failed`);
if (failed === 0) {
  console.log("Every output is writable on Windows and macOS, and keeps its extension.");
}
process.exit(failed === 0 ? 0 : 1);
