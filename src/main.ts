import { MarkdownView, Notice, Plugin, PluginSettingTab, Setting, ToggleComponent, debounce, setIcon } from "obsidian";
import { RhymeDict } from "./dict";
import { t } from "./i18n";
import { RhymesView, STARTUP_KEYS, VIEW_TYPE_RHYMES } from "./view";
import { convertDsl } from "./dsl";

var DEFAULT_SETTINGS = {
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
var FOLLOW_DELAY_MS = 500;
var MIN_FOLLOW_LEN = 3;
var RussianRhymesPlugin = class extends Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.userStress = {};
    this.localDicts = [];
    this.lastCopyAt = 0;
    // после двойного Ctrl+C, пока Ctrl не отпущен, стрелки ←/→ листают разделы панели
    this.navArmed = false;
    // режим «следовать за курсором»: реагируем на паузу в наборе, а не на каждый символ
    this.followSync = debounce(() => this.syncFromCursor(), FOLLOW_DELAY_MS, true);
    // что панель уже показала по редактору; пока это не изменилось, слежение молчит и не
    // перебивает слово, выбранное вручную (двойной клик по чипу, двойной Ctrl+C, поле поиска)
    this.lastFollowKey = "";
    // о каких сломанных личных словарях уже сказали (чтобы не повторяться на каждой загрузке)
    this.badWarned = "";
  }
  async onload() {
    var _a;
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
    var _a;
    const data = await this.loadData();
    if (data && data.settings) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
      this.userStress = (_a = data.userStress) != null ? _a : {};
      this.localDicts = Array.isArray(data.localDicts) ? data.localDicts.map((d) => ({ ...d, enabled: d.enabled !== false, kind: d.kind === "syns" ? "syns" : "defs" })) : [];
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
  async saveSettings() {
    const data = { settings: this.settings, userStress: this.userStress, localDicts: this.localDicts };
    await this.saveData(data);
  }
  /** Запомненное пользователем ударение слова. */
  getUserStress(word) {
    return this.userStress[word];
  }
  setUserStress(word, s) {
    if (s === null)
      delete this.userStress[word];
    else
      this.userStress[word] = s;
    void this.saveSettings();
  }
  /** Слово из выделения/под курсором активного редактора, иначе из window-выделения. */
  grabWord() {
    var _a, _b;
    const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
    let raw = "";
    if (mv)
      raw = this.rawFromEditor(mv.editor);
    if (!raw)
      raw = (_b = (_a = activeWindow.getSelection()) == null ? void 0 : _a.toString()) != null ? _b : "";
    return this.extractWord(raw);
  }
  wordFromEditor(editor) {
    return this.extractWord(this.rawFromEditor(editor));
  }
  rawFromEditor(editor) {
    const sel = editor.getSelection();
    if (sel)
      return sel;
    const range = editor.wordAt(editor.getCursor());
    return range ? editor.getRange(range.from, range.to) : "";
  }
  extractWord(raw) {
    const ws = raw.toLowerCase().match(/[а-яё]+(?:-[а-яё]+)*/g);
    return ws && ws.length ? ws[ws.length - 1] : null;
  }
  /**
   * Редактор, куда вставлять слово из панели: активный, а если фокус забрала сама панель —
   * последняя заметка основной области. В режиме чтения вставлять некуда.
   */
  getEditor() {
    var _a;
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
  async setFollow(on) {
    var _a, _b;
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
    if (!this.dirStyleEl) {
      this.dirStyleEl = document.head.createEl("style");
      this.register(() => {
        var _a;
        (_a = this.dirStyleEl) == null ? void 0 : _a.remove();
        this.dirStyleEl = null;
      });
    }
    // регистр сверяем без учёта регистра (флаг i): на Windows папка на диске может
    // называться иначе, чем записано в настройке, и точное сравнение промахивалось
    const rule = (d) => `.nav-folder:has(> .nav-folder-title[data-path="${d.replace(/["\\]/g, "\\$&")}" i]) { display: none; }`;
    // и личные словари, и основной: обе папки лежат в хранилище только ради синхронизации,
    // в дереве файлов им делать нечего
    const dirs = this.settings.hideDictDir ? [this.dict.localDir, this.dict.mainDir].filter((d, i, a) => d && a.indexOf(d) === i) : [];
    this.dirStyleEl.textContent = dirs.map(rule).join("\n");
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
  realDirPath(dir) {
    const exact = this.app.vault.getAbstractFileByPath(dir);
    if (exact)
      return exact.path;
    const lower = dir.toLowerCase();
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (f.children && f.path.toLowerCase() === lower)
        return f.path;
    }
    return dir;
  }
  /** Перерисовать открытую панель (после подключения/очистки личного словаря). */
  refreshPanel() {
    var _a;
    (_a = this.getRhymesView()) == null ? void 0 : _a.refresh();
  }
  /** Вкладка панели всегда существует в правом сайдбаре (урок мобильной версии Songwriter). */
  async ensureViewInSidebar(reveal) {
    var _a;
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
  async activateView(word) {
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
  async downloadDict(onProgress) {
    try {
      await this.dict.downloadDict(this.settings.dictUrl, onProgress);
      await this.dict.reloadAfterDownload();
      return this.dict.status === "ready";
    } catch (e) {
      console.error("Russian Rhymes: dict download failed", e);
      return false;
    }
  }
};
var RhymesSettingTab = class extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName(t("settingDouble")).setDesc(t("settingDoubleDesc")).addText((text) => {
      text.inputEl.type = "number";
      text.setPlaceholder(String(DEFAULT_SETTINGS.doubleCopyMs)).setValue(String(this.plugin.settings.doubleCopyMs)).onChange(async (v) => {
        const n = parseInt(v, 10);
        this.plugin.settings.doubleCopyMs = Number.isFinite(n) && n >= 0 ? Math.min(n, 2e3) : DEFAULT_SETTINGS.doubleCopyMs;
        await this.plugin.saveSettings();
      });
    });
    new Setting(containerEl).setName(t("settingFollow")).setDesc(t("settingFollowDesc")).addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.followCursor).onChange(async (v) => {
        await this.plugin.setFollow(v);
      })
    );
    new Setting(containerEl).setName(t("settingStartup")).setDesc(t("settingStartupDesc")).addDropdown((dd) => {
      dd.addOption("none", t("startupNone"));
      dd.addOption("rhymes", t("startupRhymes"));
      dd.addOption("full", t("startupFull"));
      dd.setValue(this.plugin.startupMode()).onChange(async (v) => {
        this.plugin.settings.startupLoad = STARTUP_KEYS.includes(v) ? v : DEFAULT_SETTINGS.startupLoad;
        await this.plugin.saveSettings();
        // добавить в память можно сразу, освободить — только перезапуском
        if (this.plugin.settings.startupLoad === "full")
          void this.plugin.dict.loadHeavy();
      });
    });
    new Setting(containerEl).setName(t("dlHeading")).setHeading();
    new Setting(containerEl).setName(t("settingUrl")).setDesc(t("settingUrlDesc")).addText(
      (text) => text.setValue(this.plugin.settings.dictUrl).onChange(async (v) => {
        this.plugin.settings.dictUrl = v.trim();
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName(t("dlDict")).setDesc(t("dlDesc")).addButton((btn) => {
      btn.setButtonText(t("dlBtn")).setCta();
      btn.onClick(async () => {
        btn.setDisabled(true);
        const notice = new Notice(t("dlProgress"), 0);
        const ok = await this.plugin.downloadDict((done, total) => notice.setMessage(`${t("dlProgress")} ${done}/${total}`));
        notice.hide();
        new Notice(ok ? t("dlDone") : t("dlFailed"));
        btn.setDisabled(false);
        this.plugin.refreshPanel();
      });
    });
    new Setting(containerEl).setName(t("mainFolder")).setDesc(t("mainFolderDesc")).addText((text) => {
      text.setPlaceholder(t("mainFolderHint")).setValue(this.plugin.settings.mainDictDir);
      // переезд по потере фокуса: на каждый символ он заводил бы папки «С», «Сл», «Сло»…
      text.inputEl.addEventListener("blur", () => void this.changeMainFolder(text.getValue()));
    });
    new Setting(containerEl).setName(t("locHeading")).setHeading();
    new Setting(containerEl).setName(t("locFolder")).setDesc(t("locFolderDesc")).addText((text) => {
      text.setPlaceholder(DEFAULT_SETTINGS.localDictDir).setValue(this.plugin.settings.localDictDir);
      // переносим по потере фокуса, а не на каждый символ: иначе папка заводилась бы на «С», «Сл», «Сло»…
      text.inputEl.addEventListener("blur", () => void this.changeDictFolder(text.getValue()));
    });
    new Setting(containerEl).setName(t("locHideDir")).setDesc(t("locHideDirDesc")).addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.hideDictDir).onChange(async (v) => {
        this.plugin.settings.hideDictDir = v;
        await this.plugin.saveSettings();
        this.plugin.applyDictDirStyle();
      })
    );
    this.renderDefsSection(containerEl);
  }
  /**
   * Сменить папку основного словаря и перетащить туда файлы. Это десятки мегабайт,
   * поэтому с индикатором; по дороге читать словарь нельзя — сбрасываем его после.
   */
  async changeMainFolder(value) {
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
  async changeDictFolder(value) {
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
    this.display();
  }
  renderDefsSection(containerEl) {
    this.renderDictSection(containerEl, "defs", t("locDefs"), t("locReorderHint"));
    this.renderDictSection(containerEl, "syns", t("locSyns"), t("locSynsHint"));
  }
  /** Список словарей одного вида: толковые идут в «Значение», синонимические — в «Синонимы». */
  renderDictSection(containerEl, kind, title, hint) {
    const dicts = this.plugin.localDicts.filter((d) => (d.kind === "syns" ? "syns" : "defs") === kind);
    const setting = new Setting(containerEl).setName(title).setDesc(dicts.length ? hint : t("locEmpty"));
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
    const listEl = containerEl.createDiv({ cls: "rr-dictlist" });
    this.fillDictList(listEl, dicts);
  }
  /** Список личных словарей: строки с ручкой перетаскивания, именем, счётчиком и удалением. */
  fillDictList(listEl, dicts) {
    let dragId = null;
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
      del.addEventListener("click", async () => {
        await this.plugin.dict.deleteDict(d.id);
        this.plugin.localDicts = this.plugin.localDicts.filter((x) => x.id !== d.id);
        this.plugin.syncLocalManifest();
        await this.plugin.saveSettings();
        this.plugin.refreshPanel();
        this.display();
      });
      row.addEventListener("dragstart", (e) => {
        var _a;
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
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (e.dataTransfer)
          e.dataTransfer.dropEffect = "move";
        row.addClass("is-drop");
      });
      row.addEventListener("dragleave", () => row.removeClass("is-drop"));
      row.addEventListener("drop", (e) => {
        var _a;
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
  /** Переставить словарь fromId на место targetId и сохранить порядок. */
  async moveDict(fromId, targetId) {
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
    this.display();
  }
  async importFiles(files, kind) {
    new Notice(t("noticeConverting"));
    await new Promise((r) => setTimeout(r, 30));
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
    this.display();
  }
};
export default RussianRhymesPlugin;
