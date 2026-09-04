import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applySettings, loadSettings } from "./lib/settings";
import { restoreLanguage } from "./lib/i18n";

applySettings(loadSettings());

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
