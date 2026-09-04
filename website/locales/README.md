# Language packs

Each file here is one language's interface strings. The app bundles
English and downloads the rest from `https://chess.qurb.cloud/locales/`
the first time a language is picked, then keeps it on the device — so a
language is fetched once and works offline afterwards.

## Adding a language

1. Copy `template.json` to `<code>.json`, where `<code>` is the language's
   two-letter code (`fr`, `de`, …).
2. Replace each English value with the translation. **Leave the keys
   alone** — they are what the app looks up.
3. Add the language to `LANGUAGES` in `app/src/lib/i18n.ts` so it appears
   in Settings.

## Things worth knowing

- **`{placeholders}` must survive.** `"Reviewing {percent}%"` fills
  `{percent}` at runtime; a translation that drops or renames it will
  render the brace literally.
- **`\n` is a real line break**, used in `home.title` to control where the
  headline wraps. Put it where the wrap belongs in your language, not
  where it falls in English.
- **A missing key is not fatal.** Anything absent falls back to English,
  so a partial translation ships fine and improves as it is filled in.
- **Move explanations are not here yet.** They come from a pool of ~370
  interchangeable phrasings so that the same verdict is worded differently
  each time; translating those well means writing new pools per language
  rather than translating sentences, so they stay English for now.

`es.json` was written alongside the feature and has not been reviewed by a
native speaker — treat it as a starting point rather than finished work.
