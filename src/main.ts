import { MarkdownView, Notice, Plugin, PluginSettingTab, ToggleComponent, debounce, setIcon } from "obsidian";
import type { App, Debouncer, Editor, PluginManifest, Setting, SettingDefinitionItem, SettingGroup, TAbstractFile, TFolder } from "obsidian";
import type { DictKind, LocalDict, ShardInfo } from "./dict";
import { RhymeDict } from "./dict";
import { t } from "./i18n";
import { RhymesView, STARTUP_KEYS, VIEW_TYPE_RHYMES } from "./view";
import { convertDsl } from "./dsl";

/** Настройки плагина, как они лежат в data.json. */
export interface RhymesSettings {
  doubleCopyMs: number; // 0 = выключено
  /** Видимые лексические слои: [базовая, частотная, обычная, редкая]. */
  lexShow: boolean[];
  /** База URL для скачивания словаря из релиза. */
  dictUrl: string;
  /** Пасхалка: открыт ли генератор слов (разблокируется словом «фристайл»). */
  genUnlocked: boolean;
  /** Панель сама показывает рифмы к последнему слову строки, где стоит курсор. */
  followCursor: boolean;
  filterSyl: number;
  filterPos: string;
  filterKind: string;
  filterSemantic: boolean;
  localDictDir: string;
  hideDictDir: boolean;
  startupLoad: string;
  mainDictDir: string;
  // из старых версий: читаются один раз при загрузке и удаляются
  showRare?: boolean;
  pageSize?: number;
}
/** Содержимое data.json целиком. Всё необязательно: файл переживает версии и правки руками. */
interface PersistedData {
  settings?: Partial<RhymesSettings>;
  userStress?: Record<string, number>;
  localDicts?: LocalDict[];
}

const DEFAULT_SETTINGS = {
  doubleCopyMs: 400,
  lexShow: [true, true, true, false],
  dictUrl: "https://github.com/mrrepac/russian-rhymes/releases/download/dict/",
  genUnlocked: false,
  followCursor: false,
  filterSyl: 0,
  filterPos: "",
  filterKind: "all",
  filterSemantic: false,
  localDictDir: "Словари рифм",
  hideDictDir: true,
  startupLoad: "rhymes",
  // пусто — словарь остаётся в папке плагина, как раньше; переезд только по желанию
  mainDictDir: ""
};
const FOLLOW_DELAY_MS = 500;
const MIN_FOLLOW_LEN = 3;
/**
 * Название шарда для настроек и уведомлений. Перечислено вручную, а не собрано из ключа:
 * t() принимает только существующие ключи, и склеенный ключ такой проверки не проходит.
 * Таблица строится на каждый вызов — язык берётся из moment в момент обращения.
 */
