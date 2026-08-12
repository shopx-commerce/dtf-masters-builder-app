/**
 * Lift declarations out of the app's TypeScript sources so a Node script can
 * call them directly.
 *
 * Verification scripts used to keep verbatim copies of the functions they
 * checked, with a comment asking whoever changed the original to re-copy them.
 * That held exactly as long as somebody remembered: the copies went stale the
 * first time the real function changed, and the script carried on passing
 * against its own private version. Reading the declarations out of the source
 * at run time removes the opportunity.
 *
 * This is not a TypeScript parser. It knows enough about the house style to
 * find a named top-level declaration and its extent, and it fails loudly rather
 * than returning something partial.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { transform } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Read a source file, relative to the repository root. */
export function readSource(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

/**
 * Step over a comment or string literal, if `i` is at the start of one.
 *
 * Returns the index to continue scanning from — the same index when there was
 * nothing to skip, so callers can use it unconditionally.
 */
function skipTrivia(source, i) {
  const ch = source[i];
  const next = source[i + 1];
  if (ch === "/" && next === "/") {
    const nl = source.indexOf("\n", i);
    return nl === -1 ? source.length : nl;
  }
  if (ch === "/" && next === "*") {
    const end = source.indexOf("*/", i + 2);
    return end === -1 ? source.length : end + 2;
  }
  if (ch === '"' || ch === "'" || ch === "`") {
    for (let j = i + 1; j < source.length; j++) {
      if (source[j] === "\\") { j++; continue; }
      if (source[j] === ch) return j + 1;
    }
    return source.length;
  }
  return i;
}

/** Index just past the `close` that matches the first `open` at or after `from`. */
function matchDelimiters(source, from, open, close) {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const skipped = skipTrivia(source, i);
    if (skipped !== i) { i = skipped - 1; continue; }
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0) return i + 1;
  }
  throw new Error("Unbalanced delimiters");
}

/**
 * Index of a function's body brace, skipping the return type annotation.
 *
 * A return type can put braces between the parameter list and the body, both
 * nested (`Promise<{ filtered: Uint8Array }>`) and bare (`: { sawInk: boolean }`),
 * and a header taken to end at one of those parses as a bodiless overload
 * signature — which is valid TypeScript, so it disappears silently instead of
 * failing. The body brace is the one that opens a line; every type annotation
 * in these sources is written inline.
 */
function bodyBraceAfterParams(source, from) {
  for (let i = from; i < source.length; i++) {
    const skipped = skipTrivia(source, i);
    if (skipped !== i) { i = skipped - 1; continue; }
    if (source[i] !== "{") continue;
    if (/^[ \t]*\r?\n/.test(source.slice(i + 1))) return i;
  }
  throw new Error("No function body found");
}

/** Index just past the `;` that ends a statement starting at `from`. */
function statementEnd(source, from) {
  let round = 0;
  let curly = 0;
  let square = 0;
  for (let i = from; i < source.length; i++) {
    const skipped = skipTrivia(source, i);
    if (skipped !== i) { i = skipped - 1; continue; }
    const ch = source[i];
    if (ch === "(") round++;
    else if (ch === ")") round--;
    else if (ch === "{") curly++;
    else if (ch === "}") curly--;
    else if (ch === "[") square++;
    else if (ch === "]") square--;
    else if (ch === ";" && round === 0 && curly === 0 && square === 0) return i + 1;
  }
  throw new Error("Unterminated statement");
}

/**
 * Cut one top-level declaration out of a TypeScript source file by name.
 *
 * Anything it cannot find is a hard failure rather than a silent skip, because
 * a silently missing function is how a test starts passing vacuously.
 */
export function extract(source, name, file) {
  // Re-exported as one list at the end, so the original keyword has to go.
  const unexport = (text) => text.replace(/^export /, "");
  const asFunction = new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "m");
  const asClass = new RegExp(`^(?:export )?class ${name}\\b`, "m");
  const asConst = new RegExp(`^(?:export )?(?:const|let) ${name}\\b`, "m");

  let match = asFunction.exec(source);
  if (match) {
    const params = matchDelimiters(source, match.index, "(", ")");
    const body = bodyBraceAfterParams(source, params);
    return unexport(source.slice(match.index, matchDelimiters(source, body, "{", "}")));
  }
  match = asClass.exec(source);
  if (match) {
    return unexport(source.slice(match.index, matchDelimiters(source, match.index, "{", "}")));
  }
  match = asConst.exec(source);
  if (match) {
    return unexport(source.slice(match.index, statementEnd(source, match.index)));
  }
  throw new Error(`Could not find ${name} in ${file} — did it get renamed?`);
}

/**
 * Compile lifted declarations into a module and import it.
 *
 * Type annotations are stripped rather than checked, so a declaration may refer
 * to interfaces that were not lifted alongside it.
 */
export async function compileDeclarations({ prelude = "", pieces, exports }) {
  const ts = [prelude, ...pieces, `export { ${exports.join(", ")} };`]
    .filter(Boolean)
    .join("\n\n");
  const { code } = await transform(ts, { loader: "ts", format: "esm", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
