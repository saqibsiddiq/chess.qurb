import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, initialTheme } from "./lib/theme";

// Dev-only practice harness, reached with ?harness=practice. It exists
// because the practice board can't otherwise be exercised outside the
// Tauri runtime, and a board that silently refused to move pieces once
// shipped for exactly that reason. `import.meta.env.DEV` is statically
// false in a production build, so Vite drops both the branch and the
// dynamic import from the bundle.
// Applied before React renders so the app never paints the light ground
// for a frame on the way to the dark one.
applyTheme(initialTheme());

const wantsHarness =
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get("harness") === "practice";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

if (wantsHarness) {
  import("./PracticeHarness").then(({ default: PracticeHarness }) => {
    root.render(
      <React.StrictMode>
        <PracticeHarness />
      </React.StrictMode>,
    );
  });
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
