# Ветка `bundle-1.9.1` — что это и что с этим делать

В этой ветке лежит **собранный `main.js`** версии 1.9.1 (плюс `styles.css` и `manifest.json`),
добавленный принудительно в обход `.gitignore`. Это не исходники: всё, что описано ниже,
правилось прямо в бандле, потому что исходников на машине не было. `src/` в этой ветке —
прежний, от 1.0.0.

**Мержить в `main` нельзя** и тег ставить нельзя: workflow соберёт релиз из старого `src/`,
и все изменения пропадут. Ветка нужна, чтобы работа не потерялась, пока её не перенесли в исходники.

## Порядок переноса

Каждое изменение ниже — это готовый кусок JS в `main.js`, который нужно положить в
соответствующий файл `src/`, вернув то, что съел esbuild: `(0, import_obsidian3.setIcon)` → `setIcon`,
`var X = class extends Y` → `export class X extends Y`, `var _a; ... != null ? _a : b` → `?.`/`??`.
Типы придётся дописать: в бандле их нет.

Проверка после сборки — тесты в `tests/`: они вытаскивают куски **собранного** `main.js` и
выполняют их с заглушками, то есть проверяют ровно то, что уедет в релиз. Собрали — прогнали
все шесть файлов — 173 утверждения должны быть зелёными.

## Что изменилось, по файлам

### src/phonetics.js
- `looksSameRoot` больше не считает родством хвостовое вхождение (`мороз/роз`, `сон/персон`),
  и требует совпадения ¾ длины слова, иначе под правило попадали `весна/весла`.
- Новые `VERB_PREFIXES` и `prefixVerbPair` — отсев приставочных пар **только у глаголов**
  (`ходить/уходить`), у существительных так нельзя: `до+рога`, `по+года`.

### src/dict.ts
- `isVerb(word)`; в `rhymesFor` и `assonancesFor` — отсев приставочных пар и пропуск
  однобуквенных кандидатов («а», «о», «и»).
- Личные словари переехали в папку хранилища: `localDir`, `setLocalDir`, `localFilePath`,
  `legacyLocalPath`, `localFileExists`, `ensureLocalDir`, `relocateLocalDicts`;
  `readGz` разделён на `readGz`/`readGzPath`; в `doLoad` — разовая миграция и чтение
  с запасным старым путём.
- Вид словаря: `kind: "defs" | "syns"` в `setLocalManifest`, `importDict(id, name, entries, kind)`,
  `deleteDict` чистит оба места, `localDefGroups` пропускает синонимические,
  новый `localSynDicts(word)`.
- `defArticle` возвращает отдельно `wiki` и `local`; `definitionsFor` ставит статью
  Викисловаря первой, доставая её у леммы, если у самой формы её нет.

### src/dsl.ts
- `cleanBody` снимает DSL-ссылки `<<…>>`.
- Новые `synWords`, `SYN_COUNT_RE`, `SYN_STOP`, `SYN_MAX_WORDS`, `SYN_MAX_LEN` и переписанная
  ветка синонимов в `convertDsl`: чистит маркеры, нумерацию, пометы и ранги, сводит
  длинные списки в один ряд.

### src/view.ts
- Вставка слова в заметку: `insertWord`, `attachLongPressInsert`, `attachCopyInsert`,
  переписанный `attachWordActions`, обработчики у форм слова, фраз, пословиц и слов внутри
  толкований, `insertHint`, `LONG_PRESS_MS`/`LONG_PRESS_SLOP`.
- Липкие фильтры: `soundKindPref` рядом с `soundKind`, `loadFilters`/`saveFilters`/`clearFilters`/
  `filtersActive`/`renderEmpty`, `POS_KEYS`/`KIND_KEYS`, правки в `showWord`, `setStress`,
  `clearSearch`, `renderSoundResults`.
- Поле `localSyns` и блоки личных словарей синонимов после раздела «Ассоциации»; `availableTabs`.
- Подпись `Викисловарь · сущ.` у первого блока в «Значении» (`renderDefinitions`, `parseWikiRecord`).

### src/main.ts
- Настройки: `filterSyl`, `filterPos`, `filterKind`, `filterSemantic`, `localDictDir`,
  `hideDictDir`; в `loadSettings` — нормализация `kind` у личных словарей.
- `getEditor`, `applyDictDirStyle`, `syncDictDirCase`, `realDirPath`.
- Вкладка настроек: поле папки, переключатель «прятать папку», два списка словарей
  (`renderDictSection`), `importFiles(files, kind)`, починенный `moveDict` (вставка **после**
  цели при движении вниз, отказ перетаскивать между видами), drop читает id из `dataTransfer`,
  пометка «нет файла» у словарей, которых нет на устройстве.

### src/i18n.ts
Около двадцати новых ключей в обеих локалях: `insertHint`, `insertHintTouch`, `noEditor`,
`resetFilters`, `resetFiltersHint`, `locFolder`, `locFolderDesc`, `locHideDir`, `locHideDirDesc`,
`locNoFile`, `locNoFileHint`, `locKindHint`, `locMoved`, `locMoveFail`, `locSynsHint`, `defWiki`;
`locSyns` переписан во множественное число.

### styles.css
`.rr-fclear`, `.rr-dictrow.is-missing`, `.rr-def-pos.is-wiki`, `-webkit-touch-callout: none`
у кликабельных слов, `overflow-wrap: anywhere` у `.rr-body`, `max-width: 100%` у `.rr-chip`,
ужимающийся `.rr-dictwords`.
