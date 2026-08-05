import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installUploadStressTest } from "./lib/upload-stress-test";

window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled promise rejection:", e.reason);
  e.preventDefault();
});

window.addEventListener("error", (e) => {
  console.error("Uncaught error:", e.error);
});

// Dev-only. In production builds this is a no-op after tree-shaking
// (`import.meta.env.DEV` is inlined to `false` and the install function's
// guard prevents `window.__stressUpload` from ever being defined).
installUploadStressTest();

// Dev-only: `?stress=N` auto-runs the stress harness after load so
// screenshot-based verification can see a populated sheet.
if (import.meta.env.DEV) {
  const n = Number(new URLSearchParams(window.location.search).get("stress"));
  if (Number.isFinite(n) && n > 0) {
    window.setTimeout(() => {
      (window as any).__stressUpload?.({ count: Math.min(n, 30), dimension: 512 });
    }, 300);
  }
  // Dev-only: `?copytest=1` uploads one design then clicks "Increase copies"
  // so the copy-count flow can be verified from a screenshot.
  if (new URLSearchParams(window.location.search).get("copytest")) {
    const dim = Number(new URLSearchParams(window.location.search).get("copydim")) || 512;
    window.setTimeout(() => {
      (window as any).__stressUpload?.({ count: 1, dimension: Math.min(dim, 8192) });
    }, 300);
    // Poll until the layer row exists, then click once.
    let clicked = false;
    const poll = window.setInterval(() => {
      if (clicked) return;
      const btn = document.querySelector<HTMLButtonElement>('[aria-label="Increase copies"]');
      if (btn) {
        clicked = true;
        window.clearInterval(poll);
        const clicks = Number(new URLSearchParams(window.location.search).get("copyclicks")) || 1;
        console.log(`[copytest] clicking increase copies x${clicks}`);
        let i = 0;
        const clickTimer = window.setInterval(() => {
          const b = document.querySelector<HTMLButtonElement>('[aria-label="Increase copies"]');
          if (b) b.click();
          if (++i >= clicks) window.clearInterval(clickTimer);
        }, 120);
      }
    }, 250);
    // Log every sheet-dimension change so height ratchets are visible in logs.
    let lastDims = "";
    window.setInterval(() => {
      const el = Array.from(document.querySelectorAll("span, div")).find(
        (n) => n.childElementCount === 0 && /^\s*[\d.]+"\s*[x×]\s*[\d.]+"\s*$/.test(n.textContent ?? ""),
      );
      const dims = el?.textContent?.trim() ?? "";
      if (dims && dims !== lastDims) {
        lastDims = dims;
        console.log("[copytest] sheet dims:", dims);
      }
    }, 200);
  }
}

createRoot(document.getElementById("root")!).render(<App />);
