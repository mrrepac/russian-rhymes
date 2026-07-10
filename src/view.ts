import { ItemView, Menu, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import { t } from "./i18n";
import { markStress, countSyllables, looksSameRoot, VOWELS } from "./phonetics.js";
import type { Definitions, Forms, GenCat, Phrases, RhymeEntry, StringList, StressVariant, Synonyms } from "./dict";
import type RussianRhymesPlugin from "./main";

export const VIEW_TYPE_RHYMES = "russian-rhymes-view";

/** Убрать комбинирующий знак ударения — для копирования формы в чистом виде. */
const stripStress = (s: string): string => s.replace(/́/g, "");

// три раздела: звуковой (Рифмы, со внутренним переключателем строгости),
// толковый (Значение) и смысловой (Ассоциации); плюс скрытый «Генератор» (пасхалка «фристайл»)
type TabId = "rhymes" | "meaning" | "assoc" | "gen";
// внутренний фильтр звукового раздела: «все», один из четырёх видов созвучия, либо аллитерация (по началу)
type SoundKind = "all" | "exact" | "near" | "conson" | "asson" | "allit";

const POS_LABEL = (): Record<string, string> => ({
  n: t("posN"),
  v: t("posV"),
  a: t("posA"),
  d: t("posD"),
  i: t("posI"),
  x: "",
});

/** Лексический слой по частотному бакету 0..9: 0 базовая (5+), 1 частотная (3–4), 2 обычная (1–2), 3 редкая (0). */
const lexCat = (f: number): number => (f >= 5 ? 0 : f >= 3 ? 1 : f >= 1 ? 2 : 3);

/** Сколько слов показывать в первой порции (до кнопки «показать ещё»). */
const PAGE = 50;
/** Насколько прибавлять на каждый клик «показать ещё» — дальше листать крупнее. */
const PAGE_MORE = 200;

/** Порядок показа рифм: по лексическому слою (базовая→частотная→обычная→редкая), внутри слоя — по алфавиту. */
const displayCmp = (a: RhymeEntry, b: RhymeEntry): number =>
  lexCat(a.f) - lexCat(b.f) || a.word.localeCompare(b.word, "ru");

export class RhymesView extends ItemView {
  private plugin: RussianRhymesPlugin;

  private word = "";
  private variants: StressVariant[] = [];
  private stress: number | null = null; // индекс ударной гласной (словарный или ручной)
  private all: RhymeEntry[] = [];

  private tab: TabId = "rhymes";
  private soundKind: SoundKind = "all";
  private synonyms: Synonyms | null = null;
  private antonyms: Synonyms | null = null;
  private hypernyms: Synonyms | null = null;
  private hyponyms: Synonyms | null = null;
  private related: Synonyms | null = null;
  private associations: Synonyms | null = null;
  private metagrams: Synonyms | null = null;
  private anagrams: Synonyms | null = null;
  private definitions: Definitions | null = null;
  private forms: Forms | null = null;
  private phrases: Phrases | null = null;
  private idioms: StringList | null = null;
  private proverbs: StringList | null = null;

  private sylFilter = 0; // 0 = все, 4 = 4+
  private posFilter = ""; // '' = все
  // рифмы, близкие по смыслу: множество семантически связанных слов текущего слова
  private relatedWords: Set<string> = new Set();
  private semanticOnly = false; // тумблер «по смыслу» — показывать только связанные
  private shown: number;
  private consAll: RhymeEntry[] = []; // кэши на текущее слово+ударение
  private assonAll: RhymeEntry[] = [];
  private allitAll: RhymeEntry[] = []; // аллитерации (по началу слова, ударение не нужно)
  // вид «все»: раскрытость секций (запоминается на сессию) и постраничность каждой
  private sectionOpen: Partial<Record<SoundKind, boolean>> = {};
  private sectionShown: Partial<Record<SoundKind, number>> = {};
  // раскрытость подразделов «Ассоциаций» по ключу секции (на сессию)
  private semOpen: Record<string, boolean> = {};
  // история слов для кнопки «назад» (провал в рифму двойным кликом создаёт цепочку)
  private navStack: string[] = [];
  private navPos = -1;
  private navigating = false; // true во время перехода назад — чтобы не писать в историю

  // генератор-пасхалка «фристайл»; категории и слои — множественный выбор (мин. один активен)
  private genCats: Set<GenCat> = new Set(["n"]);
  private genTiers: Set<number> = new Set([0]); // 0 базовая, 1 частотная; по умолчанию базовая
  private genCount = 1;
  private genWords: string[] = [];
  private genHost: HTMLElement | null = null;
  // «мешок без повторов»: перемешанный пул, курсор и ключ выбранных категорий+слоёв
  private genBag: string[] = [];
  private genBagPos = 0;
  private genBagKey = "";

  private inputEl!: HTMLInputElement;
  private clearBtn!: HTMLElement; // × очистки поля поиска (видна, когда есть текст)
  private followBtn!: HTMLElement; // тумблер «следовать за курсором»
  private bodyEl!: HTMLElement;
  private resultsHost: HTMLElement | null = null; // фильтры+список звукового раздела — перерисовываем только его
  private copyTimers = new Set<number>(); // отложенные таймеры одиночного клика (копия) — гасим при закрытии/перерисовке

  constructor(leaf: WorkspaceLeaf, plugin: RussianRhymesPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.shown = PAGE;
  }

  getViewType(): string {
    return VIEW_TYPE_RHYMES;
  }
  getDisplayText(): string {
    return t("panelTitle");
  }
  getIcon(): string {
    return "feather";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("rr-panel");

    const head = root.createDiv({ cls: "rr-head" });
    const search = head.createDiv({ cls: "rr-search" });
    setIcon(search.createSpan({ cls: "rr-search-icon" }), "search");
    this.inputEl = search.createEl("input", {
      cls: "rr-input",
      attr: { type: "text", placeholder: t("searchPlaceholder"), enterkeyhint: "search", spellcheck: "false" },
    });
    this.registerDomEvent(this.inputEl, "keydown", (e) => {
      if (e.key === "Enter") {
        void this.showWord(this.inputEl.value);
        // на телефоне спрятать клавиатуру — иначе она закрывает результаты
        if (Platform.isMobile) this.inputEl.blur();
      }
    });
    this.registerDomEvent(this.inputEl, "input", () => this.updateClear());

    // × очистки поля: сбрасывает слово, историю и выдачу; фокус обратно в поле
    this.clearBtn = search.createSpan({ cls: "rr-clear" });
    setIcon(this.clearBtn, "x");
    this.clearBtn.setAttr("aria-label", t("clearSearch"));
    this.registerDomEvent(this.clearBtn, "click", () => this.clearSearch());

    // тумблер «следовать за курсором»: панель сама идёт за строкой, которую пишут
    this.followBtn = head.createDiv({ cls: "rr-follow" });
    setIcon(this.followBtn, "crosshair");
    this.followBtn.setAttr("aria-label", t("followHint"));
    this.registerDomEvent(this.followBtn, "click", () => void this.plugin.setFollow(!this.plugin.settings.followCursor));
    this.updateFollowBtn();

    // пробел на вкладке «Генератор» — новое слово (когда фокус в панели, не в поле ввода/редакторе)
    this.registerDomEvent(document, "keydown", (e) => {
      if (e.code !== "Space" || this.tab !== "gen") return;
      const ae = activeDocument.activeElement as HTMLElement | null;
      if (!ae || !this.containerEl.contains(ae)) return;
      if (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable) return;
      e.preventDefault();
      this.rollGen();
    });

    this.bodyEl = root.createDiv({ cls: "rr-body" });
    // панель сузилась/расширилась (телефон, перетаскивание сайдбара) — пересобрать ряд кнопок
    const ro = new ResizeObserver(() => this.fitTabs());
    ro.observe(this.bodyEl);
    this.register(() => ro.disconnect());

    // телефон: горизонтальный свайп по телу листает разделы (как Ctrl+←/→ на десктопе)
    if (Platform.isMobile) this.registerSwipe();

    this.updateClear();
    this.renderBody();
  }

  /** Показать/скрыть × очистки по наличию текста в поле. */
  private updateClear(): void {
    this.clearBtn?.toggleClass("is-shown", this.inputEl.value.length > 0);
  }

  /** Очистить поиск: пустое слово, сброс истории, фокус в поле. */
  private clearSearch(): void {
    this.inputEl.value = "";
    this.word = "";
    this.navStack = [];
    this.navPos = -1;
    this.updateClear();
    this.renderBody();
    this.inputEl.focus();
  }

  /** Фокус в поле поиска (при открытии панели пустой — чтобы сразу печатать). */
  focusSearch(): void {
    this.inputEl?.focus();
    this.inputEl?.select();
  }

  /** Свайп влево/вправо по телу панели — соседний раздел (только мобильный). */
  private registerSwipe(): void {
    let sx = 0, sy = 0, st = 0;
    this.registerDomEvent(this.bodyEl, "touchstart", (e: TouchEvent) => {
      const tp = e.touches[0];
      sx = tp.clientX;
      sy = tp.clientY;
      st = Date.now();
    });
    this.registerDomEvent(this.bodyEl, "touchend", (e: TouchEvent) => {
      const tp = e.changedTouches[0];
      const dx = tp.clientX - sx, dy = tp.clientY - sy;
      // быстрый, явно горизонтальный жест — иначе это вертикальная прокрутка или тап
      if (Date.now() - st < 500 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) {
        this.cycleTab(dx < 0 ? 1 : -1);
      }
    });
  }

  /** Точка входа: показать слово (из двойного Ctrl+C, меню, команды, инпута или двойного клика по чипу). */
  async showWord(raw: string): Promise<void> {
    // берём ПОСЛЕДНЕЕ слово фразы (рифмуем конец строки) — как extractWord в main.ts;
    // раньше поле поиска брало первое слово, расходясь с двойным Ctrl+C
    const ms = raw.toLowerCase().match(/[а-яё]+(?:-[а-яё]+)*/g);
    if (!ms || ms.length === 0) return;
    this.word = ms[ms.length - 1];
    this.inputEl.value = this.word;
    this.updateClear();
    // история для «назад»: пишем только при обычном переходе, не при возврате и не на повтор
    if (!this.navigating && this.navStack[this.navPos] !== this.word) {
      this.navStack = this.navStack.slice(0, this.navPos + 1);
      this.navStack.push(this.word);
      this.navPos = this.navStack.length - 1;
    }
    // пасхалка: слово «фристайл» открывает вкладку «Генератор» (запоминается)
    if (this.word === "фристайл" && !this.plugin.settings.genUnlocked) {
      this.plugin.settings.genUnlocked = true;
      void this.plugin.saveSettings();
    }
    this.sylFilter = 0;
    this.posFilter = "";
    this.soundKind = "all";
    this.semanticOnly = false;
    this.shown = PAGE;

    const dict = this.plugin.dict;
    if (dict.status !== "ready") {
      this.renderStatus(t("dictLoading"));
      await dict.load();
    }
    if (dict.status === "missing" || dict.status === "error") {
      this.renderMissing();
      return;
    }
    // ёфикация ввода: е-написание → однозначная ё-версия (береза→берёза; мед/небо/лет не трогаются)
    const yo = dict.normalizeYo(this.word);
    if (yo !== this.word) {
      if (this.navStack[this.navPos] === this.word) this.navStack[this.navPos] = yo;
      this.word = yo;
      this.inputEl.value = yo;
    }
    const variants = dict.lookup(this.word);
    this.variants = variants ?? [];
    const user = this.plugin.getUserStress(this.word);
    const valid = user !== undefined && user < this.word.length && VOWELS.includes(this.word[user]);
    this.stress = valid ? (user as number) : this.variants[0]?.s ?? null;
    // слова нет в словаре, но гласная одна — ударение однозначно, ставим сами (без клика по гласной)
    if (this.stress === null && countSyllables(this.word) === 1) {
      for (let i = 0; i < this.word.length; i++) {
        if (VOWELS.includes(this.word[i])) { this.stress = i; break; }
      }
    }
    this.synonyms = dict.synonymsFor(this.word);
    this.antonyms = dict.antonymsFor(this.word);
    this.hypernyms = dict.hypernymsFor(this.word);
    this.hyponyms = dict.hyponymsFor(this.word);
    this.related = dict.relatedFor(this.word);
    this.associations = dict.associationsFor(this.word);
    this.metagrams = dict.metagramsFor(this.word);
    this.anagrams = dict.anagramsFor(this.word);
    this.definitions = dict.definitionsFor(this.word);
    this.forms = dict.formsFor(this.word);
    this.phrases = dict.phrasesFor(this.word);
    this.idioms = dict.idiomsFor(this.word);
    this.proverbs = dict.proverbsFor(this.word);
    this.buildRelatedSet();
    this.loadRhymes();
    this.ensureValidTab();
    if (this.word === "фристайл") {
      // пасхалка: сразу открываем генератор со свежей выдачей
      this.tab = "gen";
      this.genWords = [];
    } else if (this.tab === "gen") {
      // обычный поиск не должен оставлять панель на генераторе — уходим на контент
      const content = this.availableTabs().filter((x) => x !== "gen");
      if (content.length > 0) this.tab = content[0];
    }
    this.renderBody();
  }

  private loadRhymes(): void {
    this.sectionShown = {}; // новое слово/ударение — постраничность секций с нуля
    this.allitAll = this.plugin.dict.alliterationsFor(this.word); // от ударения не зависит
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
  private ensureValidTab(): void {
    const tabs = this.availableTabs();
    if (!tabs.includes(this.tab)) this.tab = tabs[0] ?? "rhymes";
  }

  /** Виды созвучий, у которых есть данные, — для пилюль-переключателей внутри «Рифм». */
  private availableKinds(): Array<[SoundKind, string, string]> {
    const kinds: Array<[SoundKind, string, string]> = [];
    if (this.all.some((e) => e.exact)) kinds.push(["exact", t("kindExact"), t("rhymesHint")]);
    if (this.all.some((e) => !e.exact)) kinds.push(["near", t("tabNear"), t("nearHint")]);
    if (this.consAll.length > 0) kinds.push(["conson", t("tabConson"), t("consonHint")]);
    if (this.assonAll.length > 0) kinds.push(["asson", t("tabAsson"), t("assonHint")]);
    return kinds;
  }

  /** Список для текущего вида: конкретный вид или «все» — объединение без повторов, сильные сверху. */
  private soundList(): RhymeEntry[] {
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
        const seen = new Set<string>();
        const out: RhymeEntry[] = [];
        const push = (arr: RhymeEntry[]): void => {
          for (const e of arr) {
            if (seen.has(e.word)) continue;
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

  hasWord(): boolean {
    return this.word.length > 0;
  }

  /** Подсветить кнопку слежения по текущему состоянию настройки. */
  updateFollowBtn(): void {
    this.followBtn?.toggleClass("is-on", this.plugin.settings.followCursor);
  }

  /** Уйти с генератора: включили слежение — панель должна показывать рифмы, а не пасхалку. */
  leaveGenerator(): void {
    if (this.tab !== "gen") return;
    this.tab = "rhymes";
    this.renderBody();
  }

  /**
   * Слово из строки под курсором (режим слежения). Молча пропускаем всё, из-за чего
   * выдача мигала бы: недописанные и незнакомые слова, повтор текущего, набор в поле
   * поиска, вкладку генератора. Историю «назад» слежение не копит — это новая точка отсчёта.
   */
  async followWord(raw: string): Promise<void> {
    const dict = this.plugin.dict;
    if (dict.status !== "ready") return;
    if (this.tab === "gen") return;
    if (activeDocument.activeElement === this.inputEl) return;
    const word = dict.normalizeYo(raw);
    if (word === this.word) return;
    if (!dict.lookup(word)) return;
    this.navStack = [];
    this.navPos = -1;
    await this.showWord(word);
  }

  /** Перезапросить данные текущего слова (после подключения личного словаря). */
  refresh(): void {
    if (this.word) void this.showWord(this.word);
  }

  /** Непустые разделы в визуальном порядке — для кнопок и циклической навигации. */
  private availableTabs(): TabId[] {
    const list: TabId[] = [];
    if (this.stress === null) {
      // слова нет в словаре: рифмы появятся после клика по гласной,
      // держим «Рифмы» живой — там подсказка
      list.push("rhymes");
    } else if (this.all.length > 0 || this.consAll.length > 0 || this.assonAll.length > 0 || this.allitAll.length > 0) {
      list.push("rhymes");
    }
    if (
      (this.definitions && this.definitions.groups.length > 0) ||
      (this.forms && this.forms.rows.length > 0)
    )
      list.push("meaning");
    const hasSem =
      (this.synonyms && this.synonyms.groups.length > 0) ||
      (this.antonyms && this.antonyms.groups.length > 0) ||
      (this.hypernyms && this.hypernyms.groups.length > 0) ||
      (this.hyponyms && this.hyponyms.groups.length > 0) ||
      (this.related && this.related.groups.length > 0) ||
      (this.idioms && this.idioms.items.length > 0) ||
      (this.phrases && this.phrases.items.length > 0) ||
      (this.proverbs && this.proverbs.items.length > 0) ||
      (this.associations && this.associations.groups.length > 0) ||
      (this.metagrams && this.metagrams.groups.length > 0) ||
      (this.anagrams && this.anagrams.groups.length > 0);
    if (hasSem) list.push("assoc");
    // генератор-пасхалка: доступен всегда после разблокировки (не зависит от слова)
    if (this.plugin.settings.genUnlocked) list.push("gen");
    return list;
  }

  /** Ctrl+←/→: переход к соседнему доступному разделу (циклически). */
  cycleTab(dir: 1 | -1): void {
    if (!this.hasWord()) return;
    const tabs = this.availableTabs();
    const i = tabs.indexOf(this.tab);
    const next = tabs[(Math.max(i, 0) + dir + tabs.length) % tabs.length];
    if (next === this.tab) return;
    this.tab = next;
    this.shown = PAGE;
    this.renderBody();
  }

  /** Клик по гласной: сменить ударение (и запомнить, если оно не словарное по умолчанию). */
  private setStress(i: number): void {
    if (this.stress === i) return;
    this.stress = i;
    this.plugin.setUserStress(this.word, i === (this.variants[0]?.s ?? -1) ? null : i);
    this.soundKind = "all";
    this.shown = PAGE;
    this.loadRhymes();
    this.ensureValidTab();
    this.renderBody();
  }

  /** Проходит ли слово текущие фильтры слоги/часть речи/лексика. */
  /** Множество семантически связанных слов текущего слова — для подсветки «осмысленных» рифм. */
  private buildRelatedSet(): void {
    const set = new Set<string>();
    const w0 = this.word;
    const add = (s: Synonyms | null): void => {
      if (!s) return;
      for (const g of s.groups)
        for (const w of g) {
          // отсекаем производные/однокоренные (нелюбовь, суперсила, просвет) — не «другое» осмысленное слово
          if (w === w0 || w.includes(w0) || w0.includes(w) || looksSameRoot(w, w0)) continue;
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

  private passesFilter(e: RhymeEntry): boolean {
    if (this.semanticOnly && !this.relatedWords.has(e.word)) return false;
    if (!this.plugin.settings.lexShow[lexCat(e.f)]) return false;
    if (this.sylFilter === 4 && e.syl < 4) return false;
    if (this.sylFilter >= 1 && this.sylFilter <= 3 && e.syl !== this.sylFilter) return false;
    if (this.posFilter && e.p !== this.posFilter) return false;
    return true;
  }

  private filtered(): RhymeEntry[] {
    return this.soundList().filter((e) => this.passesFilter(e)).sort(displayCmp);
  }

  private renderStatus(msg: string): void {
    this.bodyEl.empty();
    this.bodyEl.createDiv({ cls: "rr-status", text: msg });
  }

  /** Экран «нет словаря»: пояснение + кнопка скачивания с прогрессом (мобильный/новая установка). */
  private renderMissing(): void {
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
        if (this.word) await this.showWord(this.word);
        else this.renderBody();
      } else {
        btn.disabled = false;
        prog.setText(t("dlFailed"));
      }
    });
  }

  /** Копировать слово в буфер с уведомлением — «Скопировано» только при реальном успехе. */
  private copyWord(w: string): void {
    void this.writeClipboard(w).then((ok) => {
      new Notice(ok ? t("copied") + w : t("copyFail"));
    });
  }

  /** Async Clipboard, иначе фолбэк execCommand: мобильный webview часто отклоняет
   * navigator.clipboard (тем более из setTimeout) — без фолбэка копия молча терялась. */
  private async writeClipboard(w: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(w);
        return true;
      }
    } catch { /* пробуем фолбэк ниже */ }
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

  /** Клик — копировать, двойной клик — искать рифмы к этому слову. Таймер, чтобы двойной не копировал. */
  private attachWordActions(el: HTMLElement, word: string): void {
    let timer: number | null = null;
    const cancel = (): void => {
      if (timer !== null) { activeWindow.clearTimeout(timer); this.copyTimers.delete(timer); timer = null; }
    };
    el.addEventListener("click", () => {
      if (timer !== null) return; // второй клик двойного — обрабатывает dblclick
      timer = activeWindow.setTimeout(() => {
        if (timer !== null) this.copyTimers.delete(timer);
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
  private cancelCopyTimers(): void {
    for (const id of this.copyTimers) activeWindow.clearTimeout(id);
    this.copyTimers.clear();
  }

  async onClose(): Promise<void> {
    this.cancelCopyTimers();
  }

  /** Вернуться к предыдущему слову цепочки (кнопка «назад»). */
  private goBack(): void {
    if (this.navPos <= 0) return;
    this.navPos--;
    this.navigating = true;
    void this.showWord(this.navStack[this.navPos]).finally(() => {
      this.navigating = false;
    });
  }

  /** Слово крупно; каждая гласная кликабельна — клик переносит ударение. */
  private renderWordHeader(): void {
    const posLabel = POS_LABEL();
    // стрелка «назад» — когда в цепочке есть предыдущее слово
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
          text: isActive && multiSyl && ch !== "ё" ? ch + "́" : ch,
        });
        sp.setAttr("title", t("vowelHint"));
        const idx = i;
        sp.addEventListener("click", () => this.setStress(idx));
      } else {
        wrap.appendText(ch);
      }
    }
    const active = this.variants.find((x) => x.s === this.stress);
    if (active && posLabel[active.p]) wrap.createSpan({ cls: "rr-pos", text: " · " + posLabel[active.p] });

    // омографы: другие словарные варианты — кликабельной строкой под словом
    const others = this.variants.filter((x) => x.s !== this.stress);
    if (others.length > 0) {
      const alt = this.bodyEl.createDiv({ cls: "rr-alt" });
      alt.appendText(t("also"));
      others.forEach((o, k) => {
        if (k > 0) alt.appendText(", ");
        const label = markStress(this.word, o.s) + (posLabel[o.p] ? ` · ${posLabel[o.p]}` : "");
        const a = alt.createSpan({ cls: "rr-alt-link", text: label });
        a.addEventListener("click", () => this.setStress(o.s));
      });
    }
  }

  /** Ряд больших кнопок-разделов (Рифмы · Значение · Ассоциации [· Генератор]); без данных — приглушены. */
  private renderTabs(avail: Set<TabId>): void {
    const tabsWrap = this.bodyEl.createDiv({ cls: "rr-bigtabs" });
    const row = tabsWrap.createDiv({ cls: "rr-bigtab-row" });
    const defs: Array<[TabId, string]> = [
      ["rhymes", t("tabRhymes")],
      ["meaning", t("tabMeaning")],
      ["assoc", t("tabAssoc")],
    ];
    if (this.plugin.settings.genUnlocked) defs.push(["gen", t("tabGen")]);
    for (const [id, label] of defs) {
      const enabled = avail.has(id);
      const b = row.createEl("button", {
        cls: "rr-bigtab" + (this.tab === id ? " is-active" : "") + (enabled ? "" : " is-disabled"),
        text: label,
      });
      if (enabled) {
        b.addEventListener("click", () => {
          if (this.tab === id) return;
          this.tab = id;
          this.shown = PAGE;
          this.renderBody();
        });
      }
    }
    this.fitTabs();
  }

  /** Подписи кнопок не влезают в строку (телефон, узкий сайдбар) — перестроить ряд в сетку 2×2. */
  private fitTabs(): void {
    const row = this.bodyEl.querySelector<HTMLElement>(".rr-bigtab-row");
    if (!row) return;
    row.removeClass("is-grid");
    const tight = Array.from(row.children).some((b) => b.scrollWidth > b.clientWidth);
    row.toggleClass("is-grid", tight);
  }

  private renderBody(): void {
    this.cancelCopyTimers(); // перерисовка — отменяем ждущую копию по одиночному клику
    this.bodyEl.empty();
    this.resultsHost = null;
    if (!this.word) {
      // без слова: если генератор разблокирован — кнопка «Генератор» остаётся (не пропадает)
      if (!this.plugin.settings.genUnlocked) {
        this.bodyEl.createDiv({ cls: "rr-status", text: t("emptyHint") });
        return;
      }
      this.renderTabs(new Set<TabId>(["gen"]));
      if (this.tab === "gen") this.renderGenerator();
      else this.bodyEl.createDiv({ cls: "rr-status", text: t("emptyHint") });
      return;
    }
    // слово с кликабельными гласными — ударение можно сменить вручную
    this.renderWordHeader();

    // три больших раздела: Рифмы · Значение · Ассоциации (+ Генератор); без данных — приглушены
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

    // ударение неизвестно (слова нет в словаре) — просим кликнуть гласную
    if (this.stress === null) {
      this.bodyEl.createDiv({ cls: "rr-status", text: t("notFoundManual") });
      return;
    }

    // звуковой раздел: свой контейнер, чтобы клики по фильтрам перерисовывали
    // только его и не сбрасывали прокрутку тела
    this.resultsHost = this.bodyEl.createDiv({ cls: "rr-results" });
    this.renderSoundResults();
  }

  /** Пилюли строгости + фильтры + список рифм. Зовётся заново при любом клике по фильтру. */
  private renderSoundResults(): void {
    const host = this.resultsHost;
    if (!host) return;
    host.empty();
    this.cancelCopyTimers(); // фильтр перерисовал список — отменяем ждущую копию

    const kinds = this.availableKinds();
    // сбросить на «все», если текущий вид пропал (allit — по наличию аллитераций)
    if (this.soundKind === "allit") {
      if (this.allitAll.length === 0) this.soundKind = "all";
    } else if (this.soundKind !== "all" && !kinds.some(([k]) => k === this.soundKind)) {
      this.soundKind = "all";
    }

    // один ряд: строгость (пилюли) + фильтры-меню + счётчик справа; на узкой панели
    // flex-wrap переносит на несколько строк, счётчик прижат вправо через margin-left:auto
    const posLabel = POS_LABEL();
    const list = this.filtered();
    const bar = host.createDiv({ cls: "rr-filters" });

    // качество созвучия — меню-фильтр: ≥2 видов рифм ИЛИ есть аллитерации (по началу)
    if (kinds.length >= 2 || this.allitAll.length > 0) {
      const kindOpts: Array<[SoundKind, string]> = [["all", t("kindAll")], ...kinds.map(([k, l]): [SoundKind, string] => [k, l])];
      if (this.allitAll.length > 0) kindOpts.push(["allit", t("kindAllit")]);
      this.filterMenu(
        bar,
        t("kindLabel"),
        kindOpts.find(([k]) => k === this.soundKind)?.[1] ?? t("kindAll"),
        this.soundKind !== "all",
        (menu) => {
          for (const [val, label] of kindOpts) {
            menu.addItem((it) =>
              it
                .setTitle(label)
                .setChecked(this.soundKind === val)
                .onClick(() => {
                  if (this.soundKind === val) return;
                  this.soundKind = val;
                  this.shown = PAGE;
                  this.renderSoundResults();
                })
            );
          }
        }
      );
    }

    // слоги — одиночный выбор
    const sylOpts: Array<[number, string]> = [[0, t("filterAll")], [1, "1"], [2, "2"], [3, "3"], [4, "4+"]];
    this.filterMenu(
      bar,
      t("syllables"),
      sylOpts.find(([v]) => v === this.sylFilter)?.[1] ?? t("filterAll"),
      this.sylFilter !== 0,
      (menu) => {
        for (const [val, label] of sylOpts) {
          menu.addItem((it) =>
            it
              .setTitle(label)
              .setChecked(this.sylFilter === val)
              .onClick(() => {
                this.sylFilter = val;
                this.renderSoundResults();
              })
          );
        }
      }
    );

    // часть речи — одиночный выбор
    const posOpts: Array<[string, string]> = [["", t("filterAll")], ["n", t("posN")], ["v", t("posV")], ["a", t("posA")], ["d", t("posD")], ["i", t("posI")]];
    this.filterMenu(
      bar,
      t("filterPos"),
      posOpts.find(([v]) => v === this.posFilter)?.[1] ?? t("filterAll"),
      this.posFilter !== "",
      (menu) => {
        for (const [val, label] of posOpts) {
          menu.addItem((it) =>
            it
              .setTitle(label)
              .setChecked(this.posFilter === val)
              .onClick(() => {
                this.posFilter = val;
                this.renderSoundResults();
              })
          );
        }
      }
    );

    // лексика — множественный выбор (тумблеры видимости слоёв, состояние запоминается)
    const lexOpts: Array<[number, string]> = [
      [0, t("lexBase")],
      [1, t("lexFreq")],
      [2, t("lexCommon")],
      [3, t("lexRare")],
    ];
    const lexOn = lexOpts.filter(([idx]) => this.plugin.settings.lexShow[idx]);
    this.filterMenu(
      bar,
      t("filterLex"),
      `${lexOn.length}/${lexOpts.length}`,
      lexOn.length < lexOpts.length,
      (menu) => {
        for (const [idx, label] of lexOpts) {
          menu.addItem((it) =>
            it
              .setTitle(label)
              .setChecked(this.plugin.settings.lexShow[idx])
              .onClick(() => {
                this.plugin.settings.lexShow[idx] = !this.plugin.settings.lexShow[idx];
                void this.plugin.saveSettings();
                this.renderSoundResults();
              })
          );
        }
      }
    );

    // «по смыслу» — тумблер: показать только рифмы, близкие по смыслу; виден, если такие есть
    if (list.some((e) => this.relatedWords.has(e.word)) || this.semanticOnly) {
      const semBtn = bar.createEl("button", { cls: "rr-semtoggle" + (this.semanticOnly ? " is-active" : ""), text: t("semanticOnly") });
      semBtn.title = t("semanticHint");
      semBtn.addEventListener("click", () => {
        this.semanticOnly = !this.semanticOnly;
        this.shown = PAGE;
        this.renderSoundResults();
      });
    }

    bar.createSpan({ cls: "rr-count", text: `${list.length}${t("rhymesCount")}` });

    const lexLabel = [t("lexBase"), t("lexFreq"), t("lexCommon"), t("lexRare")];

    // «все» + несколько видов → сворачиваемые секции по видам; иначе плоский список
    // «все» секциями, если разных видов ≥2 (аллитерация считается отдельной секцией)
    if (this.soundKind === "all" && kinds.length + (this.allitAll.length > 0 ? 1 : 0) >= 2) {
      this.renderKindSections(host, posLabel, lexLabel);
      return;
    }

    const listEl = host.createDiv({ cls: "rr-list" });
    if (list.length === 0) {
      listEl.createDiv({ cls: "rr-status", text: t("noRhymes") });
      return;
    }
    for (const e of list.slice(0, this.shown)) this.renderChip(listEl, e, posLabel, lexLabel);
    if (list.length > this.shown) {
      const more = host.createEl("button", { cls: "rr-more", text: `${t("showMore")} (${list.length - this.shown})` });
      more.addEventListener("click", () => {
        this.shown += PAGE_MORE;
        this.renderSoundResults();
      });
    }
  }

  /** Один чип-слово: клик — копия, двойной — рифмы к нему; класс по лексическому слою. */
  private renderChip(container: HTMLElement, e: RhymeEntry, posLabel: Record<string, string>, lexLabel: string[]): void {
    const lc = lexCat(e.f);
    const related = this.relatedWords.has(e.word);
    const chip = container.createEl("span", { cls: `rr-chip rr-lex${lc}` + (related ? " rr-related" : ""), text: markStress(e.word, e.s) });
    chip.title = `${t("chipHint")}${posLabel[e.p] ? " · " + posLabel[e.p] : ""} · ${lexLabel[lc]}${related ? " · " + t("relatedHint") : ""}`;
    this.attachWordActions(chip, e.word);
  }

  /** Вид «все»: каждая разновидность (точные/близкие/созвучия/ассонансы) — своя секция с заголовком. */
  private renderKindSections(host: HTMLElement, posLabel: Record<string, string>, lexLabel: string[]): void {
    const src: Array<[SoundKind, string, RhymeEntry[]]> = [
      ["exact", t("kindExact"), this.all.filter((e) => e.exact)],
      ["near", t("tabNear"), this.all.filter((e) => !e.exact)],
      ["conson", t("tabConson"), this.consAll],
      ["asson", t("tabAsson"), this.assonAll],
      ["allit", t("kindAllit"), this.allitAll],
    ];
    // фильтруем каждую секцию; пустые после фильтров пропускаем
    let firstKind: SoundKind | null = null;
    const toRender: Array<[SoundKind, string, RhymeEntry[]]> = [];
    for (const [kind, label, entries] of src) {
      const list = entries.filter((e) => this.passesFilter(e)).sort(displayCmp);
      if (list.length === 0) continue;
      if (firstKind === null) firstKind = kind;
      toRender.push([kind, label, list]);
    }
    if (toRender.length === 0) {
      host.createDiv({ cls: "rr-status", text: t("noRhymes") });
      return;
    }
    for (const [kind, label, list] of toRender) {
      // по умолчанию раскрыты точные/близкие; если их нет — раскрываем первую секцию
      const def = kind === "exact" || kind === "near" || kind === firstKind;
      this.renderKindSection(host, kind, label, list, def, posLabel, lexLabel);
    }
  }

  /** Одна сворачиваемая секция вида: заголовок со счётчиком; чипы рисуются лениво при раскрытии. */
  private renderKindSection(
    host: HTMLElement,
    kind: SoundKind,
    label: string,
    list: RhymeEntry[],
    defaultOpen: boolean,
    posLabel: Record<string, string>,
    lexLabel: string[]
  ): void {
    const details = host.createEl("details", { cls: "rr-ksec" });
    details.open = this.sectionOpen[kind] ?? defaultOpen;
    const sum = details.createEl("summary", { cls: "rr-ksec-sum" });
    sum.createSpan({ cls: "rr-ksec-label", text: label });
    sum.createSpan({ cls: "rr-ksec-count", text: String(list.length) });
    const body = details.createDiv({ cls: "rr-list" });

    const paint = (): void => {
      body.empty();
      const shown = this.sectionShown[kind] ?? PAGE;
      for (const e of list.slice(0, shown)) this.renderChip(body, e, posLabel, lexLabel);
      if (list.length > shown) {
        const more = body.createEl("button", { cls: "rr-more", text: `${t("showMore")} (${list.length - shown})` });
        more.addEventListener("click", () => {
          this.sectionShown[kind] = shown + PAGE_MORE;
          paint();
        });
      }
    };

    if (details.open) paint();
    details.addEventListener("toggle", () => {
      this.sectionOpen[kind] = details.open;
      if (details.open && body.childElementCount === 0) paint(); // ленивая отрисовка при первом раскрытии
    });
  }

  /** Кнопка-меню фильтра «подпись: значение ▾»; build наполняет выпадающее меню Obsidian. */
  private filterMenu(
    parent: HTMLElement,
    label: string,
    value: string,
    active: boolean,
    build: (menu: Menu) => void
  ): void {
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
  private renderForms(host: HTMLElement): void {
    const f = this.forms;
    if (!f || f.rows.length === 0) return;
    const details = host.createEl("details", { cls: "rr-forms" });
    details.createEl("summary", {
      cls: "rr-forms-summary",
      text: t("formsTitle") + (f.lemma ? " → " + f.lemma : ""),
    });
    const grid = details.createDiv({ cls: "rr-forms-grid" });
    for (const r of f.rows) {
      const row = grid.createDiv({ cls: "rr-form-row" });
      row.createSpan({ cls: "rr-form-label", text: r.label });
      const val = row.createSpan({ cls: "rr-form-val", text: r.form });
      val.title = t("copyHint");
      val.addEventListener("click", () => this.copyWord(stripStress(r.form)));
    }
  }

  private renderDefinitions(): void {
    const wrap = this.bodyEl.createDiv({ cls: "rr-defs" });
    this.renderForms(wrap);
    const defs = this.definitions;
    if (!defs) return;
    if (defs.lemma !== this.word) {
      wrap.createDiv({ cls: "rr-def-lemma", text: "→ " + defs.lemma });
    }
    for (const group of defs.groups) {
      const g = wrap.createDiv({ cls: "rr-def-group" });
      if (group.pos) g.createDiv({ cls: "rr-def-pos", text: group.pos });
      const ol = g.createEl("ol", { cls: "rr-def-list" });
      for (const sense of group.senses) {
        const li = ol.createEl("li");
        this.appendClickableText(li, sense.gloss);
        if (sense.examples && sense.examples.length) {
          const exWrap = li.createDiv({ cls: "rr-def-examples" });
          for (const ex of sense.examples) {
            const row = exWrap.createDiv({ cls: "rr-def-ex" });
            this.appendClickableText(row.createSpan({ cls: "rr-def-ex-text" }), ex.text);
            if (ex.ref) row.createSpan({ cls: "rr-def-ex-ref", text: " — " + ex.ref });
          }
        }
      }
    }
    // происхождение слова — отдельной секцией под значениями (только Викисловарь)
    if (defs.etymology) {
      const et = wrap.createDiv({ cls: "rr-def-etym" });
      et.createSpan({ cls: "rr-def-etym-label", text: t("defEtym") + " " });
      et.appendText(defs.etymology);
    }
    wrap.createDiv({ cls: "rr-def-src", text: t("defSource") });
  }

  /** Вписать текст, сделав каждое русское слово кликабельным (клик — искать рифмы/значение к нему). */
  private appendClickableText(parent: HTMLElement, text: string): void {
    const re = /[а-яёА-ЯЁ]+(?:-[а-яёА-ЯЁ]+)*/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendText(text.slice(last, m.index));
      const word = m[0];
      const span = parent.createSpan({ cls: "rr-defword", text: word });
      span.addEventListener("click", () => void this.showWord(word));
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendText(text.slice(last));
  }

  private chipGroup(wrap: HTMLElement, words: string[]): void {
    const row = wrap.createDiv({ cls: "rr-syn-group" });
    for (const w of words) {
      const chip = row.createEl("span", { cls: "rr-chip", text: w });
      chip.title = t("chipHint");
      this.attachWordActions(chip, w);
    }
  }

  /** Сворачиваемый подраздел «Ассоциаций»: заголовок + счётчик, тело строит build; раскрытость на сессию. */
  private semSection(host: HTMLElement, key: string, title: string, count: number, build: (body: HTMLElement) => void): void {
    const details = host.createEl("details", { cls: "rr-ssec" });
    details.open = this.semOpen[key] ?? true;
    const sum = details.createEl("summary", { cls: "rr-ssec-sum" });
    sum.createSpan({ cls: "rr-ssec-label", text: title });
    sum.createSpan({ cls: "rr-ssec-count", text: String(count) });
    build(details.createDiv({ cls: "rr-ssec-body" }));
    details.addEventListener("toggle", () => {
      this.semOpen[key] = details.open;
    });
  }

  /** Смысловой раздел: синонимы, антонимы, фразы и ассоциации под одной вкладкой, складными подразделами. */
  private renderSemantics(): void {
    const wrap = this.bodyEl.createDiv({ cls: "rr-syns" });
    const lemmaSuffix = (l: string | null): string => (l ? " → " + l : "");
    const wordCount = (groups: string[][]): number => groups.reduce((n, g) => n + g.length, 0);
    let any = false;

    // подразделы с чипами-словами (label = имя раздела + «→ лемма», счётчик = число слов)
    const chipSecs: Array<[string, string, Synonyms | null]> = [
      ["syn", t("tabSynonyms"), this.synonyms],
      ["ant", t("secAntonyms"), this.antonyms],
      ["hyper", t("secHypernyms"), this.hypernyms],
      ["hypo", t("secHyponyms"), this.hyponyms],
      ["rel", t("secRelated"), this.related],
    ];
    for (const [key, name, data] of chipSecs) {
      if (!data || data.groups.length === 0) continue;
      any = true;
      this.semSection(wrap, key, name + lemmaSuffix(data.lemma), wordCount(data.groups), (b) => {
        for (const g of data.groups) this.chipGroup(b, g);
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
          pt.title = t("copyHint");
          pt.addEventListener("click", () => this.copyWord(it.phrase));
          if (it.gloss) prow.createSpan({ cls: "rr-phrase-gloss", text: " — " + it.gloss });
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
          pt.title = t("copyHint");
          pt.addEventListener("click", () => this.copyWord(it));
        }
        b.createDiv({ cls: "rr-def-src", text: t("defSource") });
      });
    }
    const assoc = this.associations;
    if (assoc && assoc.groups.length > 0) {
      any = true;
      this.semSection(wrap, "assoc", t("tabAssoc") + lemmaSuffix(assoc.lemma), wordCount(assoc.groups), (b) => {
        for (const g of assoc.groups) this.chipGroup(b, g);
        b.createDiv({ cls: "rr-def-src", text: t("assocSource") });
      });
    }
    const tailSecs: Array<[string, string, Synonyms | null]> = [
      ["meta", t("secMetagrams"), this.metagrams],
      ["ana", t("secAnagrams"), this.anagrams],
    ];
    for (const [key, name, data] of tailSecs) {
      if (!data || data.groups.length === 0) continue;
      any = true;
      this.semSection(wrap, key, name + lemmaSuffix(data.lemma), wordCount(data.groups), (b) => {
        for (const g of data.groups) this.chipGroup(b, g);
      });
    }

    if (!any) wrap.createDiv({ cls: "rr-status", text: t("noSynonyms") });
  }

  /** Генератор-пасхалка «фристайл»: категория (сущ/прил/глаг/перс) + сколько слов, тап — ещё. */
  private renderGenerator(): void {
    // словарь ещё не грузился (мобильный, панель открыта без поиска) — подгружаем сами
    if (this.plugin.dict.status === "idle") {
      void this.plugin.dict.load().then(() => {
        if (this.tab === "gen") this.rollGen();
      });
    }
    const wrap = this.bodyEl.createDiv({ cls: "rr-gen" });
    const controls = wrap.createDiv({ cls: "rr-gen-controls" });
    const cats: Array<[GenCat, string]> = [
      ["n", t("genNoun")],
      ["a", t("genAdj")],
      ["v", t("genVerb")],
      ["char", t("genChar")],
    ];
    for (const [cat, label] of cats) {
      const b = controls.createEl("button", { cls: "rr-gen-cat" + (this.genCats.has(cat) ? " is-active" : ""), text: label });
      b.addEventListener("click", () => {
        // переключатель: можно несколько разом, но хотя бы одна должна остаться активной
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
    // переключатель числа слов ×1..×10
    const cnt = controls.createEl("button", { cls: "rr-gen-count", text: "×" + this.genCount });
    cnt.title = t("genCountHint");
    cnt.addEventListener("click", () => {
      this.genCount = this.genCount >= 10 ? 1 : this.genCount + 1;
      cnt.setText("×" + this.genCount);
      this.rollGen();
    });

    // слои лексики (базовая/частотная) — тоже множественный выбор, мин. один; к «перс» не применяются
    const tierRow = wrap.createDiv({ cls: "rr-gen-controls rr-gen-tiers" });
    const tierOpts: Array<[number, string]> = [[0, t("lexBase")], [1, t("lexFreq")]];
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

    // большое поле выдачи — тап/пробел генерирует заново (tabindex — чтобы держать фокус для пробела)
    this.genHost = wrap.createDiv({ cls: "rr-gen-display", attr: { tabindex: "0" } });
    this.genHost.addEventListener("click", () => {
      this.genHost?.focus();
      this.rollGen();
    });
    if (this.genWords.length === 0) this.genWords = this.drawGen();
    this.paintGen();
  }

  private rollGen(): void {
    this.genWords = this.drawGen();
    this.paintGen();
  }

  /** Достаёт genCount слов из «мешка»: без повторов, пока не выйдут все, затем новое перемешивание. */
  private drawGen(): string[] {
    const key = [...this.genCats].sort().join(",") + "|" + [...this.genTiers].sort().join(",");
    // пустой мешок пересобираем всегда: пул мог появиться после дозагрузки/скачивания словаря
    if (key !== this.genBagKey || this.genBag.length === 0) {
      // категории/слои изменились — новый пул и свежее перемешивание
      this.genBagKey = key;
      this.genBag = this.plugin.dict.generatorPool([...this.genCats], [...this.genTiers]);
      this.shuffleInPlace(this.genBag);
      this.genBagPos = 0;
    }
    const bag = this.genBag;
    if (bag.length === 0) return [];
    const n = Math.min(this.genCount, bag.length);
    const out: string[] = [];
    const seen = new Set<string>();
    while (out.length < n) {
      if (this.genBagPos >= bag.length) {
        // все слова показаны — перемешиваем заново
        this.shuffleInPlace(bag);
        this.genBagPos = 0;
      }
      const w = bag[this.genBagPos++];
      if (seen.has(w)) continue; // не дублируем внутри одной выдачи на стыке перемешивания
      seen.add(w);
      out.push(w);
    }
    return out;
  }

  private shuffleInPlace(a: string[]): void {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
  }

  private paintGen(): void {
    const host = this.genHost;
    if (!host) return;
    host.empty();
    if (this.genWords.length === 0) {
      host.createDiv({ cls: "rr-status", text: t("genEmpty") });
      return;
    }
    const list = host.createDiv({ cls: "rr-gen-words" });
    for (const w of this.genWords) list.createDiv({ cls: "rr-gen-word", text: w });
    host.createDiv({ cls: "rr-gen-hint", text: t("genTapHint") });
  }
}
