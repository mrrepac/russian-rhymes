import { ItemView, Menu, Notice, Platform, setIcon } from "obsidian";
import { VOWELS, countSyllables, looksSameRoot, markStress } from "./phonetics";
import { t } from "./i18n";

const VIEW_TYPE_RHYMES = "russian-rhymes-view";
const stripStress = (s) => s.replace(/́/g, "");
const POS_LABEL = () => ({
  n: t("posN"),
  v: t("posV"),
  a: t("posA"),
  d: t("posD"),
  i: t("posI"),
  x: ""
});
const lexCat = (f) => f >= 5 ? 0 : f >= 3 ? 1 : f >= 1 ? 2 : 3;
const PAGE = 50;
const PAGE_MORE = 200;
// допустимые значения запоминаемых фильтров — data.json правят и руками
const POS_KEYS = ["", "n", "v", "a", "d", "i"];
const KIND_KEYS = ["all", "exact", "near", "conson", "asson", "allit"];
// что грузить при старте: ничего / первую волну / обе. Толкования и формы — 360 МБ
// из ~500 МБ всего словаря, поэтому выбор заметно меняет цену запуска
const STARTUP_KEYS = ["none", "rhymes", "full"];
// вставка слова в заметку: Alt+клик на десктопе, долгое нажатие на телефоне
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;
const insertHint = () => t(Platform.isMobile ? "insertHintTouch" : "insertHint");
const displayCmp = (a, b) => lexCat(a.f) - lexCat(b.f) || a.word.localeCompare(b.word, "ru");
const RhymesView = class extends ItemView {
  // отложенные таймеры клика (копия) и долгого нажатия (вставка) — гасим при закрытии/перерисовке
  constructor(leaf, plugin) {
    super(leaf);
    this.word = "";
    this.variants = [];
    this.stress = null;
    // индекс ударной гласной (словарный или ручной)
    this.all = [];
    this.tab = "rhymes";
    // выбранный вид созвучия и он же «эффективный»: pref держится при смене слова,
    // soundKind падает в «все» на словах, где такого вида нет
    this.soundKindPref = "all";
    this.soundKind = "all";
    this.synonyms = null;
    // личные словари синонимов: [{id, name, lemma, groups}] — свои блоки во вкладке «Синонимы»
    this.localSyns = [];
    this.antonyms = null;
    this.hypernyms = null;
    this.hyponyms = null;
    this.related = null;
    this.associations = null;
    this.metagrams = null;
    this.anagrams = null;
    this.definitions = null;
    this.forms = null;
    this.phrases = null;
    this.idioms = null;
    this.proverbs = null;
    this.sylFilter = 0;
    // 0 = все, 4 = 4+
    this.posFilter = "";
    // '' = все
    // рифмы, близкие по смыслу: множество семантически связанных слов текущего слова
    this.relatedWords = /* @__PURE__ */ new Set();
    this.semanticOnly = false;
    this.consAll = [];
    // кэши на текущее слово+ударение
    this.assonAll = [];
    this.allitAll = [];
    // аллитерации (по началу слова, ударение не нужно)
    // вид «все»: раскрытость секций (запоминается на сессию) и постраничность каждой
    this.sectionOpen = {};
    this.sectionShown = {};
    // раскрытость подразделов «Ассоциаций» по ключу секции (на сессию)
    this.semOpen = {};
    // история слов для кнопки «назад» (провал в рифму двойным кликом создаёт цепочку)
    this.navStack = [];
    this.navPos = -1;
    this.navigating = false;
    // true во время перехода назад — чтобы не писать в историю
    // генератор-пасхалка «фристайл»; категории и слои — множественный выбор (мин. один активен)
    this.genCats = /* @__PURE__ */ new Set(["n"]);
    this.genTiers = /* @__PURE__ */ new Set([0]);
    // 0 базовая, 1 частотная; по умолчанию базовая
    this.genCount = 1;
    this.genWords = [];
    this.genHost = null;
    // «мешок без повторов»: перемешанный пул, курсор и ключ выбранных категорий+слоёв
    this.genBag = [];
    this.genBagPos = 0;
    this.genBagKey = "";
    this.resultsHost = null;
    // фильтры+список звукового раздела — перерисовываем только его
    this.copyTimers = /* @__PURE__ */ new Set();
    this.plugin = plugin;
    this.loadFilters();
    this.shown = PAGE;
  }
  getViewType() {
    return VIEW_TYPE_RHYMES;
  }
  getDisplayText() {
    return t("panelTitle");
  }
  getIcon() {
    return "feather";
  }
  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("rr-panel");
    const head = root.createDiv({ cls: "rr-head" });
    const search = head.createDiv({ cls: "rr-search" });
    setIcon(search.createSpan({ cls: "rr-search-icon" }), "search");
    this.inputEl = search.createEl("input", {
      cls: "rr-input",
      attr: { type: "text", placeholder: t("searchPlaceholder"), enterkeyhint: "search", spellcheck: "false" }
    });
    this.registerDomEvent(this.inputEl, "keydown", (e) => {
      if (e.key === "Enter") {
        void this.showWord(this.inputEl.value);
        if (Platform.isMobile)
          this.inputEl.blur();
      }
    });
    this.registerDomEvent(this.inputEl, "input", () => this.updateClear());
    this.clearBtn = search.createSpan({ cls: "rr-clear" });
    setIcon(this.clearBtn, "x");
    this.clearBtn.setAttr("aria-label", t("clearSearch"));
    this.registerDomEvent(this.clearBtn, "click", () => this.clearSearch());
    this.followBtn = head.createDiv({ cls: "rr-follow" });
    setIcon(this.followBtn, "crosshair");
    this.followBtn.setAttr("aria-label", t("followHint"));
    this.registerDomEvent(this.followBtn, "click", () => void this.plugin.setFollow(!this.plugin.settings.followCursor));
    this.updateFollowBtn();
    this.registerDomEvent(document, "keydown", (e) => {
      if (e.code !== "Space" || this.tab !== "gen")
        return;
      const ae = activeDocument.activeElement;
      if (!ae || !this.containerEl.contains(ae))
        return;
      if (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)
        return;
      e.preventDefault();
      this.rollGen();
    });
    this.bodyEl = root.createDiv({ cls: "rr-body" });
    const ro = new ResizeObserver(() => this.fitTabs());
    ro.observe(this.bodyEl);
    this.register(() => ro.disconnect());
    if (Platform.isMobile)
      this.registerSwipe();
    this.updateClear();
    this.renderBody();
  }
  /** Показать/скрыть × очистки по наличию текста в поле. */
  updateClear() {
    let _a;
    (_a = this.clearBtn) == null ? void 0 : _a.toggleClass("is-shown", this.inputEl.value.length > 0);
  }
  /** Очистить поиск: пустое слово, сброс истории, фокус в поле. */
  clearSearch() {
    this.inputEl.value = "";
    this.word = "";
    this.navStack = [];
    this.navPos = -1;
    this.clearFilters();
    this.updateClear();
    this.renderBody();
    this.inputEl.focus();
  }
  /** Фокус в поле поиска (при открытии панели пустой — чтобы сразу печатать). */
  focusSearch() {
    let _a, _b;
    (_a = this.inputEl) == null ? void 0 : _a.focus();
    (_b = this.inputEl) == null ? void 0 : _b.select();
  }
  /** Свайп влево/вправо по телу панели — соседний раздел (только мобильный). */
  registerSwipe() {
    let sx = 0, sy = 0, st = 0;
    this.registerDomEvent(this.bodyEl, "touchstart", (e) => {
      const tp = e.touches[0];
      sx = tp.clientX;
      sy = tp.clientY;
      st = Date.now();
    });
    this.registerDomEvent(this.bodyEl, "touchend", (e) => {
      const tp = e.changedTouches[0];
      const dx = tp.clientX - sx, dy = tp.clientY - sy;
      if (Date.now() - st < 500 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) {
        this.cycleTab(dx < 0 ? 1 : -1);
      }
    });
  }
  /** Точка входа: показать слово (из двойного Ctrl+C, меню, команды, инпута или двойного клика по чипу). */
  async showWord(raw) {
    let _a, _b;
    const ms = raw.toLowerCase().match(/[а-яё]+(?:-[а-яё]+)*/g);
    if (!ms || ms.length === 0)
      return;
    this.word = ms[ms.length - 1];
    this.inputEl.value = this.word;
    this.updateClear();
    if (!this.navigating && this.navStack[this.navPos] !== this.word) {
      this.navStack = this.navStack.slice(0, this.navPos + 1);
      this.navStack.push(this.word);
      this.navPos = this.navStack.length - 1;
    }
    if (this.word === "\u0444\u0440\u0438\u0441\u0442\u0430\u0439\u043B" && !this.plugin.settings.genUnlocked) {
      this.plugin.settings.genUnlocked = true;
      void this.plugin.saveSettings();
    }
    this.soundKind = this.soundKindPref;
    this.shown = PAGE;
    const dict = this.plugin.dict;
    if (dict.status !== "ready") {
      this.renderStatus(t("dictLoading"));
      await dict.load();
      // сюда попадаем, если слово запросили раньше, чем догрузилась первая волна;
      // про сломанные личные словари узнаём тут же
      this.plugin.warnBadDicts();
    }
    if (dict.status === "missing" || dict.status === "error") {
      this.renderMissing();
      return;
    }
    const yo = dict.normalizeYo(this.word);
    if (yo !== this.word) {
      if (this.navStack[this.navPos] === this.word)
        this.navStack[this.navPos] = yo;
      this.word = yo;
      this.inputEl.value = yo;
    }
    const variants = dict.lookup(this.word);
    this.variants = variants != null ? variants : [];
    const user = this.plugin.getUserStress(this.word);
    const valid = user !== void 0 && user < this.word.length && VOWELS.includes(this.word[user]);
    this.stress = valid ? user : (_b = (_a = this.variants[0]) == null ? void 0 : _a.s) != null ? _b : null;
    if (this.stress === null && countSyllables(this.word) === 1) {
      for (let i = 0; i < this.word.length; i++) {
        if (VOWELS.includes(this.word[i])) {
          this.stress = i;
          break;
        }
      }
    }
    this.synonyms = dict.synonymsFor(this.word);
    this.localSyns = dict.localSynDicts(this.word);
    this.antonyms = dict.antonymsFor(this.word);
    this.hypernyms = dict.hypernymsFor(this.word);
    this.hyponyms = dict.hyponymsFor(this.word);
    this.related = dict.relatedFor(this.word);
    this.associations = dict.associationsFor(this.word);
    this.metagrams = dict.metagramsFor(this.word);
    this.anagrams = dict.anagramsFor(this.word);
    this.definitions = await dict.definitionsFor(this.word);
    this.forms = await dict.formsFor(this.word);
    this.phrases = dict.phrasesFor(this.word);
    this.idioms = dict.idiomsFor(this.word);
    this.proverbs = dict.proverbsFor(this.word);
    this.buildRelatedSet();
    this.loadRhymes();
    this.ensureValidTab();
    if (this.word === "\u0444\u0440\u0438\u0441\u0442\u0430\u0439\u043B") {
      this.tab = "gen";
      this.genWords = [];
    } else if (this.tab === "gen") {
      const content = this.availableTabs().filter((x) => x !== "gen");
      if (content.length > 0)
        this.tab = content[0];
    }
    this.renderBody();
  }
  loadRhymes() {
    this.sectionShown = {};
    this.allitAll = this.plugin.dict.alliterationsFor(this.word);
    if (this.stress === null) {
      this.all = [];
      this.consAll = [];
      this.assonAll = [];
      return;
    }
    this.all = this.plugin.dict.rhymesFor(this.word, this.stress);
    const scan = this.plugin.dict.assonancesFor(this.word, this.stress);
    this.consAll = scan.conson;
    this.assonAll = scan.asson;
  }
  /** Текущая вкладка опустела на новом слове/ударении — уйти на первую непустую. */
  ensureValidTab() {
    let _a;
    const tabs = this.availableTabs();
    if (!tabs.includes(this.tab))
      this.tab = (_a = tabs[0]) != null ? _a : "rhymes";
  }
  /** Виды созвучий, у которых есть данные, — для пилюль-переключателей внутри «Рифм». */
  availableKinds() {
    const kinds = [];
    if (this.all.some((e) => e.exact))
      kinds.push(["exact", t("kindExact"), t("rhymesHint")]);
    if (this.all.some((e) => !e.exact))
      kinds.push(["near", t("tabNear"), t("nearHint")]);
    if (this.consAll.length > 0)
      kinds.push(["conson", t("tabConson"), t("consonHint")]);
    if (this.assonAll.length > 0)
      kinds.push(["asson", t("tabAsson"), t("assonHint")]);
    return kinds;
  }
  /** Список для текущего вида: конкретный вид или «все» — объединение без повторов, сильные сверху. */
  soundList() {
    switch (this.soundKind) {
      case "exact":
        return this.all.filter((e) => e.exact);
      case "near":
        return this.all.filter((e) => !e.exact);
      case "conson":
        return this.consAll;
      case "asson":
        return this.assonAll;
      case "allit":
        return this.allitAll;
      default: {
        const seen = /* @__PURE__ */ new Set();
        const out = [];
        const push = (arr) => {
          for (const e of arr) {
            if (seen.has(e.word))
              continue;
            seen.add(e.word);
            out.push(e);
          }
        };
        push(this.all.filter((e) => e.exact));
        push(this.all.filter((e) => !e.exact));
        push(this.consAll);
        push(this.assonAll);
        push(this.allitAll);
        return out;
      }
    }
  }
  hasWord() {
    return this.word.length > 0;
  }
  /** Подсветить кнопку слежения по текущему состоянию настройки. */
  updateFollowBtn() {
    let _a;
    (_a = this.followBtn) == null ? void 0 : _a.toggleClass("is-on", this.plugin.settings.followCursor);
  }
  /** Уйти с генератора: включили слежение — панель должна показывать рифмы, а не пасхалку. */
  leaveGenerator() {
    if (this.tab !== "gen")
      return;
    this.tab = "rhymes";
    this.renderBody();
  }
  /**
   * Слово из строки под курсором (режим слежения). Молча пропускаем всё, из-за чего
   * выдача мигала бы: недописанные и незнакомые слова, повтор текущего, набор в поле
   * поиска, вкладку генератора. Историю «назад» слежение не копит — это новая точка отсчёта.
   */
  async followWord(raw) {
    const dict = this.plugin.dict;
    if (dict.status !== "ready")
      return;
    if (this.tab === "gen")
      return;
    if (activeDocument.activeElement === this.inputEl)
      return;
    const word = dict.normalizeYo(raw);
    if (word === this.word)
      return;
    if (!dict.lookup(word))
      return;
    this.navStack = [];
    this.navPos = -1;
    await this.showWord(word);
  }
  /** Перезапросить данные текущего слова (после подключения личного словаря). */
  refresh() {
    if (this.word)
      void this.showWord(this.word);
  }
  /** Непустые разделы в визуальном порядке — для кнопок и циклической навигации. */
  availableTabs() {
    const list = [];
    if (this.stress === null) {
      list.push("rhymes");
    } else if (this.all.length > 0 || this.consAll.length > 0 || this.assonAll.length > 0 || this.allitAll.length > 0) {
      list.push("rhymes");
    }
    // пока вторая волна не приехала, про формы и толкования ничего не известно — вкладку
    // держим доступной, иначе до неё нельзя было бы дотянуться, чтобы её же и загрузить
    if (!this.plugin.dict.heavyReady() || this.definitions && this.definitions.groups.length > 0 || this.forms && this.forms.rows.length > 0)
      list.push("meaning");
    const hasSem = this.localSyns.length > 0 || this.synonyms && this.synonyms.groups.length > 0 ||this.antonyms && this.antonyms.groups.length > 0 || this.hypernyms && this.hypernyms.groups.length > 0 || this.hyponyms && this.hyponyms.groups.length > 0 || this.related && this.related.groups.length > 0 || this.idioms && this.idioms.items.length > 0 || this.phrases && this.phrases.items.length > 0 || this.proverbs && this.proverbs.items.length > 0 || this.associations && this.associations.groups.length > 0 || this.metagrams && this.metagrams.groups.length > 0 || this.anagrams && this.anagrams.groups.length > 0;
    if (hasSem)
      list.push("assoc");
    if (this.plugin.settings.genUnlocked)
      list.push("gen");
    return list;
  }
  /** Ctrl+←/→: переход к соседнему доступному разделу (циклически). */
  cycleTab(dir) {
    if (!this.hasWord())
      return;
    const tabs = this.availableTabs();
    const i = tabs.indexOf(this.tab);
    const next = tabs[(Math.max(i, 0) + dir + tabs.length) % tabs.length];
    if (next === this.tab)
      return;
    this.tab = next;
    this.shown = PAGE;
    this.renderBody();
  }
  /** Клик по гласной: сменить ударение (и запомнить, если оно не словарное по умолчанию). */
  setStress(i) {
    let _a, _b;
    if (this.stress === i)
      return;
    this.stress = i;
    this.plugin.setUserStress(this.word, i === ((_b = (_a = this.variants[0]) == null ? void 0 : _a.s) != null ? _b : -1) ? null : i);
    this.soundKind = this.soundKindPref;
    this.shown = PAGE;
    this.loadRhymes();
    this.ensureValidTab();
    this.renderBody();
  }
  /** Проходит ли слово текущие фильтры слоги/часть речи/лексика. */
  /** Множество семантически связанных слов текущего слова — для подсветки «осмысленных» рифм. */
  buildRelatedSet() {
    const set = /* @__PURE__ */ new Set();
    const w0 = this.word;
    const add = (s) => {
      if (!s)
        return;
      for (const g of s.groups)
        for (const w of g) {
          if (w === w0 || w.includes(w0) || w0.includes(w) || looksSameRoot(w, w0))
            continue;
          set.add(w);
        }
    };
    add(this.synonyms);
    add(this.antonyms);
    add(this.hypernyms);
    add(this.hyponyms);
    add(this.related);
    add(this.associations);
    this.relatedWords = set;
  }
  passesFilter(e) {
    if (this.semanticOnly && !this.relatedWords.has(e.word))
      return false;
    if (!this.plugin.settings.lexShow[lexCat(e.f)])
      return false;
    if (this.sylFilter === 4 && e.syl < 4)
      return false;
    if (this.sylFilter >= 1 && this.sylFilter <= 3 && e.syl !== this.sylFilter)
      return false;
    if (this.posFilter && e.p !== this.posFilter)
      return false;
    return true;
  }
  filtered() {
    return this.soundList().filter((e) => this.passesFilter(e)).sort(displayCmp);
  }
  /**
   * Фильтры выдачи липкие: пишешь строку в размер — «2 слога» и часть речи держатся
   * при переходе к следующему слову и при слежении за курсором. Сбрасывает их только
   * кнопка в ряду фильтров и очистка поиска.
   */
  clearFilters() {
    this.sylFilter = 0;
    this.posFilter = "";
    this.semanticOnly = false;
    this.soundKindPref = "all";
    this.soundKind = "all";
    this.shown = PAGE;
    this.saveFilters();
  }
  /** Фильтры живут в data.json и переживают перезапуск; значения проверяем — файл правят руками. */
  loadFilters() {
    const s = this.plugin.settings;
    this.sylFilter = Number.isInteger(s.filterSyl) && s.filterSyl >= 0 && s.filterSyl <= 4 ? s.filterSyl : 0;
    this.posFilter = POS_KEYS.includes(s.filterPos) ? s.filterPos : "";
    this.soundKindPref = KIND_KEYS.includes(s.filterKind) ? s.filterKind : "all";
    this.soundKind = this.soundKindPref;
    this.semanticOnly = s.filterSemantic === true;
  }
  /** Запомнить фильтры — как и слои лексики, пишем на каждый клик по фильтру. */
  saveFilters() {
    const s = this.plugin.settings;
    s.filterSyl = this.sylFilter;
    s.filterPos = this.posFilter;
    s.filterKind = this.soundKindPref;
    s.filterSemantic = this.semanticOnly;
    void this.plugin.saveSettings();
  }
  /** Есть ли что сбрасывать (слой лексики — глобальная настройка, её не трогаем). */
  filtersActive() {
    return this.sylFilter !== 0 || this.posFilter !== "" || this.semanticOnly || this.soundKindPref !== "all";
  }
  /** Пусто: если виноваты фильтры — предложить сброс прямо в сообщении. */
  renderEmpty(host) {
    const box = host.createDiv({ cls: "rr-status", text: t("noRhymes") });
    if (!this.filtersActive())
      return;
    const btn = box.createEl("button", { cls: "rr-fclear", text: t("resetFilters") });
    btn.title = t("resetFiltersHint");
    btn.addEventListener("click", () => {
      this.clearFilters();
      this.renderSoundResults();
    });
  }
  renderStatus(msg) {
    this.bodyEl.empty();
    this.bodyEl.createDiv({ cls: "rr-status", text: msg });
  }
  /** Экран «нет словаря»: пояснение + кнопка скачивания с прогрессом (мобильный/новая установка). */
  renderMissing() {
    this.bodyEl.empty();
    const box = this.bodyEl.createDiv({ cls: "rr-missing" });
    box.createDiv({ cls: "rr-status", text: t("dictMissing") });
    const btn = box.createEl("button", { cls: "rr-add-btn", text: t("dlDict") });
    const prog = box.createDiv({ cls: "rr-dl-progress" });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      prog.setText(t("dlProgress"));
      const ok = await this.plugin.downloadDict((done, total) => prog.setText(`${t("dlProgress")} ${done}/${total}`));
      if (ok) {
        if (this.word)
          await this.showWord(this.word);
        else
          this.renderBody();
      } else {
        btn.disabled = false;
        prog.setText(t("dlFailed"));
      }
    });
  }
  /** Копировать слово в буфер с уведомлением — «Скопировано» только при реальном успехе. */
  copyWord(w) {
    void this.writeClipboard(w).then((ok) => {
      new Notice(ok ? t("copied") + w : t("copyFail"));
    });
  }
  /** Async Clipboard, иначе фолбэк execCommand: мобильный webview часто отклоняет
   * navigator.clipboard (тем более из setTimeout) — без фолбэка копия молча терялась. */
  async writeClipboard(w) {
    let _a;
    try {
      if ((_a = navigator.clipboard) == null ? void 0 : _a.writeText) {
        await navigator.clipboard.writeText(w);
        return true;
      }
    } catch {
      // буфер обмена может быть недоступен (нет разрешения, старый webview) — ниже запасной путь
    }
    try {
      const ta = activeDocument.body.createEl("textarea");
      ta.value = w;
      ta.addClass("rr-copy-proxy");
      ta.select();
      const ok = activeDocument.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
  /**
   * Вставить слово/фразу в заметку: заменить выделение, иначе слово под курсором
   * (то самое, к которому искали рифму), иначе просто вписать на место курсора.
   */
  insertWord(text) {
    const editor = this.plugin.getEditor();
    if (!editor) {
      new Notice(t("noEditor"));
      return;
    }
    let from = editor.getCursor("from");
    let to = editor.getCursor("to");
    if (!editor.getSelection()) {
      const range = editor.wordAt(from);
      if (range && /[а-яёА-ЯЁ]/.test(editor.getRange(range.from, range.to))) {
        from = range.from;
        to = range.to;
      }
    }
    const out = /^[А-ЯЁ]/.test(editor.getRange(from, to)) ? text.charAt(0).toUpperCase() + text.slice(1) : text;
    editor.replaceRange(out, from, to);
    editor.setCursor({ line: from.line, ch: from.ch + out.length });
    if (!Platform.isMobile)
      editor.focus();
    new Notice(t("inserted") + out, 1500);
  }
  /**
   * Долгое нажатие по слову (телефон, где нет Alt) — вставка в заметку. Возвращает флаг
   * fired: клик, который webview пришлёт следом за нажатием, надо погасить.
   */
  attachLongPressInsert(el, text) {
    const state = { fired: false };
    let press = null, px = 0, py = 0;
    /*
     * Таймеры ставим и гасим в окне самой панели (containerEl.win). Не activeWindow:
     * это окно, случайно оказавшееся в фокусе на момент вызова, — а панель могли
     * вынести в отдельное окно, и тогда таймер уехал бы не туда. И не window: он
     * всегда главное окно, что для вынесенной панели так же неверно.
     */
    const cancelPress = () => {
      if (press !== null) {
        this.containerEl.win.clearTimeout(press);
        this.copyTimers.delete(press);
        press = null;
      }
    };
    el.addEventListener(
      "touchstart",
      (e) => {
        const tp = e.touches[0];
        px = tp.clientX;
        py = tp.clientY;
        state.fired = false;
        cancelPress();
        press = this.containerEl.win.setTimeout(() => {
          if (press !== null)
            this.copyTimers.delete(press);
          press = null;
          state.fired = true;
          this.insertWord(text);
        }, LONG_PRESS_MS);
        this.copyTimers.add(press);
      },
      { passive: true }
    );
    el.addEventListener(
      "touchmove",
      (e) => {
        const tp = e.touches[0];
        if (Math.abs(tp.clientX - px) > LONG_PRESS_SLOP || Math.abs(tp.clientY - py) > LONG_PRESS_SLOP)
          cancelPress();
      },
      { passive: true }
    );
    el.addEventListener("touchend", () => cancelPress());
    el.addEventListener("touchcancel", () => {
      cancelPress();
      state.fired = false;
    });
    return state;
  }
  /** Клик — копировать, Alt+клик или долгое нажатие — вставить в заметку (без поиска по двойному клику). */
  attachCopyInsert(el, text) {
    const lp = this.attachLongPressInsert(el, text);
    el.addEventListener("click", (e) => {
      if (lp.fired) {
        lp.fired = false;
        return;
      }
      if (e.altKey)
        this.insertWord(text);
      else
        this.copyWord(text);
    });
  }
  /** Клик — копировать, двойной клик — искать рифмы к этому слову. Таймер, чтобы двойной не копировал. */
  attachWordActions(el, word) {
    const lp = this.attachLongPressInsert(el, word);
    let timer = null;
    const cancel = () => {
      if (timer !== null) {
        this.containerEl.win.clearTimeout(timer);
        this.copyTimers.delete(timer);
        timer = null;
      }
    };
    el.addEventListener("click", (e) => {
      if (lp.fired) {
        lp.fired = false;
        cancel();
        return;
      }
      if (e.altKey) {
        cancel();
        this.insertWord(word);
        return;
      }
      if (timer !== null)
        return;
      timer = this.containerEl.win.setTimeout(() => {
        if (timer !== null)
          this.copyTimers.delete(timer);
        timer = null;
        this.copyWord(word);
      }, 200);
      this.copyTimers.add(timer);
    });
    el.addEventListener("dblclick", () => {
      cancel();
      void this.showWord(word);
    });
  }
  /** Погасить отложенные таймеры копирования (при закрытии панели или перерисовке). */
  cancelCopyTimers() {
    for (const id of this.copyTimers)
      this.containerEl.win.clearTimeout(id);
    this.copyTimers.clear();
  }
  async onClose() {
    this.cancelCopyTimers();
  }
  /** Вернуться к предыдущему слову цепочки (кнопка «назад»). */
  goBack() {
    if (this.navPos <= 0)
      return;
    this.navPos--;
    this.navigating = true;
    void this.showWord(this.navStack[this.navPos]).finally(() => {
      this.navigating = false;
    });
  }
  /** Слово крупно; каждая гласная кликабельна — клик переносит ударение. */
  renderWordHeader() {
    const posLabel = POS_LABEL();
    if (this.navPos > 0) {
      const back = this.bodyEl.createEl("button", { cls: "rr-back" });
      setIcon(back, "arrow-left");
      back.setAttr("aria-label", t("back") + this.navStack[this.navPos - 1]);
      back.addEventListener("click", () => this.goBack());
    }
    const wrap = this.bodyEl.createDiv({ cls: "rr-word" });
    const multiSyl = countSyllables(this.word) > 1;
    for (let i = 0; i < this.word.length; i++) {
      const ch = this.word[i];
      if (VOWELS.includes(ch)) {
        const isActive = i === this.stress;
        const sp = wrap.createSpan({
          cls: "rr-vowel" + (isActive ? " is-stressed" : ""),
          text: isActive && multiSyl && ch !== "\u0451" ? ch + "\u0301" : ch
        });
        sp.setAttr("title", t("vowelHint"));
        const idx = i;
        sp.addEventListener("click", () => this.setStress(idx));
      } else {
        wrap.appendText(ch);
      }
    }
    const active = this.variants.find((x) => x.s === this.stress);
    if (active && posLabel[active.p])
      wrap.createSpan({ cls: "rr-pos", text: " \xB7 " + posLabel[active.p] });
    const others = this.variants.filter((x) => x.s !== this.stress);
    if (others.length > 0) {
      const alt = this.bodyEl.createDiv({ cls: "rr-alt" });
      alt.appendText(t("also"));
      others.forEach((o, k) => {
        if (k > 0)
          alt.appendText(", ");
        const label = markStress(this.word, o.s) + (posLabel[o.p] ? ` \xB7 ${posLabel[o.p]}` : "");
        const a = alt.createSpan({ cls: "rr-alt-link", text: label });
        a.addEventListener("click", () => this.setStress(o.s));
      });
    }
  }
  /** Ряд больших кнопок-разделов (Рифмы · Значение · Ассоциации [· Генератор]); без данных — приглушены. */
  renderTabs(avail) {
    const tabsWrap = this.bodyEl.createDiv({ cls: "rr-bigtabs" });
    const row = tabsWrap.createDiv({ cls: "rr-bigtab-row" });
    const defs = [
      ["rhymes", t("tabRhymes")],
      ["meaning", t("tabMeaning")],
      ["assoc", t("tabAssoc")]
    ];
    if (this.plugin.settings.genUnlocked)
      defs.push(["gen", t("tabGen")]);
    for (const [id, label] of defs) {
      const enabled = avail.has(id);
      const b = row.createEl("button", {
        cls: "rr-bigtab" + (this.tab === id ? " is-active" : "") + (enabled ? "" : " is-disabled"),
        text: label
      });
      if (enabled) {
        b.addEventListener("click", () => {
          if (this.tab === id)
            return;
          this.tab = id;
          this.shown = PAGE;
          this.renderBody();
        });
      }
    }
    this.fitTabs();
  }
  /** Подписи кнопок не влезают в строку (телефон, узкий сайдбар) — перестроить ряд в сетку 2×2. */
  fitTabs() {
    const row = this.bodyEl.querySelector(".rr-bigtab-row");
    if (!row)
      return;
    row.removeClass("is-grid");
    const tight = Array.from(row.children).some((b) => b.scrollWidth > b.clientWidth);
    row.toggleClass("is-grid", tight);
  }
  renderBody() {
    this.cancelCopyTimers();
    this.bodyEl.empty();
    this.resultsHost = null;
    if (!this.word) {
      if (!this.plugin.settings.genUnlocked) {
        this.bodyEl.createDiv({ cls: "rr-status", text: t("emptyHint") });
        return;
      }
      this.renderTabs(/* @__PURE__ */ new Set(["gen"]));
      if (this.tab === "gen")
        this.renderGenerator();
      else
        this.bodyEl.createDiv({ cls: "rr-status", text: t("emptyHint") });
      return;
    }
    this.renderWordHeader();
    this.renderTabs(new Set(this.availableTabs()));
    if (this.tab === "meaning") {
      this.renderDefinitions();
      return;
    }
    if (this.tab === "assoc") {
      this.renderSemantics();
      return;
    }
    if (this.tab === "gen") {
      this.renderGenerator();
      return;
    }
    if (this.stress === null) {
      this.bodyEl.createDiv({ cls: "rr-status", text: t("notFoundManual") });
      return;
    }
    this.resultsHost = this.bodyEl.createDiv({ cls: "rr-results" });
    this.renderSoundResults();
  }
  /** Пилюли строгости + фильтры + список рифм. Зовётся заново при любом клике по фильтру. */
  renderSoundResults() {
    let _a, _b, _c, _d, _e, _f;
    const host = this.resultsHost;
    if (!host)
      return;
    host.empty();
    this.cancelCopyTimers();
    const kinds = this.availableKinds();
    this.soundKind = this.soundKindPref;
    if (this.soundKind === "allit") {
      if (this.allitAll.length === 0)
        this.soundKind = "all";
    } else if (this.soundKind !== "all" && !kinds.some(([k]) => k === this.soundKind)) {
      this.soundKind = "all";
    }
    const posLabel = POS_LABEL();
    const list = this.filtered();
    const bar = host.createDiv({ cls: "rr-filters" });
    if (kinds.length >= 2 || this.allitAll.length > 0) {
      const kindOpts = [["all", t("kindAll")], ...kinds.map(([k, l]) => [k, l])];
      if (this.allitAll.length > 0)
        kindOpts.push(["allit", t("kindAllit")]);
      this.filterMenu(
        bar,
        t("kindLabel"),
        (_b = (_a = kindOpts.find(([k]) => k === this.soundKind)) == null ? void 0 : _a[1]) != null ? _b : t("kindAll"),
        this.soundKind !== "all",
        (menu) => {
          for (const [val, label] of kindOpts) {
            menu.addItem(
              (it) => it.setTitle(label).setChecked(this.soundKind === val).onClick(() => {
                this.soundKindPref = val;
                this.shown = PAGE;
                this.saveFilters();
                this.renderSoundResults();
              })
            );
          }
        }
      );
    }
    const sylOpts = [[0, t("filterAll")], [1, "1"], [2, "2"], [3, "3"], [4, "4+"]];
    this.filterMenu(
      bar,
      t("syllables"),
      (_d = (_c = sylOpts.find(([v]) => v === this.sylFilter)) == null ? void 0 : _c[1]) != null ? _d : t("filterAll"),
      this.sylFilter !== 0,
      (menu) => {
        for (const [val, label] of sylOpts) {
          menu.addItem(
            (it) => it.setTitle(label).setChecked(this.sylFilter === val).onClick(() => {
              this.sylFilter = val;
              this.saveFilters();
              this.renderSoundResults();
            })
          );
        }
      }
    );
    const posOpts = [["", t("filterAll")], ["n", t("posN")], ["v", t("posV")], ["a", t("posA")], ["d", t("posD")], ["i", t("posI")]];
    this.filterMenu(
      bar,
      t("filterPos"),
      (_f = (_e = posOpts.find(([v]) => v === this.posFilter)) == null ? void 0 : _e[1]) != null ? _f : t("filterAll"),
      this.posFilter !== "",
      (menu) => {
        for (const [val, label] of posOpts) {
          menu.addItem(
            (it) => it.setTitle(label).setChecked(this.posFilter === val).onClick(() => {
              this.posFilter = val;
              this.saveFilters();
              this.renderSoundResults();
            })
          );
        }
      }
    );
    const lexOpts = [
      [0, t("lexBase")],
      [1, t("lexFreq")],
      [2, t("lexCommon")],
      [3, t("lexRare")]
    ];
    const lexOn = lexOpts.filter(([idx]) => this.plugin.settings.lexShow[idx]);
    this.filterMenu(
      bar,
      t("filterLex"),
      `${lexOn.length}/${lexOpts.length}`,
      lexOn.length < lexOpts.length,
      (menu) => {
        for (const [idx, label] of lexOpts) {
          menu.addItem(
            (it) => it.setTitle(label).setChecked(this.plugin.settings.lexShow[idx]).onClick(() => {
              this.plugin.settings.lexShow[idx] = !this.plugin.settings.lexShow[idx];
              void this.plugin.saveSettings();
              this.renderSoundResults();
            })
          );
        }
      }
    );
    if (list.some((e) => this.relatedWords.has(e.word)) || this.semanticOnly) {
      const semBtn = bar.createEl("button", { cls: "rr-semtoggle" + (this.semanticOnly ? " is-active" : ""), text: t("semanticOnly") });
      semBtn.title = t("semanticHint");
      semBtn.addEventListener("click", () => {
        this.semanticOnly = !this.semanticOnly;
        this.shown = PAGE;
        this.saveFilters();
        this.renderSoundResults();
      });
    }
    if (this.filtersActive()) {
      const clr = bar.createEl("button", { cls: "rr-fclear", text: t("resetFilters") });
      clr.title = t("resetFiltersHint");
      clr.addEventListener("click", () => {
        this.clearFilters();
        this.renderSoundResults();
      });
    }
    bar.createSpan({ cls: "rr-count", text: `${list.length}${t("rhymesCount")}` });
    const lexLabel = [t("lexBase"), t("lexFreq"), t("lexCommon"), t("lexRare")];
    if (this.soundKind === "all" && kinds.length + (this.allitAll.length > 0 ? 1 : 0) >= 2) {
      this.renderKindSections(host, posLabel, lexLabel);
      return;
    }
    const listEl = host.createDiv({ cls: "rr-list" });
    if (list.length === 0) {
      this.renderEmpty(listEl);
      return;
    }
    for (const e of list.slice(0, this.shown))
      this.renderChip(listEl, e, posLabel, lexLabel);
    if (list.length > this.shown) {
      const more = host.createEl("button", { cls: "rr-more", text: `${t("showMore")} (${list.length - this.shown})` });
      more.addEventListener("click", () => {
        this.shown += PAGE_MORE;
        this.renderSoundResults();
      });
    }
  }
  /** Один чип-слово: клик — копия, двойной — рифмы к нему; класс по лексическому слою. */
  renderChip(container, e, posLabel, lexLabel) {
    const lc = lexCat(e.f);
    const related = this.relatedWords.has(e.word);
    const chip = container.createSpan({ cls: `rr-chip rr-lex${lc}` + (related ? " rr-related" : ""), text: markStress(e.word, e.s) });
    chip.title = `${t("chipHint")} \xB7 ${insertHint()}${posLabel[e.p] ? " \xB7 " + posLabel[e.p] : ""} \xB7 ${lexLabel[lc]}${related ? " \xB7 " + t("relatedHint") : ""}`;
    this.attachWordActions(chip, e.word);
  }
  /** Вид «все»: каждая разновидность (точные/близкие/созвучия/ассонансы) — своя секция с заголовком. */
  renderKindSections(host, posLabel, lexLabel) {
    const src = [
      ["exact", t("kindExact"), this.all.filter((e) => e.exact)],
      ["near", t("tabNear"), this.all.filter((e) => !e.exact)],
      ["conson", t("tabConson"), this.consAll],
      ["asson", t("tabAsson"), this.assonAll],
      ["allit", t("kindAllit"), this.allitAll]
    ];
    let firstKind = null;
    const toRender = [];
    for (const [kind, label, entries] of src) {
      const list = entries.filter((e) => this.passesFilter(e)).sort(displayCmp);
      if (list.length === 0)
        continue;
      if (firstKind === null)
        firstKind = kind;
      toRender.push([kind, label, list]);
    }
    if (toRender.length === 0) {
      this.renderEmpty(host);
      return;
    }
    for (const [kind, label, list] of toRender) {
      const def = kind === "exact" || kind === "near" || kind === firstKind;
      this.renderKindSection(host, kind, label, list, def, posLabel, lexLabel);
    }
  }
  /** Одна сворачиваемая секция вида: заголовок со счётчиком; чипы рисуются лениво при раскрытии. */
  renderKindSection(host, kind, label, list, defaultOpen, posLabel, lexLabel) {
    let _a;
    const details = host.createEl("details", { cls: "rr-ksec" });
    details.open = (_a = this.sectionOpen[kind]) != null ? _a : defaultOpen;
    const sum = details.createEl("summary", { cls: "rr-ksec-sum" });
    sum.createSpan({ cls: "rr-ksec-label", text: label });
    sum.createSpan({ cls: "rr-ksec-count", text: String(list.length) });
    const body = details.createDiv({ cls: "rr-list" });
    const paint = () => {
      let _a2;
      body.empty();
      const shown = (_a2 = this.sectionShown[kind]) != null ? _a2 : PAGE;
      for (const e of list.slice(0, shown))
        this.renderChip(body, e, posLabel, lexLabel);
      if (list.length > shown) {
        const more = body.createEl("button", { cls: "rr-more", text: `${t("showMore")} (${list.length - shown})` });
        more.addEventListener("click", () => {
          this.sectionShown[kind] = shown + PAGE_MORE;
          paint();
        });
      }
    };
    if (details.open)
      paint();
    details.addEventListener("toggle", () => {
      this.sectionOpen[kind] = details.open;
      if (details.open && body.childElementCount === 0)
        paint();
    });
  }
  /** Кнопка-меню фильтра «подпись: значение ▾»; build наполняет выпадающее меню Obsidian. */
  filterMenu(parent, label, value, active, build) {
    const btn = parent.createEl("button", { cls: "rr-fbtn" + (active ? " is-set" : "") });
    btn.createSpan({ cls: "rr-fbtn-label", text: label + ":" });
    btn.createSpan({ cls: "rr-fbtn-val", text: value });
    setIcon(btn.createSpan({ cls: "rr-fbtn-chev" }), "chevron-down");
    btn.addEventListener("click", () => {
      const menu = new Menu();
      build(menu);
      const r = btn.getBoundingClientRect();
      menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
    });
  }
  /** Сворачиваемая таблица словоформ с ударениями — вверху вкладки «Значение». */
  renderForms(host) {
    const f = this.forms;
    if (!f || f.rows.length === 0)
      return;
    const details = host.createEl("details", { cls: "rr-forms" });
    details.createEl("summary", {
      cls: "rr-forms-summary",
      text: t("formsTitle") + (f.lemma ? " \u2192 " + f.lemma : "")
    });
    const grid = details.createDiv({ cls: "rr-forms-grid" });
    for (const r of f.rows) {
      const row = grid.createDiv({ cls: "rr-form-row" });
      row.createSpan({ cls: "rr-form-label", text: r.label });
      const val = row.createSpan({ cls: "rr-form-val", text: r.form });
      val.title = `${t("copyHint")} \xB7 ${insertHint()}`;
      this.attachCopyInsert(val, stripStress(r.form));
    }
  }
  renderDefinitions() {
    // формы и толкования — это ~360 МБ, они грузятся только когда сюда зашли
    const dict = this.plugin.dict;
    if (!dict.heavyReady()) {
      if (dict.heavyStatus === "error") {
        this.bodyEl.createDiv({ cls: "rr-status", text: t("defsFailed") });
        return;
      }
      this.bodyEl.createDiv({ cls: "rr-status", text: t("defsLoading") });
      void dict.loadHeavy().then(() => {
        if (this.tab === "meaning" && this.word)
          this.refresh();
      });
      return;
    }
    const wrap = this.bodyEl.createDiv({ cls: "rr-defs" });
    this.renderForms(wrap);
    const defs = this.definitions;
    if (!defs)
      return;
    if (defs.lemma !== this.word) {
      wrap.createDiv({ cls: "rr-def-lemma", text: "\u2192 " + defs.lemma });
    }
    for (const group of defs.groups) {
      const g = wrap.createDiv({ cls: "rr-def-group" });
      // личные словари подписаны своим именем, у Викисловаря стояла только часть речи —
      // и выходило, что его название видно лишь в самом низу, под всеми словарями
      const label = group.wiki ? (group.pos ? `${t("defWiki")} \xB7 ${group.pos}` : t("defWiki")) : group.pos;
      if (label)
        g.createDiv({ cls: "rr-def-pos" + (group.wiki ? " is-wiki" : ""), text: label });
      const ol = g.createEl("ol", { cls: "rr-def-list" });
      for (const sense of group.senses) {
        const li = ol.createEl("li");
        this.appendClickableText(li, sense.gloss);
        if (sense.examples && sense.examples.length) {
          const exWrap = li.createDiv({ cls: "rr-def-examples" });
          for (const ex of sense.examples) {
            const row = exWrap.createDiv({ cls: "rr-def-ex" });
            this.appendClickableText(row.createSpan({ cls: "rr-def-ex-text" }), ex.text);
            if (ex.ref)
              row.createSpan({ cls: "rr-def-ex-ref", text: " \u2014 " + ex.ref });
          }
        }
      }
    }
    if (defs.etymology) {
      const et = wrap.createDiv({ cls: "rr-def-etym" });
      et.createSpan({ cls: "rr-def-etym-label", text: t("defEtym") + " " });
      et.appendText(defs.etymology);
    }
    wrap.createDiv({ cls: "rr-def-src", text: t("defSource") });
  }
  /** Вписать текст, сделав каждое русское слово кликабельным (клик — искать рифмы/значение к нему). */
  appendClickableText(parent, text) {
    const re = /[а-яёА-ЯЁ]+(?:-[а-яёА-ЯЁ]+)*/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last)
        parent.appendText(text.slice(last, m.index));
      const word = m[0];
      const span = parent.createSpan({ cls: "rr-defword", text: word });
      const lp = this.attachLongPressInsert(span, word);
      span.addEventListener("click", (e) => {
        if (lp.fired) {
          lp.fired = false;
          return;
        }
        if (e.altKey)
          this.insertWord(word);
        else
          void this.showWord(word);
      });
      last = re.lastIndex;
    }
    if (last < text.length)
      parent.appendText(text.slice(last));
  }
  chipGroup(wrap, words) {
    const row = wrap.createDiv({ cls: "rr-syn-group" });
    for (const w of words) {
      const chip = row.createSpan({ cls: "rr-chip", text: w });
      chip.title = `${t("chipHint")} · ${insertHint()}`;
      this.attachWordActions(chip, w);
    }
  }
  /** Сворачиваемый подраздел «Ассоциаций»: заголовок + счётчик, тело строит build; раскрытость на сессию. */
  semSection(host, key, title, count, build) {
    let _a;
    const details = host.createEl("details", { cls: "rr-ssec" });
    details.open = (_a = this.semOpen[key]) != null ? _a : true;
    const sum = details.createEl("summary", { cls: "rr-ssec-sum" });
    sum.createSpan({ cls: "rr-ssec-label", text: title });
    sum.createSpan({ cls: "rr-ssec-count", text: String(count) });
    build(details.createDiv({ cls: "rr-ssec-body" }));
    details.addEventListener("toggle", () => {
      this.semOpen[key] = details.open;
    });
  }
  /** Смысловой раздел: синонимы, антонимы, фразы и ассоциации под одной вкладкой, складными подразделами. */
  renderSemantics() {
    const wrap = this.bodyEl.createDiv({ cls: "rr-syns" });
    const lemmaSuffix = (l) => l ? " \u2192 " + l : "";
    const wordCount = (groups) => groups.reduce((n, g) => n + g.length, 0);
    let any = false;
    const chipSecs = [
      ["syn", t("tabSynonyms"), this.synonyms],
      ["ant", t("secAntonyms"), this.antonyms],
      ["hyper", t("secHypernyms"), this.hypernyms],
      ["hypo", t("secHyponyms"), this.hyponyms],
      ["rel", t("secRelated"), this.related]
    ];
    for (const [key, name, data] of chipSecs) {
      if (!data || data.groups.length === 0)
        continue;
      any = true;
      this.semSection(wrap, key, name + lemmaSuffix(data.lemma), wordCount(data.groups), (b) => {
        for (const g of data.groups)
          this.chipGroup(b, g);
      });
    }
    const idi = this.idioms;
    if (idi && idi.items.length > 0) {
      any = true;
      this.semSection(wrap, "idi", t("secIdioms") + lemmaSuffix(idi.lemma), idi.items.length, (b) => {
        this.chipGroup(b, idi.items);
      });
    }
    const ph = this.phrases;
    if (ph && ph.items.length > 0) {
      any = true;
      this.semSection(wrap, "phrases", t("tabPhrases") + lemmaSuffix(ph.lemma), ph.items.length, (b) => {
        for (const it of ph.items) {
          const prow = b.createDiv({ cls: "rr-phrase" });
          const pt = prow.createSpan({ cls: "rr-phrase-text", text: it.phrase });
          pt.title = `${t("copyHint")} \xB7 ${insertHint()}`;
          this.attachCopyInsert(pt, it.phrase);
          if (it.gloss)
            prow.createSpan({ cls: "rr-phrase-gloss", text: " \u2014 " + it.gloss });
        }
        b.createDiv({ cls: "rr-def-src", text: t("defSource") });
      });
    }
    const prov = this.proverbs;
    if (prov && prov.items.length > 0) {
      any = true;
      this.semSection(wrap, "prov", t("secProverbs") + lemmaSuffix(prov.lemma), prov.items.length, (b) => {
        for (const it of prov.items) {
          const prow = b.createDiv({ cls: "rr-phrase" });
          const pt = prow.createSpan({ cls: "rr-phrase-text", text: it });
          pt.title = `${t("copyHint")} \xB7 ${insertHint()}`;
          this.attachCopyInsert(pt, it);
        }
        b.createDiv({ cls: "rr-def-src", text: t("defSource") });
      });
    }
    const assoc = this.associations;
    if (assoc && assoc.groups.length > 0) {
      any = true;
      this.semSection(wrap, "assoc", t("tabAssoc") + lemmaSuffix(assoc.lemma), wordCount(assoc.groups), (b) => {
        for (const g of assoc.groups)
          this.chipGroup(b, g);
        b.createDiv({ cls: "rr-def-src", text: t("assocSource") });
      });
    }
    // личные словари синонимов — рядом с ассоциациями, а не под «Синонимами»: у больших
    // словарей вроде ASIS ряды скорее ассоциативные (мороз → водка, дубак), и наверху
    // вкладки они отодвигали всё остальное
    for (const d of this.localSyns) {
      any = true;
      this.semSection(wrap, "lsyn:" + d.id, d.name + lemmaSuffix(d.lemma), wordCount(d.groups), (b) => {
        for (const g of d.groups)
          this.chipGroup(b, g);
      });
    }
    const tailSecs = [
      ["meta", t("secMetagrams"), this.metagrams],
      ["ana", t("secAnagrams"), this.anagrams]
    ];
    for (const [key, name, data] of tailSecs) {
      if (!data || data.groups.length === 0)
        continue;
      any = true;
      this.semSection(wrap, key, name + lemmaSuffix(data.lemma), wordCount(data.groups), (b) => {
        for (const g of data.groups)
          this.chipGroup(b, g);
      });
    }
    if (!any)
      wrap.createDiv({ cls: "rr-status", text: t("noSynonyms") });
  }
  /** Генератор-пасхалка «фристайл»: категория (сущ/прил/глаг/перс) + сколько слов, тап — ещё. */
  renderGenerator() {
    if (this.plugin.dict.status === "idle") {
      void this.plugin.dict.load().then(() => {
        if (this.tab === "gen")
          this.rollGen();
      });
    }
    const wrap = this.bodyEl.createDiv({ cls: "rr-gen" });
    const controls = wrap.createDiv({ cls: "rr-gen-controls" });
    const cats = [
      ["n", t("genNoun")],
      ["a", t("genAdj")],
      ["v", t("genVerb")],
      ["char", t("genChar")]
    ];
    for (const [cat, label] of cats) {
      const b = controls.createEl("button", { cls: "rr-gen-cat" + (this.genCats.has(cat) ? " is-active" : ""), text: label });
      b.addEventListener("click", () => {
        if (this.genCats.has(cat)) {
          if (this.genCats.size > 1) {
            this.genCats.delete(cat);
            b.removeClass("is-active");
          }
        } else {
          this.genCats.add(cat);
          b.addClass("is-active");
        }
        this.rollGen();
      });
    }
    const cnt = controls.createEl("button", { cls: "rr-gen-count", text: "\xD7" + this.genCount });
    cnt.title = t("genCountHint");
    cnt.addEventListener("click", () => {
      this.genCount = this.genCount >= 10 ? 1 : this.genCount + 1;
      cnt.setText("\xD7" + this.genCount);
      this.rollGen();
    });
    const tierRow = wrap.createDiv({ cls: "rr-gen-controls rr-gen-tiers" });
    const tierOpts = [[0, t("lexBase")], [1, t("lexFreq")]];
    for (const [tier, label] of tierOpts) {
      const b = tierRow.createEl("button", { cls: "rr-gen-cat" + (this.genTiers.has(tier) ? " is-active" : ""), text: label });
      b.addEventListener("click", () => {
        if (this.genTiers.has(tier)) {
          if (this.genTiers.size > 1) {
            this.genTiers.delete(tier);
            b.removeClass("is-active");
          }
        } else {
          this.genTiers.add(tier);
          b.addClass("is-active");
        }
        this.rollGen();
      });
    }
    this.genHost = wrap.createDiv({ cls: "rr-gen-display", attr: { tabindex: "0" } });
    this.genHost.addEventListener("click", () => {
      let _a;
      (_a = this.genHost) == null ? void 0 : _a.focus();
      this.rollGen();
    });
    if (this.genWords.length === 0)
      this.genWords = this.drawGen();
    this.paintGen();
  }
  rollGen() {
    this.genWords = this.drawGen();
    this.paintGen();
  }
  /** Достаёт genCount слов из «мешка»: без повторов, пока не выйдут все, затем новое перемешивание. */
  drawGen() {
    const key = [...this.genCats].sort().join(",") + "|" + [...this.genTiers].sort().join(",");
    if (key !== this.genBagKey || this.genBag.length === 0) {
      this.genBagKey = key;
      this.genBag = this.plugin.dict.generatorPool([...this.genCats], [...this.genTiers]);
      this.shuffleInPlace(this.genBag);
      this.genBagPos = 0;
    }
    const bag = this.genBag;
    if (bag.length === 0)
      return [];
    const n = Math.min(this.genCount, bag.length);
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    while (out.length < n) {
      if (this.genBagPos >= bag.length) {
        this.shuffleInPlace(bag);
        this.genBagPos = 0;
      }
      const w = bag[this.genBagPos++];
      if (seen.has(w))
        continue;
      seen.add(w);
      out.push(w);
    }
    return out;
  }
  shuffleInPlace(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
  }
  paintGen() {
    const host = this.genHost;
    if (!host)
      return;
    host.empty();
    if (this.genWords.length === 0) {
      host.createDiv({ cls: "rr-status", text: t("genEmpty") });
      return;
    }
    const list = host.createDiv({ cls: "rr-gen-words" });
    for (const w of this.genWords)
      list.createDiv({ cls: "rr-gen-word", text: w });
    host.createDiv({ cls: "rr-gen-hint", text: t("genTapHint") });
  }
};

export { RhymesView, STARTUP_KEYS, VIEW_TYPE_RHYMES };
