# Russian Rhymes

An **offline Russian rhyming dictionary** for [Obsidian](https://obsidian.md): rhymes, stress marks, meanings, synonyms and more for the selected word. Made for songwriters, poets and rappers who write in Russian.

Русское описание: [README.ru.md](README.ru.md)

## Highlights

- **Rhymes by sound, not by spelling** — a phonetic rhyme key (stress-tail normalization: vowel reduction, final devoicing, consonant clusters) groups words the way they actually sound. Four tiers: exact · near · slant (consonance) · assonance, plus alliteration.
- **Follow the cursor** — the panel keeps showing rhymes for the last word of the line you are typing; unfinished and unknown words are skipped, so the list never flickers.
- **Stress marks** — every word is shown with its stress; click any vowel to move the stress and re-rank the rhymes. Your manual choices are remembered.
- **Meaning tab** — definitions with usage examples and etymology (from Russian Wiktionary), plus a collapsible word-forms table.
- **Associations tab** — synonyms, antonyms, hypernyms/hyponyms, related words, set phrases, proverbs, associations, metagrams and anagrams, each in a collapsible section.
- **"By meaning" filter** — highlight or isolate rhymes that are also related in meaning.
- **Fully offline** — after a one-time dictionary download, everything works with no network.
- **Light on memory** — the two largest parts of the dictionary (definitions and word forms, ~360 MB of text) are read from disk in compressed blocks instead of being held in RAM: a lookup touches tens of kilobytes and only a ~50 KB index stays resident. You also choose what is preloaded at startup — nothing, rhymes, or rhymes and meanings.
- **Personal dictionaries** — import your own Lingvo/GoldenDict `.dsl` / `.dsl.dz` files and reorder them.
- **Works on mobile and desktop.**

## Usage

- Select a word and press **Ctrl+C twice** quickly to look it up (the delay is configurable; set it to 0 to disable).
- Or open the panel from the ribbon (feather icon) / the command palette and type a word.
- Or right-click a word in the editor → **Rhymes for "…"**.
- Or turn on **follow the cursor** (the crosshair button next to the search field, a command, or the setting) and just write — rhymes for the end of the current line appear on their own.

In the panel: single-click a word to copy it, double-click to jump into its rhymes. `Ctrl + ← / →` (or a horizontal swipe on mobile) cycles through the sections.

## The dictionary (one-time download)

Obsidian installs only the plugin code (`main.js`, `manifest.json`, `styles.css`). The dictionary itself (~73 MB) is **downloaded on first use** from this repository's GitHub release:

- When you open the panel without a dictionary, tap **Download dictionary (~72 MB)** — a progress indicator is shown.
- The files are stored inside the plugin folder and never leave your device afterwards.
- The download URL is configurable in Settings if you want to self-host the dictionary.

The download is a manual, explicit step so it never eats mobile data or storage without your consent.

**Download it once, not once per device.** Obsidian Sync does not reach inside a plugin's folder,
so by default every device fetches its own copy. Point **Dictionary folder (for sync)** in the
settings at a folder inside your vault and the plugin moves the dictionary there; Sync then carries
it like any other file and your phone never downloads anything. Requires "sync all other file types"
in Sync settings. The folder is hidden from the file explorer along with the personal-dictionary one.

Since 2.0.0 the two biggest shards ship as `*.blk.gz` — a gzip file made of independent ~64 KB
members — next to a small `*.blkidx.gz` listing the first key and byte offset of every block. The
plugin fetches a single block with an HTTP `Range` request and inflates only that. Where ranged
reads are unavailable the file is simply read whole, exactly as before: `*.blk.gz` is still an
ordinary gzip archive.

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

`main.js` is bundled from `src/` with esbuild:

```
npm ci
npm run build
```

Copy `main.js` (together with `manifest.json` and `styles.css`) into
`<vault>/.obsidian/plugins/russian-rhymes/` and reload the plugin to test. The bundle is committed
next to the sources so that manual installs and the release assets stay in step; the release
workflow rebuilds it and fails the release if the committed file disagrees, so build before you
commit. The output is deliberately not minified.

The headless test suite and the scripts that compile the dictionary from the sources above are
kept outside this repository. `dict/` is not committed either — the data is published under the
`dict` tag and downloaded by the plugin on first use. Pushing a version tag (`2.0.0`) publishes a
release with the three plugin files.

## License

[MIT](LICENSE) © 2026 mrrepac
