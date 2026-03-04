import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled promise rejection:", e.reason);
  e.preventDefault();
});

window.addEventListener("error", (e) => {
  console.error("Uncaught error:", e.error);
});

createRoot(document.getElementById("root")!).render(<App />);
