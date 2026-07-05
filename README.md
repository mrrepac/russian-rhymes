# Russian Rhymes

An **offline Russian rhyming dictionary** for [Obsidian](https://obsidian.md): rhymes, stress marks, meanings, synonyms and more for the selected word. Made for songwriters, poets and rappers who write in Russian.

Русское описание: [README.ru.md](README.ru.md)

## Highlights

- **Rhymes by sound, not by spelling** — a phonetic rhyme key (stress-tail normalization: vowel reduction, final devoicing, consonant clusters) groups words the way they actually sound. Four tiers: exact · near · slant (consonance) · assonance, plus alliteration.
- **Stress marks** — every word is shown with its stress; click any vowel to move the stress and re-rank the rhymes. Your manual choices are remembered.
- **Meaning tab** — definitions with usage examples and etymology (from Russian Wiktionary), plus a collapsible word-forms table.
- **Associations tab** — synonyms, antonyms, hypernyms/hyponyms, related words, set phrases, proverbs, associations, metagrams and anagrams, each in a collapsible section.
- **"By meaning" filter** — highlight or isolate rhymes that are also related in meaning.
- **Fully offline** — after a one-time dictionary download, everything works with no network.
- **Personal dictionaries** — import your own Lingvo/GoldenDict `.dsl` / `.dsl.dz` files and reorder them.
- **Works on mobile and desktop.**

## Usage

- Select a word and press **Ctrl+C twice** quickly to look it up (the delay is configurable; set it to 0 to disable).
- Or open the panel from the ribbon (feather icon) / the command palette and type a word.
- Or right-click a word in the editor → **Rhymes for "…"**.

In the panel: single-click a word to copy it, double-click to jump into its rhymes. `Ctrl + ← / →` (or a horizontal swipe on mobile) cycles through the sections.

## The dictionary (one-time download)

Obsidian installs only the plugin code (`main.js`, `manifest.json`, `styles.css`). The dictionary itself (~73 MB) is **downloaded on first use** from this repository's GitHub release:

- When you open the panel without a dictionary, tap **Download dictionary (~72 MB)** — a progress indicator is shown.
- The files are stored inside the plugin folder and never leave your device afterwards.
- The download URL is configurable in Settings if you want to self-host the dictionary.

The download is a manual, explicit step so it never eats mobile data or storage without your consent.

## Installation

**From the Community Plugins catalog** (once accepted): Settings → Community plugins → Browse → search "Russian Rhymes" → Install → Enable.

**Manually:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/mrrepac/russian-rhymes/releases) into `<your vault>/.obsidian/plugins/russian-rhymes/`, then enable the plugin in Settings → Community plugins.

## Data sources & licenses

The **plugin code** is MIT-licensed (see [LICENSE](LICENSE)). The **dictionary data** is compiled from open datasets and carries their licenses:

- Word stress & frequencies — [Koziev/NLP_Datasets](https://github.com/Koziev/NLP_Datasets) (`all_accents`, `term2freq`) — **CC0**
- Inflection paradigms & homograph variants — [OpenRussian.org](https://en.openrussian.org/) via [Badestrand/russian-dictionary](https://github.com/Badestrand/russian-dictionary) — **CC BY-SA 4.0**
- Definitions, word forms, synonyms, antonyms, etymology, relations, phrases, idioms, proverbs, metagrams, anagrams, and modern vocabulary — **Russian Wiktionary** via [kaikki.org](https://kaikki.org/) — **CC BY-SA 4.0**
- Word associations — [KartaSlov](https://kartaslov.ru/) ([dkulagin/kartaslov](https://github.com/dkulagin/kartaslov)) — **CC BY-NC-SA 4.0**

Because the compiled data includes ShareAlike sources, the dictionary as a whole is distributed under **CC BY-SA 4.0** (with the association layer additionally **NonCommercial**, CC BY-NC-SA 4.0). Attribution for the definition and association sources is also shown in-app.

## Development

```bash
npm install
npm run build   # tsc type-check + esbuild bundle → main.js
```

The dictionary is built from the sources above with the scripts in `tools/` (see `tools/sources/README.md`). `main.js` and `dict/` are git-ignored; the release workflow builds `main.js` from source on a version tag push.

## License

[MIT](LICENSE) © 2026 mrrepac
