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
}

createRoot(document.getElementById("root")!).render(<App />);
