import fs from "node:fs";
import path from "node:path";

const root = "/Users/brainxshopify/dtf-masters-builder-app";
const viewPath = path.join(root, "client/src/components/image-editor/image-editor-view.tsx");
const toolbarPath = path.join(root, "client/src/components/image-editor/editor-action-toolbar.tsx");

function extractBindingNames(block) {
  return new Set(
    block
      .split(",")
      .map((s) => s.trim().split(":")[0].trim())
      .filter(Boolean),
  );
}

function extractContextDestructuredNames(fileContent) {
  const marker = "} = useImageEditorContext()";
  const close = fileContent.indexOf(marker);
  if (close < 0) return new Set();
  const open = fileContent.lastIndexOf("const {", close);
  if (open < 0) return new Set();
  return extractBindingNames(fileContent.slice(open + 7, close));
}

function extractToolbarDestructured(fileContent) {
  const marker = "} = props;";
  const close = fileContent.indexOf(marker);
  if (close < 0) return new Set();
  const open = fileContent.lastIndexOf("const {", close);
  if (open < 0) return new Set();
  return extractBindingNames(fileContent.slice(open + 7, close));
}

function findUsedIdentifiers(body) {
  const skip = new Set([
    "true", "false", "null", "undefined", "return", "if", "else", "const", "let", "var",
    "function", "async", "await", "new", "typeof", "case", "break", "switch", "default",
    "for", "while", "try", "catch", "finally", "throw", "import", "from", "export", "class",
    "Math", "window", "document", "console", "Promise", "Set", "Map", "Array", "Object",
    "String", "Number", "Boolean", "Date", "JSON", "Error", "Blob", "File", "prev", "next",
    "setTimeout", "clearTimeout",
    "div", "button", "span", "input", "img", "style", "type", "key", "icon", "label", "action",
    "disabled", "shortcut", "className", "title", "onClick", "onChange", "onKeyDown", "ref",
    "value", "max", "lang", "rows", "row", "first", "d", "e", "v", "h", "w", "i", "n", "m",
  ]);
  const ids = new Set();
  for (const m of body.matchAll(/\b([a-z][a-zA-Z0-9_]*)\b/g)) {
    const id = m[1];
    if (!skip.has(id)) ids.add(id);
  }
  return ids;
}

function componentBody(fileContent, closeMarker) {
  const close = fileContent.indexOf(closeMarker);
  if (close < 0) return "";
  const semi = fileContent.indexOf(";\n", close);
  if (semi < 0) return "";
  return fileContent.slice(semi + 2);
}

function audit(label, filePath, destructureFn, closeMarker) {
  const content = fs.readFileSync(filePath, "utf8");
  const declared = destructureFn(content);
  const body = componentBody(content, closeMarker);
  const used = findUsedIdentifiers(body);
  const missing = [...used].filter((id) => !declared.has(id)).sort();
  const suspicious = missing.filter((id) =>
    id.startsWith("handle") ||
    id.startsWith("set") ||
    id.endsWith("Ref") ||
    ["profile", "designs", "canUndo", "canRedo", "isMobile", "isLgUp"].includes(id),
  );
  if (suspicious.length) {
    console.error(`${label} missing from destructure:`, suspicious.join(", "));
    process.exitCode = 1;
  } else {
    console.log(`${label}: OK (${declared.size} bindings)`);
  }
}

audit("image-editor-view", viewPath, extractContextDestructuredNames, "} = useImageEditorContext()");
audit("editor-action-toolbar", toolbarPath, extractToolbarDestructured, "} = props;");
