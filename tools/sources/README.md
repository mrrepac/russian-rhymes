# Исходные датасеты (не в git)

Скачать в эту папку, затем по порядку: `npm run dict` (рифмы+ударения), `node tools/build-definitions.mjs` (толкования+примеры+этимология), `node tools/build-synonyms.mjs` (синонимы+антонимы), `node tools/build-assoc.mjs` (ассоциации), `node tools/build-linkages.mjs` (гиперонимы+гипонимы+родственные), `node tools/build-lemmas.mjs` (леммы — строго последним: фильтрует по готовым словарям).

Богатые сборки (`build-definitions`, `build-linkages`) держат в памяти весь словарь — запускать через `node --max-old-space-size=4096 …`.

| Файл | Откуда | Лицензия |
|---|---|---|
| `all_accents.tsv` | https://github.com/Koziev/NLP_Datasets → `Stress/all_accents.zip` (распаковать) | CC0 |
| `term2freq.dat` | https://github.com/Koziev/NLP_Datasets → `WordformFrequencies/Data/term2freq.7z` (распаковать) | CC0 |
| `openrussian-nouns.csv`, `openrussian-verbs.csv`, `openrussian-adjectives.csv`, `openrussian-others.csv` | https://github.com/Badestrand/russian-dictionary (файлы `nouns.csv` и т.д., переименовать с префиксом `openrussian-`) | CC BY-SA 4.0 |
| `th_ru_RU.dat` | https://github.com/LibreOffice/dictionaries → `ru_RU/th_ru_RU_M_aot_and_v2.dat` (переименовать) | LGPL 2.1 (АОТ + словарь синонимов Абрамова, 1911) |
| `kaikki-ru.jsonl.gz` | https://kaikki.org/ruwiktionary/Русский/ → `kaikki.org-dictionary-Русский.jsonl.gz` (wiktextract-дамп русского Викисловаря) | CC BY-SA (Викисловарь) |
| `word2lemma.dat` | https://github.com/Koziev/NLP_Datasets → `Lemmas/Data/word2lemma.7z` (распаковать) | CC0 |
| `assoc.safe.csv` | https://github.com/dkulagin/kartaslov → `dataset/assoc/assoc.safe.csv` (качать Invoke-WebRequest — curl/schannel рвёт соединение) | CC BY-NC-SA 4.0 |

Выход пайплайна — папка `dict/` рядом с manifest.json:
- `words.txt.gz` — слово → варианты ударения (индекс, частотный бакет 0–9, часть речи)
- `rhymes.txt.gz` — рифм-ключ → слова группы
- `synonyms.txt.gz` — слово → группы синонимов (группа Викисловаря первой, затем группы Абрамова/АОТ)
- `antonyms.txt.gz` — слово → антонимы (Викисловарь)
- `associations.txt.gz` — слово → ассоциации по убыванию веса (КартаСлов, safe)
- `hypernyms.txt.gz` / `hyponyms.txt.gz` / `related.txt.gz` — гиперонимы / гипонимы / родственные слова (Викисловарь); формат «слово\tw1,w2,…»
- `idioms.txt.gz` / `proverbs.txt.gz` — устойчивые сочетания (derived) / пословицы (Викисловарь); формат «слово\tфраза1|фраза2» (фразы, разделитель «|»)
- `metagrams.txt.gz` / `anagrams.txt.gz` — метаграммы / анаграммы (Викисловарь); формат «слово\tw1,w2» (регистр сохранён)
- `forms.txt.gz` — парадигма словоформ с ударениями; формат «слово\tметка:форма|метка:форма» (только однословные формы, метки из грамматических тегов)
- `definitions.txt.gz` — слово → толкования (богатый формат: этимология + значения по частям речи + ВСЕ цитаты-примеры с источниками; управляющие разделители \x1d/\x1f/\x1e/\x1c, парсер в src/dict.ts); `слово\t>лемма` — редирект словоформы
- `lemmas.txt.gz` — словоформа → лемма(ы): толкования и синонимы форм ищутся у леммы («разуму» → «разум»); собирается ПОСЛЕ words/definitions/synonyms (`node tools/build-lemmas.mjs`)
- `phrases.txt.gz` — слово → фразеологизмы Викисловаря с толкованиями (`node tools/build-phrases.mjs`)
- `local-<id>.txt.gz` — ЛИЧНЫЕ толковые словари из DSL (Lingvo/GoldenDict): каждый добавленный словарь — свой файл со случайным id. Добавляются В НАСТРОЙКАХ ПЛАГИНА (секция «Толковые словари», кнопка «Добавить .dsl»; конвертер встроен — src/dsl.ts). Список id, имён и порядка хранится в data.json (`localDicts`); порядок задаёт очерёдность групп во вкладке «Значение», после Викисловаря. **В релизы не включать.**
- `meta.json` — счётчики и источники

Файлы `dict/` не коммитятся: при публикации прикладываются к GitHub-релизу как ассеты.

## Публикация словаря (для скачивания плагином)

Плагин при первом запуске (мобильный/новая установка, где нет папки `dict/`) качает
словарь с GitHub-релиза по адресу из настройки «Адрес словаря» (дефолт —
`github.com/mrrepac/russian-rhymes/releases/download/dict/`). Список файлов и размеров
берётся из `dict/files.json` (генерируется скриптом; перечисляет только открытые
`*.txt.gz`, БЕЗ личных `local-*`).

Публикация/обновление ассетов: один раз `gh auth login`, затем `bash tools/upload-dict.sh`
(создаёт публичный репозиторий и релиз `dict`, заливает открытые файлы + `files.json`,
перезаписывая старые). После каждой пересборки словаря — запустить снова и обновить
`files.json`.