function shardTitle(name: string) {
  const titles: Record<string, string> = {
    words: t("shardWords"),
    rhymes: t("shardRhymes"),
    forms: t("shardForms"),
    definitions: t("shardDefinitions"),
    synonyms: t("shardSynonyms"),
    antonyms: t("shardAntonyms"),
    associations: t("shardAssociations"),
    hypernyms: t("shardHypernyms"),
    hyponyms: t("shardHyponyms"),
    related: t("shardRelated"),
    idioms: t("shardIdioms"),
    proverbs: t("shardProverbs"),
    metagrams: t("shardMetagrams"),
    anagrams: t("shardAnagrams"),
    lemmas: t("shardLemmas"),
    phrases: t("shardPhrases"),
    yo: t("shardYo"),
    generator: t("shardGenerator")
  };
  return titles[name] || name;
}
/** Размер файла человеку: мегабайты с десятой, мелочь — в килобайтах. */
function fmtSize(bytes: number) {
  if (bytes >= 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} ${t("unitMb")}`;
  return `${Math.max(1, Math.round(bytes / 1024))} ${t("unitKb")}`;
}
const RussianRhymesPlugin = class extends Plugin {
  settings: RhymesSettings;
  userStress: Record<string, number>;
  localDicts: LocalDict[];
  // словарь создаётся в onload, до него его нет
  dict!: InstanceType<typeof RhymeDict>;
  lastCopyAt: number;
  hiddenDirs: string[];
  dirObserver: MutationObserver | null;
  dirCleanupRegistered?: boolean;
  navArmed: boolean;
  followSync: Debouncer<[], void>;
  lastFollowKey: string;
  badWarned: string;
  missingWarned: string;

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);
    this.settings = DEFAULT_SETTINGS;
    this.userStress = {};
    this.localDicts = [];
    this.lastCopyAt = 0;
    // папки словарей, спрятанные из проводника (в нижнем регистре, см. applyDictDirStyle)
    this.hiddenDirs = [];
    this.dirObserver = null;
    // после двойного Ctrl+C, пока Ctrl не отпущен, стрелки ←/→ листают разделы панели
    this.navArmed = false;
    // режим «следовать за курсором»: реагируем на паузу в наборе, а не на каждый символ
    this.followSync = debounce(() => this.syncFromCursor(), FOLLOW_DELAY_MS, true);
    // что панель уже показала по редактору; пока это не изменилось, слежение молчит и не
    // перебивает слово, выбранное вручную (двойной клик по чипу, двойной Ctrl+C, поле поиска)
    this.lastFollowKey = "";
    // о каких сломанных личных словарях уже сказали (чтобы не повторяться на каждой загрузке)
    this.badWarned = "";
    // то же про недостающие файлы самого словаря
    this.missingWarned = "";
  }
  async onload() {
    let _a;
    await this.loadSettings();
    this.dict = new RhymeDict(this.app, (_a = this.manifest.dir) != null ? _a : "");
    this.syncLocalManifest();
    this.dict.setLocalDir(this.settings.localDictDir);
    this.dict.setMainDir(this.settings.mainDictDir);
    this.applyDictDirStyle();
    this.registerView(VIEW_TYPE_RHYMES, (leaf) => new RhymesView(leaf, this));
    this.addRibbonIcon("feather", t("cmdOpen"), () => void this.activateView(null));
    this.addCommand({
      id: "open-panel",
      name: t("cmdOpen"),
      callback: () => void this.activateView(null)
    });
    this.addCommand({
      id: "find-rhymes",
      name: t("cmdFind"),
      callback: () => {
        const w = this.grabWord();
        if (w)
          void this.activateView(w);
      }
    });
    this.addCommand({
      id: "toggle-follow",
      name: t("cmdFollow"),
      callback: () => void this.setFollow(!this.settings.followCursor)
    });
    this.registerDomEvent(document, "selectionchange", () => {
      if (this.settings.followCursor)
        this.followSync();
    });
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        if (this.settings.followCursor)
          this.followSync();
      })
    );
    this.register(() => this.followSync.cancel());
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const w = this.wordFromEditor(editor);
        if (!w)
          return;
        menu.addItem(
          (item) => item.setTitle(t("menuFind") + w + t("menuFindEnd")).setIcon("feather").onClick(() => void this.activateView(w))
        );
      })
    );
    this.registerDomEvent(
      document,
      "keydown",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) {
          this.navArmed = false;
          return;
        }
        if (e.key === "Alt") {
          if (e.repeat)
            return;
          const view = this.getRhymesView();
          if (!view || !view.hasWord())
            return;
          const focusInPanel = view.containerEl.contains(activeDocument.activeElement);
          if (!this.navArmed && !focusInPanel)
            return;
          e.preventDefault();
          e.stopPropagation();
          view.cycleTab(1);
          return;
        }
        if (e.shiftKey || e.altKey)
          return;
        if (e.code === "KeyC") {
          if (this.navArmed) {
            const view = this.getRhymesView();
            if (view && view.hasWord()) {
              e.preventDefault();
              e.stopPropagation();
              if (!e.repeat)
                view.cycleTab(1);
              return;
            }
          }
          if (e.repeat)
            return;
          const ms = this.settings.doubleCopyMs;
          if (!ms)
            return;
          const now = Date.now();
          if (now - this.lastCopyAt < ms) {
            this.lastCopyAt = 0;
            const w = this.grabWord();
            if (w) {
              this.navArmed = true;
              void this.activateView(w);
            }
          } else {
            this.lastCopyAt = now;
          }
          return;
        }
        if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
          const view = this.getRhymesView();
          if (!view || !view.hasWord())
            return;
          const focusInPanel = view.containerEl.contains(activeDocument.activeElement);
          if (!this.navArmed && !focusInPanel)
            return;
          e.preventDefault();
          e.stopPropagation();
          view.cycleTab(e.code === "ArrowRight" ? 1 : -1);
        }
      },
      { capture: true }
    );
    this.registerDomEvent(
      document,
      "keyup",
      (e) => {
        if (e.key === "Control" || e.key === "Meta")
          this.navArmed = false;
      },
      { capture: true }
    );
    this.registerDomEvent(window, "blur", () => {
      this.navArmed = false;
    });
    this.addSettingTab(new RhymesSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      // хранилище проиндексировано только сейчас — до этого настоящий регистр папки не узнать
      void this.syncDictDirCase().then(() => this.applyDictDirStyle());
      void this.ensureViewInSidebar(false);
      void this.startupPreload();
    });
  }
  /**
   * Прогрев словаря по выбранному режиму. Вынесено из onLayoutReady отдельным методом:
   * иначе это была бы проводка «настройка → словарь», до которой тесты не дотягиваются.
   */
  startupPreload() {
    const mode = this.startupMode();
    if (mode === "none")
      return Promise.resolve();
    return this.dict.load().then(() => {
      this.warnBadDicts();
      this.warnMissingShards();
      if (mode === "full")
        return this.dict.loadHeavy();
    });
  }
  /** Режим прогрева при старте; data.json правят руками, поэтому значение сверяем. */
  startupMode() {
    const v = this.settings.startupLoad;
    return STARTUP_KEYS.includes(v) ? v : DEFAULT_SETTINGS.startupLoad;
  }
  async loadSettings() {
    let _a;
    // data.json пишем мы сами, но правят его и руками, поэтому форма — «может быть, есть»
    const data = await this.loadData() as PersistedData | null;
    if (data && data.settings) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
      this.userStress = (_a = data.userStress) != null ? _a : {};
      this.localDicts = Array.isArray(data.localDicts) ? data.localDicts.map((d: LocalDict) => ({ ...d, enabled: d.enabled !== false, kind: d.kind === "syns" ? "syns" : "defs" })) : [];
    } else {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data != null ? data : {});
    }
    const legacy = this.settings.showRare;
    if (!Array.isArray(this.settings.lexShow) || this.settings.lexShow.length !== 4) {
      this.settings.lexShow = [true, true, true, legacy === true];
    }
    delete this.settings.showRare;
    delete this.settings.pageSize;
  }
  /**
   * Отдать словарю список личных словарей целиком. Именно целиком: раньше тут
   * перечислялись поля по одному и kind в список не попадал, поэтому после каждого
   * запуска Obsidian все словари синонимов считались толковыми и уезжали из
   * «Ассоциаций» во «Значение» — до первого повторного импорта.
   */
  syncLocalManifest() {
    this.dict.setLocalManifest(this.localDicts);
  }
  /**
   * Сказать про личные словари, которые лежат на месте, но не читаются. Такой файл плагин
   * не удаляет — его папку носит синхронизация, и удаление уехало бы на второе устройство,
   * — поэтому без предупреждения о поломке можно было бы узнать только по пустой выдаче.
   * Повторяем ровно тогда, когда набор сломанных словарей изменился.
   */
  warnBadDicts() {
    const bad = this.localDicts.filter((d) => this.dict.isLocalBroken(d.id)).map((d) => d.name);
    const key = bad.join(", ");
    if (!bad.length || key === this.badWarned)
      return;
    this.badWarned = key;
    new Notice(t("noticeBadDicts") + key, 1e4);
  }
  /**
   * Сказать про недостающие файлы самого словаря. Отсутствие шарда — не ошибка загрузки:
   * панель работает и без пословиц. Но оборванная закачка выглядит точно так же, а вкладки
   * при этом молча пусты — поэтому один раз называем, чего именно нет.
   */
  warnMissingShards() {
    const missing = this.dict.missingShards;
    const key = missing.join(",");
    if (!missing.length || key === this.missingWarned)
      return;
    this.missingWarned = key;
    new Notice(t("noticeMissingShards") + missing.map((n) => shardTitle(n)).join(", "), 1e4);
  }
  async saveSettings() {
    const data = { settings: this.settings, userStress: this.userStress, localDicts: this.localDicts };
    await this.saveData(data);
  }
  /** Запомненное пользователем ударение слова. */
  getUserStress(word: string) {
    return this.userStress[word];
  }
  setUserStress(word: string, s: number | null) {
    if (s === null)
      delete this.userStress[word];
    else
      this.userStress[word] = s;
    void this.saveSettings();
  }
  /** Слово из выделения/под курсором активного редактора, иначе из window-выделения. */
  grabWord() {
    let _a, _b;
    const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
    let raw = "";
    if (mv)
      raw = this.rawFromEditor(mv.editor);
    if (!raw)
      raw = (_b = (_a = activeWindow.getSelection()) == null ? void 0 : _a.toString()) != null ? _b : "";
    return this.extractWord(raw);
  }
  wordFromEditor(editor: Editor) {
    return this.extractWord(this.rawFromEditor(editor));
  }
  rawFromEditor(editor: Editor) {
    const sel = editor.getSelection();
    if (sel)
      return sel;
    const range = editor.wordAt(editor.getCursor());
    return range ? editor.getRange(range.from, range.to) : "";
  }
  extractWord(raw: string) {
    const ws = raw.toLowerCase().match(/[а-яё]+(?:-[а-яё]+)*/g);
    return ws && ws.length ? ws[ws.length - 1] : null;
  }
  /**
   * Редактор, куда вставлять слово из панели: активный, а если фокус забрала сама панель —
   * последняя заметка основной области. В режиме чтения вставлять некуда.
   */
  getEditor() {
    let _a;
    const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (mv)
      return mv.getMode() === "source" ? mv.editor : null;
    const view = (_a = this.app.workspace.getMostRecentLeaf()) == null ? void 0 : _a.view;
    if (view instanceof MarkdownView && view.getMode() === "source")
      return view.editor;
    return null;
  }
  getRhymesView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_RHYMES)[0];
    return leaf && leaf.view instanceof RhymesView ? leaf.view : null;
  }
  /** Включить/выключить слежение за курсором (кнопка в панели, команда, настройка). */
  async setFollow(on: boolean) {
    let _a, _b;
    this.settings.followCursor = on;
    await this.saveSettings();
    (_a = this.getRhymesView()) == null ? void 0 : _a.updateFollowBtn();
    new Notice(t(on ? "followOn" : "followOff"));
    if (!on)
      return;
    const leaf = await this.ensureViewInSidebar(true);
    if (leaf == null ? void 0 : leaf.isDeferred)
      await leaf.loadIfDeferred();
    if (this.dict.status === "idle" || this.dict.status === "loading")
      await this.dict.load();
    if (this.dict.status !== "ready") {
      new Notice(t("dictMissing"));
      return;
    }
    (_b = this.getRhymesView()) == null ? void 0 : _b.leaveGenerator();
    this.syncFromCursor(true);
  }
  /**
   * Показать в панели рифмы к последнему слову строки, где стоит курсор.
   * useRecent — брать последний редактор, даже если активна сама панель (сразу после её раскрытия).
   */
  syncFromCursor(useRecent = false) {
    if (!this.settings.followCursor)
      return;
    const view = this.getRhymesView();
    if (!view || !view.containerEl.isShown())
      return;
    let mv = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mv && useRecent) {
      const leaf = this.app.workspace.getMostRecentLeaf();
      if (leaf && leaf.view instanceof MarkdownView)
        mv = leaf.view;
    }
    if (!mv || mv.getMode() !== "source")
      return;
    const selection = mv.editor.getSelection();
    const cursor = mv.editor.getCursor();
    const source = selection || mv.editor.getLine(cursor.line);
    const key = selection ? "s\n" + selection : cursor.line + "\n" + source;
    if (!useRecent && key === this.lastFollowKey)
      return;
    this.lastFollowKey = key;
    const word = this.extractWord(source);
    if (word && word.length >= MIN_FOLLOW_LEN) {
      view.followWord(word).catch((e) => console.error("Russian Rhymes: follow failed", e));
    }
  }
  /**
   * Спрятать папку личных словарей в проводнике: она служебная, .gz из неё всё равно не
   * открыть, а в поиск, граф и быстрое переключение такие файлы и так не попадают.
   * Держать их в папке плагина нельзя — её не носит синхронизация.
   */
  applyDictDirStyle() {
    if (!this.dirCleanupRegistered) {
      this.dirCleanupRegistered = true;
      this.register(() => {
        if (this.dirObserver) {
          this.dirObserver.disconnect();
          this.dirObserver = null;
        }
        this.hiddenDirs = [];
        this.markHiddenDirs();
      });
    }
    // и личные словари, и основной: обе папки лежат в хранилище только ради синхронизации,
    // в дереве файлов им делать нечего
    const dirs = this.settings.hideDictDir ? [this.dict.localDir, this.dict.mainDir].filter((d, i, a) => d && a.indexOf(d) === i) : [];
    // сравниваем в нижнем регистре: на Windows папка на диске может называться иначе,
    // чем записано в настройке, и точное сравнение промахивалось
    this.hiddenDirs = dirs.map((d) => d.toLowerCase());
    this.markHiddenDirs();
    this.watchFileExplorer();
  }
  /** Поставить класс на строки проводника, отвечающие спрятанным папкам, и снять со всех прочих. */
  markHiddenDirs() {
    const titles = document.querySelectorAll(".nav-folder-title[data-path]");
    for (let i = 0; i < titles.length; i++) {
      const title = titles[i];
      const folder = title.parentElement;
      if (!folder || !folder.classList.contains("nav-folder"))
        continue;
      const path = title.getAttribute("data-path") || "";
      folder.classList.toggle("rr-hidden-dir", this.hiddenDirs.includes(path.toLowerCase()));
    }
  }
  /**
   * Проводник пересобирает строки папок при каждом раскрытии, а переименование меняет
   * data-path — класс приходится возвращать. Следим за контейнером проводника, а не за
   * body: набор текста в редакторе сыпал бы мутациями без остановки. Слушаем только
   * childList, поэтому класс (мутация атрибута) не вызывает обработчик повторно.
   */
  watchFileExplorer() {
    if (this.dirObserver || !this.hiddenDirs.length)
      return;
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    if (!leaf)
      return;
    this.dirObserver = new MutationObserver(() => this.markHiddenDirs());
    this.dirObserver.observe(leaf.view.containerEl, { childList: true, subtree: true });
  }
  /**
   * Привести путь папки к тому регистру, в каком она лежит в хранилище. Windows считает
   * «Словари Рифм» и «Словари рифм» одной папкой, а дерево файлов, синхронизация и
   * регистрозависимые системы — разными: там бы завелась вторая папка, а словари пропали.
   */
  async syncDictDirCase() {
    const dir = this.dict.localDir;
    if (!dir)
      return;
    const real = this.realDirPath(dir);
    if (real === dir)
      return;
    this.settings.localDictDir = real;
    this.dict.setLocalDir(real);
    await this.saveSettings();
  }
  realDirPath(dir: string) {
    const exact = this.app.vault.getAbstractFileByPath(dir);
    if (exact)
      return exact.path;
    const lower = dir.toLowerCase();
    // папку узнаём по children, а не instanceof TFolder: тестовый стенд подаёт сюда
    // обычные объекты, и проверка на класс его бы сломала. Приведение — к форме, а не
    // к самому TFolder: линтер каталога справедливо не любит приведения к TFile/TFolder
    const isFolder = (f: TAbstractFile): f is TFolder => Array.isArray((f as { children?: unknown }).children);
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (isFolder(f) && f.path.toLowerCase() === lower)
        return f.path;
    }
    return dir;
  }
  /** Перерисовать открытую панель (после подключения/очистки личного словаря). */
  refreshPanel() {
    let _a;
    (_a = this.getRhymesView()) == null ? void 0 : _a.refresh();
  }
  /** Вкладка панели всегда существует в правом сайдбаре (урок мобильной версии Songwriter). */
  async ensureViewInSidebar(reveal: boolean) {
    let _a;
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_RHYMES);
    let leaf = (_a = existing[0]) != null ? _a : null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf)
        return null;
      await leaf.setViewState({ type: VIEW_TYPE_RHYMES, active: false });
    }
    if (reveal)
      await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }
  async activateView(word: string | null) {
    const leaf = await this.ensureViewInSidebar(true);
    if (!leaf)
      return;
    if (leaf.isDeferred)
      await leaf.loadIfDeferred();
    if (!(leaf.view instanceof RhymesView))
      return;
    if (word)
      await leaf.view.showWord(word);
    else
      leaf.view.focusSearch();
  }
  /**
   * Скачать словарь с настроенного URL (для мобильного/новой установки, где папки
   * dict/ нет). onProgress — индикатор; возвращает true, если после загрузки словарь готов.
   */
  async downloadDict(onProgress?: (done: number, total: number, name: string) => void) {
    try {
      const report = await this.dict.downloadDict(this.settings.dictUrl, onProgress);
      await this.dict.reloadAfterDownload();
      // «готов» и «всё скачалось» — разные вещи: словарь запускается и с недостачей,
      // поэтому список недошедших файлов идёт наверх отдельно и называется поимённо
      return { ok: this.dict.status === "ready", failed: report.failed };
    } catch (e) {
      console.error("Russian Rhymes: dict download failed", e);
      return { ok: false, failed: [] };
    }
  }
};
const RhymesSettingTab = class extends PluginSettingTab {
  plugin: InstanceType<typeof RussianRhymesPlugin>;

  constructor(app: App, plugin: InstanceType<typeof RussianRhymesPlugin>) {
    super(app, plugin);
    this.plugin = plugin;
  }
  /**
   * Настройки объявлены декларативно (Obsidian 1.13+): приложение рисует их само и,
   * главное, находит поиском по настройкам. display() здесь больше нет — при непустом
   * getSettingDefinitions() Obsidian его и не вызывает, а с 1.13 он ещё и устаревший.
   *
   * Императивными (через render) остались только те строки, которым декларативной формы
   * не хватает: кнопка скачивания гасит себя на время работы, поля папок применяются
   * по потере фокуса, а списки личных словарей — это не настройки, а данные
   * пользователя со своим переименованием, тумблерами и перетаскиванием.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: t("settingDouble"),
        desc: t("settingDoubleDesc"),
        control: {
          type: "number",
          key: "doubleCopyMs",
          defaultValue: DEFAULT_SETTINGS.doubleCopyMs,
          placeholder: String(DEFAULT_SETTINGS.doubleCopyMs),
          min: 0,
          max: 2e3
        }
      },
      {
        name: t("settingFollow"),
        desc: t("settingFollowDesc"),
        control: { type: "toggle", key: "followCursor" }
      },
      {
        name: t("settingStartup"),
        desc: t("settingStartupDesc"),
        control: {
          type: "dropdown",
          key: "startupLoad",
          defaultValue: DEFAULT_SETTINGS.startupLoad,
          options: { none: t("startupNone"), rhymes: t("startupRhymes"), full: t("startupFull") }
        }
      },
      {
        type: "group",
        heading: t("dlHeading"),
        items: [
          {
            name: t("settingUrl"),
            desc: t("settingUrlDesc"),
            control: { type: "text", key: "dictUrl" }
          },
          { name: t("dlDict"), desc: t("dlDesc"), render: (setting) => this.renderDownload(setting) },
          { name: t("mainFolder"), desc: t("mainFolderDesc"), render: (setting) => this.renderFolder(setting, "main") },
          { name: t("invFiles"), desc: t("invDesc"), render: (setting, group) => this.renderInventory(setting, group) }
        ]
      },
      {
        type: "group",
        heading: t("locHeading"),
        items: [
          { name: t("locFolder"), desc: t("locFolderDesc"), render: (setting) => this.renderFolder(setting, "local") },
          {
            name: t("locHideDir"),
            desc: t("locHideDirDesc"),
            control: { type: "toggle", key: "hideDictDir" }
          }
        ]
      },
      this.dictSection("defs", t("locDefs"), t("locReorderHint")),
      this.dictSection("syns", t("locSyns"), t("locSynsHint"))
    ];
  }
  /** startupLoad валидируем: data.json правят руками. Остальное читается как есть. */
  getControlValue(key: string): unknown {
    if (key === "startupLoad")
      return this.plugin.startupMode();
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }
  /**
   * Базовая реализация только пишет значение в plugin.settings, а половине настроек
   * нужны побочные действия — они и собраны здесь.
   */
  async setControlValue(key: string, value: unknown) {
    // setFollow сам пишет настройку и сохраняет: поднимает панель, обновляет кнопку, грузит словарь
    if (key === "followCursor") {
      await this.plugin.setFollow(!!value);
      return;
    }
    let v = value;
    if (key === "doubleCopyMs") {
      const n = Number(v);
      v = Number.isFinite(n) && n >= 0 ? Math.min(n, 2e3) : DEFAULT_SETTINGS.doubleCopyMs;
    }
    // значение приходит как unknown: строку чистим, всё прочее (правленый вручную
    // data.json) откатываем к адресу по умолчанию, а не приводим к «[object Object]»
    if (key === "dictUrl")
      v = typeof v === "string" ? v.trim() : DEFAULT_SETTINGS.dictUrl;
    if (key === "startupLoad")
      v = typeof v === "string" && STARTUP_KEYS.includes(v) ? v : DEFAULT_SETTINGS.startupLoad;
    // настройки адресуются строковым ключом — так устроен декларативный API
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = v;
    await this.plugin.saveSettings();
    if (key === "hideDictDir")
      this.plugin.applyDictDirStyle();
    // добавить в память можно сразу, освободить — только перезапуском
    if (key === "startupLoad" && v === "full")
      void this.plugin.dict.loadHeavy();
  }
  /** Кнопка скачивания словаря: гасится на время работы, прогресс идёт в Notice. */
  renderDownload(setting: Setting) {
    setting.addButton((btn) => {
      btn.setButtonText(t("dlBtn")).setCta();
      btn.onClick(async () => {
        btn.setDisabled(true);
        const notice = new Notice(t("dlProgress"), 0);
        const res = await this.plugin.downloadDict((done, total) => notice.setMessage(`${t("dlProgress")} ${done}/${total}`));
        notice.hide();
        if (res.failed.length)
          new Notice(t("dlFailedFiles") + res.failed.join(", "), 1e4);
        else
          new Notice(res.ok ? t("dlDone") : t("dlFailed"));
        btn.setDisabled(false);
        this.plugin.refreshPanel();
        // список файлов после закачки врал бы, если бы остался прежним
        this.update();
      });
    });
  }
  /**
   * Поле папки словарей. Применяется по потере фокуса, а не на каждый символ: иначе
   * по дороге завелись бы папки «С», «Сл», «Сло»… Ровно поэтому тут не декларативный
   * text — тот пишет значение на каждое изменение.
   */
  renderFolder(setting: Setting, which: string) {
    const main = which === "main";
    setting.addText((text) => {
      text.setPlaceholder(main ? t("mainFolderHint") : DEFAULT_SETTINGS.localDictDir);
      text.setValue(main ? this.plugin.settings.mainDictDir : this.plugin.settings.localDictDir);
      text.inputEl.addEventListener("blur", () => {
        if (main)
          void this.changeMainFolder(text.getValue());
        else
          void this.changeDictFolder(text.getValue());
      });
    });
  }
  /**
   * Сменить папку основного словаря и перетащить туда файлы. Это десятки мегабайт,
   * поэтому с индикатором; по дороге читать словарь нельзя — сбрасываем его после.
   */
  async changeMainFolder(value: string) {
    const dict = this.plugin.dict;
    const old = dict.activeDictDir;
    dict.setMainDir(value);
    this.plugin.settings.mainDictDir = dict.mainDir;
    await this.plugin.saveSettings();
    if (dict.targetDictDir() === old) {
      this.plugin.applyDictDirStyle();
      return;
    }
    const notice = new Notice(t("mainMoving"), 0);
    let moved = 0;
    try {
      moved = await dict.relocateDict(old, (done, total, name) => notice.setMessage(`${t("mainMoving")} ${done}/${total} \xB7 ${name}`));
    } catch (e) {
      console.error("Russian Rhymes: не удалось перенести словарь", e);
    }
    notice.hide();
    new Notice(moved > 0 ? `${t("mainMoved")} ${moved}` : t("mainNothingMoved"));
    this.plugin.applyDictDirStyle();
    await dict.reloadAfterDownload();
    this.plugin.refreshPanel();
  }
  /** Сменить папку личных словарей и перетащить в неё уже импортированные файлы. */
  async changeDictFolder(value: string) {
    const dict = this.plugin.dict;
    const old = dict.localDir;
    dict.setLocalDir(value);
    if (dict.localDir === old)
      return;
    this.plugin.settings.localDictDir = dict.localDir;
    await this.plugin.saveSettings();
    try {
      const moved = await dict.relocateLocalDicts(old);
      await this.plugin.syncDictDirCase();
      this.plugin.applyDictDirStyle();
      new Notice(t("locMoved") + moved);
    } catch (e) {
      console.error("Russian Rhymes: moving personal dictionaries failed", e);
      new Notice(t("locMoveFail"));
    }
    this.update();
  }
  /**
   * Секция личных словарей одного вида: толковые идут в «Значение», синонимические —
   * в «Синонимы». Это данные пользователя, а не настройки, поэтому декларативной формы
   * тут нет: у строк своё переименование, тумблер, удаление и перетаскивание.
   */
  dictSection(kind: DictKind, title: string, hint: string): SettingDefinitionItem {
    const dicts = this.plugin.localDicts.filter((d) => (d.kind === "syns" ? "syns" : "defs") === kind);
    return {
      type: "group",
      items: [
        {
          name: title,
          desc: dicts.length ? hint : t("locEmpty"),
          render: (setting, group) => this.renderDictSection(setting, group, kind, dicts)
        }
      ]
    };
  }
  /**
   * Инвентарь словаря: что из двадцати файлов лежит на диске. Единственное место, где
   * видно оборванную закачку — до этого недостающий шард просто оборачивался пустой
   * вкладкой. Читается с диска, поэтому список заполняется после ответа, а не сразу.
   */
  renderInventory(setting: Setting, group: SettingGroup) {
    const host = group && group.listEl ? group.listEl : setting.settingEl.parentElement;
    if (!host)
      return;
    const listEl = host.createDiv({ cls: "rr-shards" });
    listEl.createDiv({ cls: "rr-shard-note", text: t("invLoading") });
    const fill = () => {
      void this.plugin.dict.inventory().then((inv) => {
        listEl.empty();
        this.fillInventory(listEl, inv);
      });
    };
    setting.addExtraButton((btn) => {
      btn.setIcon("refresh-cw").setTooltip(t("invRefresh"));
      btn.onClick(() => fill());
    });
    fill();
    // строку могут перерисовать в одиночку, а список висит рядом с ней, не внутри
    return () => listEl.remove();
  }
  fillInventory(listEl: HTMLElement, inv: ShardInfo[]) {
    let have = 0, bytes = 0;
    for (const s of inv) {
      const row = listEl.createDiv({ cls: "rr-shardrow" });
      row.createSpan({ cls: "rr-shard-name", text: shardTitle(s.name) });
      if (s.present && !s.broken) {
        have++;
        bytes += s.size;
        row.createSpan({ cls: "rr-shard-size", text: fmtSize(s.size) });
      } else {
        row.addClass("rr-shard-bad");
        // «повреждён» и «нет файла» — разные беды: первый чинится перекачиванием этого
        // файла, второй мог и не скачаться вовсе
        row.createSpan({ cls: "rr-shard-size", text: s.broken ? t("invBroken") : t("invMissing") });
      }
    }
    const total = listEl.createDiv({ cls: "rr-shard-note" });
    total.setText(`${t("invTotal")} ${have}/${inv.length} · ${fmtSize(bytes)}`);
    if (have < inv.length)
      listEl.createDiv({ cls: "rr-shard-note rr-shard-bad", text: t("invHint") });
  }
  renderDictSection(setting: Setting, group: SettingGroup, kind: DictKind, dicts: LocalDict[]) {
    const label = setting.controlEl.createEl("label", { cls: "rr-add-btn", text: t("btnAddDsl") });
    const fileInput = label.createEl("input", {
      cls: "rr-file-hidden",
      attr: { type: "file", accept: ".dsl,.dz", multiple: "true" }
    });
    fileInput.addEventListener("change", () => {
      const files = fileInput.files ? Array.from(fileInput.files) : [];
      fileInput.value = "";
      if (files.length)
        void this.importFiles(files, kind);
    });
    if (!dicts.length)
      return;
    // список ложится в контейнер группы, под строку с заголовком и кнопкой ввоза
    const host = group && group.listEl ? group.listEl : setting.settingEl.parentElement;
    if (!host)
      return;
    const listEl = host.createDiv({ cls: "rr-dictlist" });
    this.fillDictList(listEl, dicts);
    // строку могут перерисовать в одиночку, а список висит рядом с ней, не внутри:
    // без уборки он остался бы и продублировался
    return () => listEl.remove();
  }
  /** Список личных словарей: строки с ручкой перетаскивания, именем, счётчиком и удалением. */
  fillDictList(listEl: HTMLElement, dicts: LocalDict[]) {
    let dragId: string | null = null;
    for (const d of dicts) {
      const row = listEl.createDiv({ cls: "rr-dictrow" });
      row.dataset.id = d.id;
      if (!d.enabled)
        row.addClass("is-off");
      const grip = row.createSpan({ cls: "rr-dictgrip", attr: { "aria-label": t("locReorderHint") } });
      setIcon(grip, "grip-vertical");
      grip.addEventListener("mousedown", () => row.setAttr("draggable", "true"));
      const nameInput = row.createEl("input", { cls: "rr-dictname", attr: { type: "text", spellcheck: "false" } });
      nameInput.value = d.name;
      nameInput.addEventListener("mousedown", () => row.setAttr("draggable", "false"));
      nameInput.addEventListener("change", () => {
        d.name = nameInput.value.trim() || d.name;
        nameInput.value = d.name;
        this.plugin.dict.renameDict(d.id, d.name);
        this.plugin.syncLocalManifest();
        void this.plugin.saveSettings();
        this.plugin.refreshPanel();
      });
      const wordsEl = row.createSpan({ cls: "rr-dictwords", text: `${d.words}${t("locWords")}` });
      // список словарей приезжает синхронизацией, а файлы — нет; честно говорим, чего тут нет.
      // файл может и лежать, но не распаковываться — тогда число слов из настроек соврало бы
      if (this.plugin.dict.isLocalBroken(d.id)) {
        row.addClass("is-missing");
        wordsEl.setText(t("locBadFile"));
        wordsEl.title = t("locBadFileHint");
      } else {
        void this.plugin.dict.localFileExists(d.id).then((ok) => {
          if (ok)
            return;
          row.addClass("is-missing");
          wordsEl.setText(t("locNoFile"));
          wordsEl.title = t("locNoFileHint");
        });
      }
      const toggle = new ToggleComponent(row);
      toggle.toggleEl.addClass("rr-dicttoggle");
      toggle.setTooltip(t("locToggleHint"));
      toggle.setValue(d.enabled).onChange((v) => {
        d.enabled = v;
        row.toggleClass("is-off", !v);
        this.plugin.dict.setEnabled(d.id, v);
        void this.plugin.saveSettings();
        this.plugin.refreshPanel();
      });
      const del = row.createSpan({ cls: "rr-dictdel", attr: { "aria-label": t("btnClear") } });
      setIcon(del, "trash");
      del.addEventListener("click", () => void this.removeDict(d.id));
      row.addEventListener("dragstart", (e: DragEvent) => {
        let _a;
        dragId = d.id;
        row.addClass("is-dragging");
        (_a = e.dataTransfer) == null ? void 0 : _a.setData("text/plain", d.id);
        if (e.dataTransfer)
          e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        row.removeClass("is-dragging");
        row.setAttr("draggable", "false");
      });
      row.addEventListener("dragover", (e: DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer)
          e.dataTransfer.dropEffect = "move";
        row.addClass("is-drop");
      });
      row.addEventListener("dragleave", () => row.removeClass("is-drop"));
      row.addEventListener("drop", (e: DragEvent) => {
        let _a;
        e.preventDefault();
        row.removeClass("is-drop");
        // из соседнего списка тянут мимо dragId (у каждого списка он свой) — берём id из события
        const from = dragId || ((_a = e.dataTransfer) == null ? void 0 : _a.getData("text/plain")) || "";
        if (from && from !== d.id)
          void this.moveDict(from, d.id);
        dragId = null;
      });
    }
  }
  /** Удалить личный словарь: файл с диска, строку из списка и из манифеста. */
  async removeDict(id: string) {
    await this.plugin.dict.deleteDict(id);
    this.plugin.localDicts = this.plugin.localDicts.filter((x) => x.id !== id);
    this.plugin.syncLocalManifest();
    await this.plugin.saveSettings();
    this.plugin.refreshPanel();
    this.update();
  }
  /** Переставить словарь fromId на место targetId и сохранить порядок. */
  async moveDict(fromId: string, targetId: string) {
    const from = this.plugin.localDicts.find((d) => d.id === fromId);
    const to = this.plugin.localDicts.find((d) => d.id === targetId);
    if (!from || !to)
      return;
    // файлы толковых и синонимических словарей устроены по-разному, одним флагом вид не сменить
    if ((from.kind === "syns") !== (to.kind === "syns")) {
      new Notice(t("locKindHint"));
      return;
    }
    const ids = this.plugin.localDicts.map((d) => d.id);
    const fi = ids.indexOf(fromId);
    const ti0 = ids.indexOf(targetId);
    if (fi < 0 || ti0 < 0)
      return;
    ids.splice(fi, 1);
    const ti = ids.indexOf(targetId);
    // тянем вниз — встаём ПОСЛЕ строки, на которую бросили; иначе обмен соседей ничего не делал
    ids.splice(fi < ti0 ? ti + 1 : ti, 0, fromId);
    const byId = new Map(this.plugin.localDicts.map((d) => [d.id, d]));
    this.plugin.localDicts = ids.map((id) => byId.get(id)).filter((d) => !!d);
    this.plugin.syncLocalManifest();
    await this.plugin.saveSettings();
    this.plugin.refreshPanel();
    this.update();
  }
  async importFiles(files: File[], kind: DictKind) {
    new Notice(t("noticeConverting"));
    await new Promise((r) => window.setTimeout(r, 30));
    let ok = 0;
    for (const file of files) {
      try {
        const conv = convertDsl(await file.arrayBuffer(), kind === "syns" ? "synonyms" : "definitions");
        if (conv.entries.size === 0)
          continue;
        const id = "ld" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
        const base = file.name.replace(/\.(dsl\.dz|dsl|dz)$/i, "");
        const name = conv.name && conv.name !== "DSL" ? conv.name : base;
        const words = await this.plugin.dict.importDict(id, name, conv.entries, kind);
        this.plugin.localDicts.push({ id, name, words, enabled: true, kind: kind === "syns" ? "syns" : "defs" });
        this.plugin.syncLocalManifest();
        await this.plugin.saveSettings();
        ok++;
      } catch (e) {
        console.error("Russian Rhymes: DSL import failed", file.name, e);
      }
    }
    if (ok === 0) {
      new Notice(t("noticeBadDsl"));
      return;
    }
    await this.plugin.saveSettings();
    this.plugin.refreshPanel();
    this.update();
  }
};
export default RussianRhymesPlugin;
