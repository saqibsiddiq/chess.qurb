import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applySettings, loadSettings } from "./lib/settings";
import { restoreLanguage } from "./lib/i18n";

// Dev-only practice harness, reached with ?harness=practice. It exists
// because the practice board can't otherwise be exercised outside the
// Tauri runtime, and a board that silently refused to move pieces once
// shipped for exactly that reason. `import.meta.env.DEV` is statically
// false in a production build, so Vite drops both the branch and the
// dynamic import from the bundle.
// Applied before React renders so the app never paints the light ground
// for a frame on the way to the dark one — and the same for the board,
// which would otherwise flash the default colours.
applySettings(loadSettings());

// The pack is cached after its first download, so this is usually a
// synchronous read dressed as a promise. It is deliberately not awaited:
// a slow or failed restore must not hold up first paint, and the app
// starts in English and re-renders when the pack lands.
void restoreLanguage();

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
