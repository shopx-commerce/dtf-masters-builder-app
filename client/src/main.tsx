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

createRoot(document.getElementById("root")!).render(<App />);
