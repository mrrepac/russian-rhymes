import { ItemView, Menu, Notice, Platform, setIcon } from "obsidian";
import type { Editor, WorkspaceLeaf } from "obsidian";
import { VOWELS, countSyllables, looksSameRoot, markStress } from "./phonetics";
import type { Definitions, Forms, GenCat, LocalSynDict, Phrases, RhymeEntry, ShardInfo, StressVariant, StringList, Synonyms } from "./dict";
import type { RhymeDict } from "./dict";
import type { RhymesSettings } from "./main";
import { t } from "./i18n";

type TabId = "rhymes" | "meaning" | "assoc" | "gen";
type SoundKind = "all" | "exact" | "near" | "conson" | "asson" | "allit";
/** Готовые подписи для чипов одной отрисовки — см. chipLabels(). */
interface ChipLabels {
  pos: Record<string, string>;
  lex: string[];
  mood: Record<string, string>;
  sem: Record<string, string>;
  hint: string;
  related: string;
}
/*
 * Плагин описан структурно, а не импортом типа из main.ts: там класс объявлен
 * выражением (const X = class …), а такое имя типа не создаёт — и форму менять нельзя,
 * по ней тестовый стенд вынимает класс из бандла. Заодно видно, что панели от плагина нужно.
 */
interface HostPlugin {
  settings: RhymesSettings;
  // пасхалка «фристайл»: раздел генератора открыт в этом запуске. Не настройка —
  // в data.json ей делать нечего, слово вводят заново после каждого запуска
  genUnlocked: boolean;
  // тип берётся из значения: RhymeDict объявлен выражением, имени типа у него нет.
  // Импорт только типовой — esbuild его стирает, кольца в сборке не возникает
  dict: InstanceType<typeof RhymeDict>;
  getEditor(): Editor | null;
  saveSettings(): Promise<void>;
  setFollow(on: boolean): Promise<void>;
  refreshPanel(): void;
  getUserStress(word: string): number | undefined;
  setUserStress(word: string, s: number | null): void;
  warnBadDicts(): void;
  warnMissingShards(): void;
  downloadDict(onProgress?: (done: number, total: number) => void): Promise<{ ok: boolean; failed: string[] }>;
}

const VIEW_TYPE_RHYMES = "russian-rhymes-view";
const stripStress = (s: string) => s.replace(/́/g, "");
const POS_LABEL = (): Record<string, string> => ({
  n: t("posN"),
  v: t("posV"),
  a: t("posA"),
  d: t("posD"),
  i: t("posI"),
  x: ""
});
const lexCat = (f: number) => f >= 5 ? 0 : f >= 3 ? 1 : f >= 1 ? 2 : 3;
/**
 * Клаузула: сколько слогов в окончании, считая от ударного. s — индекс ударной гласной
 * в слове, поэтому это просто число гласных в хвосте. 1 — мужская (дом, окно), 2 —
 * женская (до́ма, сту́жа), 3 — дактилическая (де́вочка), больше — гипердактилическая.
 */
const clausulaOf = (word: string, s: number) => countSyllables(word.slice(s));
const clausula = (e: RhymeEntry) => clausulaOf(e.word, e.s);
/**
 * Название шарда. Перечислено вручную, а не собрано из ключа: t() принимает только
 * существующие ключи, и склеенный ключ такой проверки не проходит. Таблица строится
 * на каждый вызов — язык берётся из moment в момент обращения.
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
    sentiment: t("shardSentiment"),
    semantics: t("shardSemantics"),
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
/**
 * Список файлов словаря — один на настройки и на панель. Живёт тут, а не в main.ts,
 * потому что панель идёт в сборке раньше: обратный импорт замкнул бы кольцо.
 * withTotal — строка итога; в панели её роль играет заголовок свёрнутого блока.
 */
function renderShardList(host: HTMLElement, inv: ShardInfo[], withTotal: boolean) {
  let have = 0, bytes = 0;
  for (const s of inv) {
    const row = host.createDiv({ cls: "rr-shardrow" });
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
  if (withTotal)
    host.createDiv({ cls: "rr-shard-note", text: `${t("invTotal")} ${have}/${inv.length} \xB7 ${fmtSize(bytes)}` });
  if (have < inv.length)
    host.createDiv({ cls: "rr-shard-note rr-shard-bad", text: t("invHint") });
}
const CLAUS_LABEL = (): Record<number, string> => ({
  1: t("clausM"),
  2: t("clausF"),
  3: t("clausD"),
  4: t("clausH")
});
// тональность слова (КартаСлов): порядок задаёт и порядок пунктов меню
const MOOD_KEYS = ["p", "n", "u"];
const MOOD_LABEL = (): Record<string, string> => ({
  p: t("moodLight"),
  n: t("moodDark"),
  u: t("moodPlain")
});
// смысловые категории (КартаСлов, облегчённая разметка): x и d — абстрактное, остальное конкретное.
// Порядок — от крупных к мелким, меню строится по нему
const SEM_KEYS = ["h", "t", "p", "a", "r", "f", "s", "v", "b", "c", "x", "d"];
const SEM_ABSTRACT = ["x", "d"];
const SEM_LABEL = (): Record<string, string> => ({
  h: t("semHuman"),
  t: t("semThing"),
  p: t("semPlace"),
  a: t("semAnimal"),
  r: t("semPlant"),
  f: t("semFood"),
  s: t("semSubstance"),
  v: t("semTransport"),
  b: t("semAnatomy"),
  c: t("semConstruction"),
  x: t("semAbstract"),
  d: t("semAction")
});
// две сборные группы поверх категорий: ради них слой и брали
const SEM_CONCRETE_ALL = "+";
const SEM_ABSTRACT_ALL = "-";
const PAGE = 50;
const PAGE_MORE = 200;
// допустимые значения запоминаемых фильтров — data.json правят и руками
const POS_KEYS = ["", "n", "v", "a", "d", "i"];
const KIND_KEYS = ["all", "exact", "near", "conson", "asson", "allit"];
const MOOD_FILTER_KEYS = ["", ...MOOD_KEYS];
const SEM_FILTER_KEYS = ["", SEM_CONCRETE_ALL, SEM_ABSTRACT_ALL, ...SEM_KEYS];
// что грузить при старте: ничего / первую волну / обе. Толкования и формы — 360 МБ
// из ~500 МБ всего словаря, поэтому выбор заметно меняет цену запуска
const STARTUP_KEYS = ["none", "rhymes", "full"];
// копилка: сколько последних взятых слов помним. Больше в черновик одной песни и не нужно,
// а список, который не влезает на экран, перестаёт читаться
const STASH_MAX = 60;
// вставка слова в заметку: Alt+клик на десктопе, долгое нажатие на телефоне
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;
// одно и то же слово, скопированное дважды подряд (двойной клик = провал в слово), не
// должно давать два уведомления подряд
const COPY_NOTICE_MS = 600;
const insertHint = () => t(Platform.isMobile ? "insertHintTouch" : "insertHint");
// перетаскивание — мышиный жест: на телефоне о нём говорить незачем
const dragHint = () => Platform.isMobile ? "" : " \xB7 " + t("dragHint");
// подсказка к кнопке «качество»: чем один вид созвучия отличается от другого
const KIND_HINT = (): Partial<Record<SoundKind, string>> => ({
  all: t("kindAllHint"),
  exact: t("rhymesHint"),
  near: t("nearHint"),
  conson: t("consonHint"),
  asson: t("assonHint"),
  allit: t("allitHint")
});
const displayCmp = (a: RhymeEntry, b: RhymeEntry) => lexCat(a.f) - lexCat(b.f) || a.word.localeCompare(b.word, "ru");
/** Подпись выбранного значения фильтра; выбор вне списка показываем как «все». */
function optLabel<V>(opts: [V, string][], value: V) {
  const hit = opts.find(([v]) => v === value);
  return hit ? hit[1] : t("filterAll");
}
const RhymesView = class extends ItemView {
  plugin: HostPlugin;
  word: string;
  variants: StressVariant[];
  stress: number | null; // индекс ударной гласной (словарный или ручной)
  all: RhymeEntry[];
  consAll: RhymeEntry[];
  assonAll: RhymeEntry[];
  allitAll: RhymeEntry[];
  tab: TabId;
  soundKindPref: SoundKind; // что выбрал пользователь — держится при смене слова
  soundKind: SoundKind; // и он же эффективный: падает в «все» там, где вида нет
  synonyms: Synonyms | null;
  localSyns: LocalSynDict[];
  antonyms: Synonyms | null;
  hypernyms: Synonyms | null;
  hyponyms: Synonyms | null;
  related: Synonyms | null;
  associations: Synonyms | null;
  metagrams: Synonyms | null;
  anagrams: Synonyms | null;
  definitions: Definitions | null;
  forms: Forms | null;
  phrases: Phrases | null;
  idioms: StringList | null;
  proverbs: StringList | null;
  relatedWords: Set<string>;
  sylFilter: number; // 0 = все, 4 = 4+
  clausFilter: number; // 0 = все, 1 мужская, 2 женская, 3 дактилическая, 4 гипердактилическая
  clausOn: number; // он же, но действующий: 0 там, где клаузула у всех одна (см. renderSoundResults)
  posFilter: string; // '' = все
  moodFilter: string; // '' = все, иначе код из MOOD_KEYS
  moodOn: string; // он же действующий: '' там, где капсулы нет (см. renderSoundResults)
  semFilter: string; // '' = все, '+' конкретное, '-' абстрактное, иначе код из SEM_KEYS
  semOn: string; // он же действующий
  // пометы кандидатов текущего слова: считаются один раз в loadRhymes, а не на каждый фильтр
  moodMap: Map<string, string>;
  semMap: Map<string, string>;
  // копилка: что вы за сессию скопировали или вставили. Не настройка и не данные —
  // черновик, поэтому живёт на панели, а не в data.json
  stash: string[];
  stashOpen: boolean;
  stashHost: HTMLElement | null;
  semanticOnly: boolean;
  shown: number;
  sectionOpen: Partial<Record<SoundKind, boolean>>;
  sectionShown: Partial<Record<SoundKind, number>>;
  semOpen: Record<string, boolean>;
  navStack: string[];
  navPos: number;
  navigating: boolean; // true во время перехода назад — чтобы не писать в историю
  genCats: Set<GenCat>;
  genTiers: Set<number>; // 0 базовая, 1 частотная
  genCount: number;
  genWords: string[];
  genHost: HTMLElement | null;
  genBag: string[];
  genBagPos: number;
  genBagKey: string;
  resultsHost: HTMLElement | null;
  copyTimers: Set<number>;
  // номер текущего показа слова: showWord ждёт словарь и блочные шарды, а за время
  // ожидания слово могут сменить (слежение за курсором, двойной клик по чипу). Устаревший
  // показ обязан выйти молча, иначе панель склеивала бы данные двух разных слов
  loadSeq: number;
  // объединённый список текущего вида: за одну отрисовку он нужен четырежды (разброс
  // клаузул, счётчики двух помет, сама выдача), а в виде «все» это склейка до 11 тыс. слов
  soundEpoch: number;
  soundCacheKey: string;
  soundCacheList: RhymeEntry[] | null;
  // последнее скопированное слово и когда — чтобы не показывать два уведомления подряд
  lastCopied: string;
  lastCopiedAt: number;
  // элементы шапки: создаются в onOpen, до него их нет
  inputEl!: HTMLInputElement;
  clearBtn!: HTMLElement;
  followBtn!: HTMLElement;
  bodyEl!: HTMLElement;

  // отложенные таймеры клика (копия) и долгого нажатия (вставка) — гасим при закрытии/перерисовке
  constructor(leaf: WorkspaceLeaf, plugin: HostPlugin) {
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
    // сколько слогов занимает окончание, считая от ударного: 1 мужская, 2 женская,
    // 3 дактилическая, 4 гипердактилическая. Строка ложится в размер или нет именно по нему
    this.clausFilter = 0;
    this.clausOn = 0;
    this.posFilter = "";
    // '' = все
    // тональность и смысловая категория кандидата (КартаСлов): в отличие от клаузулы это
    // свойство самого кандидата, поэтому фильтр здесь и осмыслен
    this.moodFilter = "";
    this.moodOn = "";
    this.semFilter = "";
    this.semOn = "";
    this.moodMap = /* @__PURE__ */ new Map();
    this.semMap = /* @__PURE__ */ new Map();
    this.stash = [];
    this.stashOpen = false;
    this.stashHost = null;
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
    this.loadSeq = 0;
    this.soundEpoch = 0;
    this.soundCacheKey = "";
    this.soundCacheList = null;
    this.lastCopied = "";
    this.lastCopiedAt = 0;
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
      // instanceOf вместо instanceof: панель могут вынести в отдельное окно, а там
      // свои конструкторы DOM, и обычная проверка на класс промахнётся
      if (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || (ae.instanceOf(HTMLElement) && ae.isContentEditable))
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
  async showWord(raw: string) {
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
    // \u043F\u0430\u0441\u0445\u0430\u043B\u043A\u0430 \u0436\u0438\u0432\u0451\u0442 \u0434\u043E \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A\u0430: \u0432 data.json \u043D\u0435 \u043F\u0438\u0448\u0435\u043C, \u0441\u043B\u043E\u0432\u043E \u0432\u0432\u043E\u0434\u044F\u0442 \u0437\u0430\u043D\u043E\u0432\u043E
    if (this.word === "\u0444\u0440\u0438\u0441\u0442\u0430\u0439\u043B")
      this.plugin.genUnlocked = true;
    this.soundKind = this.soundKindPref;
    this.shown = PAGE;
    // всё, что ниже, идёт через ожидания: словарь, блочные толкования, формы. Пока они
    // идут, слово могли сменить — такой показ обязан прекратиться, иначе в панели
    // окажутся рифмы к одному слову и значения к другому
    const seq = ++this.loadSeq;
    const dict = this.plugin.dict;
    if (dict.status !== "ready") {
      this.renderStatus(t("dictLoading"));
      await dict.load();
      if (seq !== this.loadSeq)
        return;
      // сюда попадаем, если слово запросили раньше, чем догрузилась первая волна;
      // про сломанные личные словари и недостающие файлы словаря узнаём тут же
      this.plugin.warnBadDicts();
      this.plugin.warnMissingShards();
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
    const defs = await dict.definitionsFor(this.word);
    const forms = await dict.formsFor(this.word);
    if (seq !== this.loadSeq)
      return;
    this.definitions = defs;
    this.forms = forms;
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
    // списки под словом сменились — объединение, посчитанное для прежнего слова, недействительно
    this.soundEpoch++;
    this.allitAll = this.plugin.dict.alliterationsFor(this.word);
    if (this.stress === null) {
      // без ударения рифм не собрать, но аллитерации собраны — пометы им всё равно нужны
      this.all = [];
      this.consAll = [];
      this.assonAll = [];
    } else {
      this.all = this.plugin.dict.rhymesFor(this.word, this.stress);
      const scan = this.plugin.dict.assonancesFor(this.word, this.stress);
      this.consAll = scan.conson;
      this.assonAll = scan.asson;
    }
    this.loadTraits();
  }
  /**
   * Пометы всех кандидатов сразу. Считаем здесь, а не в passesFilter: фильтр вызывается на
   * каждую перерисовку и на каждое слово списка, а поиск пометы — двоичный поиск плюс, при
   * промахе, обращение к леммам. Списка нет — карты пустые, и капсулы не появятся.
   */
  loadTraits() {
    this.moodMap = /* @__PURE__ */ new Map();
    this.semMap = /* @__PURE__ */ new Map();
    const dict = this.plugin.dict;
    const wantMood = !!dict.sentiment;
    const wantSem = !!dict.semantics;
    if (!wantMood && !wantSem)
      return;
    for (const arr of [this.all, this.consAll, this.assonAll, this.allitAll]) {
      for (const e of arr) {
        if (wantMood && !this.moodMap.has(e.word))
          this.moodMap.set(e.word, dict.sentimentOf(e.word));
        if (wantSem && !this.semMap.has(e.word))
          this.semMap.set(e.word, dict.semanticsOf(e.word));
      }
    }
  }
  /** Подпись значения фильтра категорий: сборные группы своих подписей в SEM_LABEL не имеют. */
  semFilterLabel(code: string) {
    if (code === SEM_CONCRETE_ALL)
      return t("semConcreteAll");
    if (code === SEM_ABSTRACT_ALL)
      return t("semAbstractAll");
    return SEM_LABEL()[code] || "";
  }
  /** Выбор в меню помет. Как и остальные фильтры — липкий, с перемоткой списка в начало. */
  setTrait(which: "mood" | "sem", value: string) {
    if (which === "mood")
      this.moodFilter = value;
    else
      this.semFilter = value;
    this.shown = PAGE;
    this.saveFilters();
    this.renderSoundResults();
  }
  /** Категория кандидата с учётом сборных групп «конкретное»/«абстрактное». */
  semMatches(word: string, want: string) {
    const code = this.semMap.get(word);
    if (!code)
      return false;
    if (want === SEM_CONCRETE_ALL)
      return !SEM_ABSTRACT.includes(code);
    if (want === SEM_ABSTRACT_ALL)
      return SEM_ABSTRACT.includes(code);
    return code === want;
  }
  /** Текущая вкладка опустела на новом слове/ударении — уйти на первую непустую. */
  ensureValidTab() {
    let _a;
    const tabs = this.availableTabs();
    if (!tabs.includes(this.tab))
      this.tab = (_a = tabs[0]) != null ? _a : "rhymes";
  }
  /** Виды созвучий, у которых есть данные, — для меню «качество» внутри «Рифм». */
  availableKinds(): [SoundKind, string][] {
    const kinds: [SoundKind, string][] = [];
    if (this.all.some((e) => e.exact))
      kinds.push(["exact", t("kindExact")]);
    if (this.all.some((e) => !e.exact))
      kinds.push(["near", t("tabNear")]);
    if (this.consAll.length > 0)
      kinds.push(["conson", t("tabConson")]);
    if (this.assonAll.length > 0)
      kinds.push(["asson", t("tabAsson")]);
    return kinds;
  }
  /**
   * Список для текущего вида: конкретный вид или «все» — объединение без повторов,
   * сильные сверху. Результат держим до смены слова, ударения или вида: за одну отрисовку
   * список спрашивают четыре раза, и в виде «все» это была бы четырёхкратная склейка
   * тысяч слов. Возвращённый массив только читают — сортируют уже копию (см. filtered).
   */
  soundList(): RhymeEntry[] {
    const ck = `${this.soundEpoch}:${this.soundKind}`;
    if (this.soundCacheKey === ck && this.soundCacheList)
      return this.soundCacheList;
    const list = this.buildSoundList();
    this.soundCacheKey = ck;
    this.soundCacheList = list;
    return list;
  }
  buildSoundList(): RhymeEntry[] {
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
        const seen = /* @__PURE__ */ new Set<string>();
        const out: RhymeEntry[] = [];
        const push = (arr: RhymeEntry[]) => {
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
  async followWord(raw: string) {
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
    const list: TabId[] = [];
    if (this.stress === null) {
      list.push("rhymes");
    } else if (this.all.length > 0 || this.consAll.length > 0 || this.assonAll.length > 0 || this.allitAll.length > 0) {
      list.push("rhymes");
    }
    // пока вторая волна не приехала, про формы и толкования ничего не известно — вкладку
    // держим доступной, иначе до неё нельзя было бы дотянуться, чтобы её же и загрузить
    if (!this.plugin.dict.heavyReady() || this.definitions && this.definitions.groups.length > 0 || this.forms && this.forms.rows.length > 0)
      list.push("meaning");
    const hasSem = this.localSyns.length > 0 || this.synonyms && this.synonyms.groups.length > 0 || this.antonyms && this.antonyms.groups.length > 0 || this.hypernyms && this.hypernyms.groups.length > 0 || this.hyponyms && this.hyponyms.groups.length > 0 || this.related && this.related.groups.length > 0 || this.idioms && this.idioms.items.length > 0 || this.phrases && this.phrases.items.length > 0 || this.proverbs && this.proverbs.items.length > 0 || this.associations && this.associations.groups.length > 0 || this.metagrams && this.metagrams.groups.length > 0 || this.anagrams && this.anagrams.groups.length > 0;
    if (hasSem)
      list.push("assoc");
    if (this.plugin.genUnlocked)
      list.push("gen");
    return list;
  }
  /** Ctrl+←/→: переход к соседнему доступному разделу (циклически). */
  cycleTab(dir: number) {
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
  setStress(i: number) {
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
    const set = /* @__PURE__ */ new Set<string>();
    const w0 = this.word;
    const add = (s: Synonyms | null) => {
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
  passesFilter(e: RhymeEntry) {
    if (this.semanticOnly && !this.relatedWords.has(e.word))
      return false;
    if (!this.plugin.settings.lexShow[lexCat(e.f)])
      return false;
    if (this.sylFilter === 4 && e.syl < 4)
      return false;
    if (this.sylFilter >= 1 && this.sylFilter <= 3 && e.syl !== this.sylFilter)
      return false;
    if (this.clausOn) {
      const c = clausula(e);
      if (this.clausOn === 4 ? c < 4 : c !== this.clausOn)
        return false;
    }
    if (this.posFilter && e.p !== this.posFilter)
      return false;
    if (this.moodOn && this.moodMap.get(e.word) !== this.moodOn)
      return false;
    if (this.semOn && !this.semMatches(e.word, this.semOn))
      return false;
    return true;
  }
  filtered() {
    return this.soundList().filter((e) => this.passesFilter(e)).sort(displayCmp);
  }
  /**
   * Клаузула самого слова. Ею всё и определяется: рифма ищется от ударной гласной,
   * поэтому у каждой найденной рифмы окончание будет ровно такой же длины.
   */
  wordClausula() {
    return this.stress === null ? 0 : clausulaOf(this.word, this.stress);
  }
  /**
   * Есть ли в текущем списке окончания разной длины. Ответ «нет» — обычное дело: рифмы,
   * созвучия и ассонансы подбираются от ударной гласной, поэтому клаузула у них у всех
   * ровно такая же, как у самого слова. Разнобой даёт только список аллитераций (он
   * собран по началу слова) и, значит, вид «все».
   */
  clausSpread() {
    const list = this.soundList();
    if (list.length === 0)
      return false;
    const first = clausula(list[0]);
    return list.some((e) => clausula(e) !== first);
  }
  /**
   * Сколько кандидатов текущего списка попадает в каждое значение пометы. По этому и строится
   * меню: предлагать «светлые», когда светлых в списке нет, — способ показать пустую выдачу.
   * Неразмеченные слова не считаются нигде: КартаСлов покрывает около 40% списка рифм по
   * тональности и 30% по категориям, и это честнее показать числом рядом с пунктом.
   */
  traitCounts(map: Map<string, string>, keys: string[]) {
    const counts = /* @__PURE__ */ new Map<string, number>();
    for (const e of this.soundList()) {
      const code = map.get(e.word);
      if (!code || !keys.includes(code))
        continue;
      counts.set(code, (counts.get(code) || 0) + 1);
    }
    return counts;
  }
  /**
   * Фильтры выдачи липкие: пишешь строку в размер — «2 слога» и часть речи держатся
   * при переходе к следующему слову и при слежении за курсором. Сбрасывает их только
   * кнопка в ряду фильтров и очистка поиска.
   */
  clearFilters() {
    this.sylFilter = 0;
    this.clausFilter = 0;
    this.clausOn = 0;
    this.posFilter = "";
    this.moodFilter = "";
    this.moodOn = "";
    this.semFilter = "";
    this.semOn = "";
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
    this.clausFilter = Number.isInteger(s.filterClaus) && s.filterClaus >= 0 && s.filterClaus <= 4 ? s.filterClaus : 0;
    this.posFilter = POS_KEYS.includes(s.filterPos) ? s.filterPos : "";
    // data.json правят руками, поэтому вид созвучия сверяем со списком, а не верим на слово
    const isKind = (v: string): v is SoundKind => KIND_KEYS.includes(v);
    this.soundKindPref = isKind(s.filterKind) ? s.filterKind : "all";
    this.soundKind = this.soundKindPref;
    this.moodFilter = MOOD_FILTER_KEYS.includes(s.filterMood) ? s.filterMood : "";
    this.semFilter = SEM_FILTER_KEYS.includes(s.filterSem) ? s.filterSem : "";
    this.semanticOnly = s.filterSemantic === true;
  }
  /** Запомнить фильтры — как и слои лексики, пишем на каждый клик по фильтру. */
  saveFilters() {
    const s = this.plugin.settings;
    s.filterSyl = this.sylFilter;
    s.filterClaus = this.clausFilter;
    s.filterPos = this.posFilter;
    s.filterKind = this.soundKindPref;
    s.filterMood = this.moodFilter;
    s.filterSem = this.semFilter;
    s.filterSemantic = this.semanticOnly;
    void this.plugin.saveSettings();
  }
  /** Есть ли что сбрасывать (слой лексики — глобальная настройка, её не трогаем). */
  filtersActive() {
    return this.sylFilter !== 0 || this.clausFilter !== 0 || this.posFilter !== "" ||
      this.moodFilter !== "" || this.semFilter !== "" || this.semanticOnly || this.soundKindPref !== "all";
  }
  /** Пусто: если виноваты фильтры — предложить сброс прямо в сообщении. */
  renderEmpty(host: HTMLElement) {
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
  renderStatus(msg: string) {
    this.bodyEl.empty();
    // ссылки на вычищенные узлы держать нельзя: копилка дорисовывает себя по месту,
    // и с оторванным хостом она рисовалась бы в никуда
    this.resultsHost = null;
    this.stashHost = null;
    this.bodyEl.createDiv({ cls: "rr-status", text: msg });
  }
  /** Экран «нет словаря»: пояснение + кнопка скачивания с прогрессом (мобильный/новая установка). */
  renderMissing() {
    this.bodyEl.empty();
    this.resultsHost = null;
    this.stashHost = null;
    const box = this.bodyEl.createDiv({ cls: "rr-missing" });
    box.createDiv({ cls: "rr-status", text: t("dictMissing") });
    const btn = box.createEl("button", { cls: "rr-add-btn", text: t("dlDict") });
    const prog = box.createDiv({ cls: "rr-dl-progress" });
    btn.addEventListener("click", () => void this.downloadFromPanel(btn, prog));
    // «нет словаря» — не всегда «нет ничего»: чаще оборвалась закачка. Список показывает,
    // что уже лежит на диске, и докачивать придётся не всё
    this.renderShardBox(box);
  }
  /**
   * Свёрнутый список файлов словаря. Тот же, что в настройках, но замечают недостачу
   * именно тут: вкладка пуста, и вопрос «а всё ли скачалось» возникает в панели, а не
   * в настройках. Читается с диска, поэтому заголовок и строки появляются после ответа.
   */
  renderShardBox(host: HTMLElement) {
    const box = host.createEl("details", { cls: "rr-shards-box" });
    const sum = box.createEl("summary", { cls: "rr-shards-sum", text: t("invFiles") });
    const listEl = box.createDiv({ cls: "rr-shards" });
    listEl.createDiv({ cls: "rr-shard-note", text: t("invLoading") });
    void this.plugin.dict.inventory().then((inv) => {
      const have = inv.filter((s) => s.present && !s.broken).length;
      sum.setText(`${t("invFiles")}: ${have}/${inv.length}`);
      listEl.empty();
      renderShardList(listEl, inv, false);
    });
  }
  /**
   * Строка копилки — свёрнутый блок под разделами, как список файлов словаря. Пустая копилка
   * не рисуется вовсе: она наполняется сама, и до первого взятого слова её быть не должно.
   */
  renderStashRow() {
    const host = this.stashHost;
    if (!host)
      return;
    host.empty();
    if (this.stash.length === 0)
      return;
    const box = host.createEl("details", { cls: "rr-stash-box" });
    box.open = this.stashOpen;
    box.addEventListener("toggle", () => {
      this.stashOpen = box.open;
    });
    box.createEl("summary", { cls: "rr-stash-sum", text: `${t("stashTitle")}: ${this.stash.length}` });
    const listEl = box.createDiv({ cls: "rr-stash" });
    for (const w of this.stash) {
      const chip = listEl.createSpan({ cls: "rr-chip rr-stash-chip", text: w });
      chip.title = t("stashRemoveHint") + dragHint();
      // копилка — то место, откуда слово тащат в текст: она и собрана из уже взятого.
      // Заносить обратно в неё же нечего, поэтому remember=false
      this.attachDrag(chip, w, false);
      // клик убирает: копилка набирается кликами, и разбирается пусть так же
      chip.addEventListener("click", () => this.stashRemove(w));
    }
    const row = box.createDiv({ cls: "rr-stash-actions" });
    const ins = row.createEl("button", { cls: "rr-fbtn", text: t("stashInsert") });
    ins.addEventListener("click", () => this.insertList(this.stashText()));
    const copy = row.createEl("button", { cls: "rr-fbtn", text: t("stashCopy") });
    copy.addEventListener("click", () => {
      void this.writeClipboard(this.stashText()).then((ok) => {
        new Notice(ok ? t("stashCopied") + this.stash.length : t("copyFail"));
      });
    });
    const clr = row.createEl("button", { cls: "rr-fclear", text: t("stashClear") });
    clr.addEventListener("click", () => this.stashClear());
  }
  /**
   * Вписать в заметку многострочный текст (копилку, список рифм). Отдельно от insertWord:
   * тот подменяет слово под курсором — за этим его и зовут из чипа, — а списку надо встать
   * на место курсора и ничего не съесть. С новой строки, если в текущей уже что-то есть.
   */
  insertList(text: string) {
    if (!text)
      return;
    const editor = this.plugin.getEditor();
    if (!editor) {
      new Notice(t("noEditor"));
      return;
    }
    // не в позицию курсора, а в конец его строки: курсор может стоять посреди слова,
    // и вставка на месте разрезала бы его пополам
    const at = editor.getCursor("to");
    const line = editor.getLine(at.line);
    const end = { line: at.line, ch: line.length };
    const out = (line.trim() ? "\n" : "") + text + "\n";
    editor.replaceRange(out, end, end);
    const lines = out.split("\n");
    editor.setCursor({ line: at.line + lines.length - 1, ch: lines[lines.length - 1].length });
    if (!Platform.isMobile)
      editor.focus();
    new Notice(t("stashInserted") + text.split("\n").length);
  }
  /** Скачивание словаря по кнопке с экрана «нет словаря». */
  async downloadFromPanel(btn: HTMLButtonElement, prog: HTMLElement) {
    btn.disabled = true;
    prog.setText(t("dlProgress"));
    const res = await this.plugin.downloadDict((done, total) => prog.setText(`${t("dlProgress")} ${done}/${total}`));
    if (res.ok) {
      // часть файлов могла не дойти: словарь при этом работает, но молчать об этом нельзя
      if (res.failed.length)
        new Notice(t("dlFailedFiles") + res.failed.join(", "), 1e4);
      if (this.word)
        await this.showWord(this.word);
      else
        this.renderBody();
    } else {
      btn.disabled = false;
      prog.setText(t("dlFailed"));
    }
  }
  /**
   * Копилка — слова, которые вы за сессию скопировали или вставили в заметку. Отдельного
   * жеста «отложить» нет намеренно: свободных жестов у чипа не осталось (клик — копия,
   * двойной — провал в рифмы, Alt/долгое нажатие — вставка), а на телефоне их и подавно.
   * Клик по слову и так означает «это я беру» — копилка просто помнит, что вы брали.
   * Живёт до перезапуска: это черновик под одну песню, а не данные, которым место в data.json
   * и в синхронизации.
   */
  stashAdd(w: string) {
    const word = stripStress(w);
    if (!word)
      return;
    // повтор поднимаем наверх, а не заводим второй: список читается как «что я набрал»
    const at = this.stash.indexOf(word);
    if (at >= 0)
      this.stash.splice(at, 1);
    this.stash.unshift(word);
    if (this.stash.length > STASH_MAX)
      this.stash.length = STASH_MAX;
    this.renderStashRow();
  }
  stashRemove(w: string) {
    const at = this.stash.indexOf(w);
    if (at >= 0)
      this.stash.splice(at, 1);
    this.renderStashRow();
  }
  stashClear() {
    this.stash = [];
    this.renderStashRow();
  }
  /** Копилка списком: по слову в строке — так её и кладут в заметку. */
  stashText() {
    return this.stash.join("\n");
  }
  /** Копировать слово в буфер с уведомлением — «Скопировано» только при реальном успехе. */
  copyWord(w: string) {
    // двойной клик по чипу = провал в слово, но первый его клик уже скопировал. Копию
    // не отменяем (буфер и должен держать это слово), а второе уведомление подряд гасим
    const again = w === this.lastCopied && Date.now() - this.lastCopiedAt < COPY_NOTICE_MS;
    this.lastCopied = w;
    this.lastCopiedAt = Date.now();
    void this.writeClipboard(w).then((ok) => {
      if (!ok)
        new Notice(t("copyFail"));
      else if (!again)
        new Notice(t("copied") + w);
      if (ok)
        this.stashAdd(w);
    });
  }
  /** Async Clipboard, иначе фолбэк execCommand: мобильный webview часто отклоняет
   * navigator.clipboard (тем более из setTimeout) — без фолбэка копия молча терялась. */
  async writeClipboard(w: string) {
    try {
      if (typeof navigator.clipboard?.writeText === "function") {
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
  insertWord(text: string) {
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
    this.stashAdd(text);
  }
  /**
   * Долгое нажатие по слову (телефон, где нет Alt) — вставка в заметку. Возвращает флаг
   * fired: клик, который webview пришлёт следом за нажатием, надо погасить.
   */
  attachLongPressInsert(el: HTMLElement, text: string) {
    const state = { fired: false };
    let press: number | null = null, px = 0, py = 0;
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
      (e: TouchEvent) => {
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
      (e: TouchEvent) => {
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
  /**
   * Перетаскивание слова в заметку. Ничего своего тут не нужно: редактор Obsidian —
   * обычный приёмник html5-перетаскивания и вставляет text/plain ровно в ту точку, куда
   * бросили. Поэтому мышью слово можно положить в середину строки, чего не умеют ни
   * копия, ни Alt+клик (тот подменяет слово под курсором).
   * remember — заносить ли слово в копилку по успешному броску; у самой копилки не надо.
   */
  attachDrag(el: HTMLElement, text: string, remember = true) {
    el.setAttr("draggable", "true");
    el.addEventListener("dragstart", (e: DragEvent) => {
      if (!e.dataTransfer)
        return;
      e.dataTransfer.setData("text/plain", text);
      e.dataTransfer.effectAllowed = "copy";
      el.addClass("is-dragging");
    });
    el.addEventListener("dragend", (e: DragEvent) => {
      el.removeClass("is-dragging");
      // «none» — бросили мимо (в пустоту, в другое окно): считать это взятым словом нельзя
      if (remember && e.dataTransfer && e.dataTransfer.dropEffect !== "none")
        this.stashAdd(text);
    });
  }
  /** Клик — копировать, Alt+клик или долгое нажатие — вставить в заметку (без поиска по двойному клику). */
  attachCopyInsert(el: HTMLElement, text: string) {
    const lp = this.attachLongPressInsert(el, text);
    this.attachDrag(el, text);
    el.addEventListener("click", (e: MouseEvent) => {
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
  /**
   * Клик — копировать, двойной клик — искать рифмы к этому слову. Копия срабатывает
   * сразу: раньше она ждала 200 мс, чтобы двойной клик не копировал, и эта задержка
   * висела на каждом взятом слове. Двойной клик теперь просто копирует то слово, в
   * которое проваливается, — второе уведомление гасит copyWord.
   */
  attachWordActions(el: HTMLElement, word: string) {
    const lp = this.attachLongPressInsert(el, word);
    this.attachDrag(el, word);
    el.addEventListener("click", (e: MouseEvent) => {
      if (lp.fired) {
        lp.fired = false;
        return;
      }
      if (e.altKey)
        this.insertWord(word);
      else
        this.copyWord(word);
    });
    el.addEventListener("dblclick", () => void this.showWord(word));
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
    // клаузула самого слова: рифмы к нему все будут такими же, значит это и есть ответ
    // на вопрос «во что ложится строка». Пишем «женская рифма», а не одно прилагательное:
    // рядом стоит часть речи, и «женская» читалось бы как род
    const claus = this.wordClausula();
    if (claus > 0) {
      const sp = wrap.createSpan({ cls: "rr-claus", text: " \xB7 " + CLAUS_LABEL()[Math.min(claus, 4)] + " " + t("clausRhyme") });
      sp.setAttr("title", t("clausHint"));
    }
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
  renderTabs(avail: Set<TabId>) {
    const tabsWrap = this.bodyEl.createDiv({ cls: "rr-bigtabs" });
    const row = tabsWrap.createDiv({ cls: "rr-bigtab-row" });
    const defs: [TabId, string][] = [
      ["rhymes", t("tabRhymes")],
      ["meaning", t("tabMeaning")],
      ["assoc", t("tabAssoc")]
    ];
    if (this.plugin.genUnlocked)
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
    this.stashHost = null;
    if (!this.word) {
      if (!this.plugin.genUnlocked) {
        this.bodyEl.createDiv({ cls: "rr-status", text: t("emptyHint") });
        // копилку очистка поиска не трогает: набранное за сессию не должно пропадать
        // от того, что вы стёрли слово в поле
        this.stashHost = this.bodyEl.createDiv();
        this.renderStashRow();
        return;
      }
      this.renderTabs(/* @__PURE__ */ new Set<TabId>(["gen"]));
      if (this.tab === "gen")
        this.renderGenerator();
      else
        this.bodyEl.createDiv({ cls: "rr-status", text: t("emptyHint") });
      return;
    }
    this.renderWordHeader();
    this.renderTabs(new Set(this.availableTabs()));
    // копилка — над содержимым раздела, а не внутри: слова берут и из «Ассоциаций» тоже
    this.stashHost = this.bodyEl.createDiv();
    this.renderStashRow();
    // чего-то из словаря нет на диске — говорим об этом прямо под разделами, свёрнутой
    // строкой: приглушённая вкладка сама по себе причину не объясняет. Всё на месте —
    // строки нет вовсе, чтобы не мозолить глаза
    if (this.plugin.dict.missingShards.length > 0)
      this.renderShardBox(this.bodyEl);
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
    let _a, _b;
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
    // клаузула — свойство запроса, а не кандидата: рифма ищется от ударной гласной, значит
    // у всех рифм к одному слову окончание одной длины. Различается она только там, где
    // список собран не по хвосту — в аллитерациях и, стало быть, в виде «все». Поэтому
    // фильтр включается сам, а не молча режет выдачу там, где режет либо всё, либо ничего
    const clausVaries = this.clausSpread();
    this.clausOn = clausVaries ? this.clausFilter : 0;
    // а вот тональность и смысловая категория — свойства именно кандидата, поэтому здесь
    // фильтр и осмыслен. Пометы КартаСлов покрывают список не целиком (около 40% и 30%),
    // так что предлагаем только те значения, которые в списке реально есть, и с числом:
    // видно заранее, сколько слов останется. Липкий выбор, которого в списке нет, не
    // действует — иначе выдача была бы пуста, а причина не видна
    const L = this.chipLabels();
    const moodCounts = this.traitCounts(this.moodMap, MOOD_KEYS);
    const semCounts = this.traitCounts(this.semMap, SEM_KEYS);
    const moodOpts: [string, string][] = MOOD_KEYS.filter((k) => moodCounts.has(k))
      .map((k) => [k, `${L.mood[k]} (${moodCounts.get(k)})`]);
    let concrete = 0;
    let abstract = 0;
    for (const [code, n] of semCounts) {
      if (SEM_ABSTRACT.includes(code))
        abstract += n;
      else
        concrete += n;
    }
    const semOpts: [string, string][] = [];
    // сборные «конкретное»/«абстрактное» — ради них слой и брали; предлагаем, только когда
    // в списке есть и то и другое, иначе это тот же «все» под другим именем
    if (concrete > 0 && abstract > 0) {
      semOpts.push([SEM_CONCRETE_ALL, `${t("semConcreteAll")} (${concrete})`]);
      semOpts.push([SEM_ABSTRACT_ALL, `${t("semAbstractAll")} (${abstract})`]);
    }
    for (const k of SEM_KEYS) {
      if (semCounts.has(k))
        semOpts.push([k, `${L.sem[k]} (${semCounts.get(k)})`]);
    }
    this.moodOn = moodOpts.some(([k]) => k === this.moodFilter) ? this.moodFilter : "";
    this.semOn = semOpts.some(([k]) => k === this.semFilter) ? this.semFilter : "";
    const posLabel = L.pos;
    const list = this.filtered();
    const bar = host.createDiv({ cls: "rr-filters" });
    if (kinds.length >= 2 || this.allitAll.length > 0) {
      const kindOpts: [SoundKind, string][] = [["all", t("kindAll")], ...kinds];
      if (this.allitAll.length > 0)
        kindOpts.push(["allit", t("kindAllit")]);
      const kindBtn = this.filterMenu(
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
      // чем «созвучия» отличаются от «ассонанса», по названию не догадаться — объясняем
      // подсказкой к кнопке; она же меняется вместе с выбранным видом
      kindBtn.title = KIND_HINT()[this.soundKind] || "";
    }
    const sylOpts: [number, string][] = [[0, t("filterAll")], [1, "1"], [2, "2"], [3, "3"], [4, "4+"]];
    this.filterMenu(
      bar,
      t("syllables"),
      optLabel(sylOpts, this.sylFilter),
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
    // капсулу показываем только там, где есть из чего выбирать — как и капсулу вида
    if (clausVaries) {
      const clausOpts: [number, string][] = [
        [0, t("filterAll")],
        [1, t("clausM")],
        [2, t("clausF")],
        [3, t("clausD")],
        [4, t("clausH")]
      ];
      const clausCur = clausOpts.find(([v]) => v === this.clausFilter);
      this.filterMenu(
        bar,
        t("clausLabel"),
        clausCur ? clausCur[1] : t("filterAll"),
        this.clausFilter !== 0,
        (menu) => {
          for (const [val, label] of clausOpts) {
            menu.addItem(
              (it) => it.setTitle(label).setChecked(this.clausFilter === val).onClick(() => {
                this.clausFilter = val;
                this.shown = PAGE;
                this.saveFilters();
                this.renderSoundResults();
              })
            );
          }
        }
      );
    }
    // части речи — только те, что в списке есть, и с числом: междометий во всём словаре
    // 202 штуки на 900 тысяч слов, и пункт «межд.» почти всегда обещал пустую выдачу.
    // Липкий выбор из меню не выкидываем, даже если его тут нет: иначе фильтр молча
    // перестал бы действовать при переходе к слову без глаголов
    const posCounts = /* @__PURE__ */ new Map<string, number>();
    for (const e of this.soundList())
      posCounts.set(e.p, (posCounts.get(e.p) || 0) + 1);
    const posOpts: [string, string][] = [["", t("filterAll")]];
    for (const k of POS_KEYS) {
      if (!k || !posLabel[k])
        continue;
      if (posCounts.has(k))
        posOpts.push([k, `${posLabel[k]} (${posCounts.get(k)})`]);
      else if (k === this.posFilter)
        posOpts.push([k, `${posLabel[k]} (0)`]);
    }
    this.filterMenu(
      bar,
      t("filterPos"),
      optLabel(posOpts, this.posFilter),
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
    // одна капсула на обе пометы: по отдельности они дали бы ряду фильтров ещё две строки
    // на телефоне, а вопрос у них общий — «что это за слово»
    if (moodOpts.length > 0 || semOpts.length > 0) {
      const on: string[] = [];
      if (this.moodOn)
        on.push(L.mood[this.moodOn]);
      if (this.semOn)
        on.push(this.semFilterLabel(this.semOn));
      const traitBtn = this.filterMenu(bar, t("traitLabel"), on.length > 0 ? on.join(", ") : t("filterAll"), on.length > 0, (menu) => {
        const section = (title: string, all: string, opts: [string, string][], which: "mood" | "sem") => {
          menu.addItem((it) => it.setTitle(title).setIsLabel(true));
          menu.addItem((it) => it.setTitle(t("filterAll")).setChecked(all === "").onClick(() => this.setTrait(which, "")));
          for (const [val, label] of opts)
            menu.addItem((it) => it.setTitle(label).setChecked(all === val).onClick(() => this.setTrait(which, val)));
        };
        if (moodOpts.length > 0)
          section(t("traitMood"), this.moodOn, moodOpts, "mood");
        if (semOpts.length > 0) {
          if (moodOpts.length > 0)
            menu.addSeparator();
          section(t("traitSem"), this.semOn, semOpts, "sem");
        }
      });
      traitBtn.title = t("traitHint");
    }
    const lexOpts: [number, string][] = L.lex.map((label, idx) => [idx, label]);
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
    if (this.soundKind === "all" && kinds.length + (this.allitAll.length > 0 ? 1 : 0) >= 2) {
      this.renderKindSections(host, L);
      return;
    }
    const listEl = host.createDiv({ cls: "rr-list" });
    if (list.length === 0) {
      this.renderEmpty(listEl);
      return;
    }
    for (const e of list.slice(0, this.shown))
      this.renderChip(listEl, e, L);
    if (list.length > this.shown) {
      const more = host.createEl("button", { cls: "rr-more", text: `${t("showMore")} (${list.length - this.shown})` });
      more.addEventListener("click", () => {
        this.shown += PAGE_MORE;
        this.renderSoundResults();
      });
    }
  }
  /**
   * Подписи, общие для всех чипов одной отрисовки. Строятся один раз: каждая такая
   * таблица — это 3–12 обращений к moment.locale() внутри t(), а чипов на экране сотни.
   */
  chipLabels(): ChipLabels {
    return {
      pos: POS_LABEL(),
      lex: [t("lexBase"), t("lexFreq"), t("lexCommon"), t("lexRare")],
      mood: MOOD_LABEL(),
      sem: SEM_LABEL(),
      hint: `${t("chipHint")} \xB7 ${insertHint()}${dragHint()}`,
      related: t("relatedHint")
    };
  }
  /** Один чип-слово: клик — копия, двойной — рифмы к нему; класс по лексическому слою. */
  renderChip(container: HTMLElement, e: RhymeEntry, L: ChipLabels) {
    const lc = lexCat(e.f);
    const related = this.relatedWords.has(e.word);
    const chip = container.createSpan({ cls: `rr-chip rr-lex${lc}` + (related ? " rr-related" : ""), text: markStress(e.word, e.s) });
    // пометы показываем только подсказкой: цветом их не покажешь — четыре слоя лексики уже
    // заняли и фон, и насыщенность чипа. Незнакомый код пометы (шард новее плагина)
    // пропускаем, иначе в подсказке повисло бы «· undefined»
    const mood = L.mood[this.moodMap.get(e.word) || ""];
    const sem = L.sem[this.semMap.get(e.word) || ""];
    chip.title = `${L.hint}${L.pos[e.p] ? " \xB7 " + L.pos[e.p] : ""} \xB7 ${L.lex[lc]}` +
      `${mood ? " \xB7 " + mood : ""}${sem ? " \xB7 " + sem : ""}` +
      `${related ? " \xB7 " + L.related : ""}`;
    this.attachWordActions(chip, e.word);
  }
  /** Вид «все»: каждая разновидность (точные/близкие/созвучия/ассонансы) — своя секция с заголовком. */
  renderKindSections(host: HTMLElement, L: ChipLabels) {
    const src: [SoundKind, string, RhymeEntry[]][] = [
      ["exact", t("kindExact"), this.all.filter((e) => e.exact)],
      ["near", t("tabNear"), this.all.filter((e) => !e.exact)],
      ["conson", t("tabConson"), this.consAll],
      ["asson", t("tabAsson"), this.assonAll],
      ["allit", t("kindAllit"), this.allitAll]
    ];
    let firstKind = null;
    const toRender: [SoundKind, string, RhymeEntry[]][] = [];
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
      this.renderKindSection(host, kind, label, list, def, L);
    }
  }
  /** Одна сворачиваемая секция вида: заголовок со счётчиком; чипы рисуются лениво при раскрытии. */
  renderKindSection(host: HTMLElement, kind: SoundKind, label: string, list: RhymeEntry[], defaultOpen: boolean, L: ChipLabels) {
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
        this.renderChip(body, e, L);
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
  filterMenu(parent: HTMLElement, label: string, value: string, active: boolean, build: (menu: Menu) => void) {
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
    return btn;
  }
  /** Сворачиваемая таблица словоформ с ударениями — вверху вкладки «Значение». */
  renderForms(host: HTMLElement) {
    const f = this.forms;
    if (!f || f.rows.length === 0)
      return;
    const details = host.createEl("details", { cls: "rr-forms" });
    details.createEl("summary", {
      cls: "rr-forms-summary",
      text: t("formsTitle") + (f.lemma ? " \u2192 " + f.lemma : "")
    });
    const grid = details.createDiv({ cls: "rr-forms-grid" });
    const hint = `${t("copyHint")} \xB7 ${insertHint()}${dragHint()}`;
    for (const r of f.rows) {
      const row = grid.createDiv({ cls: "rr-form-row" });
      row.createSpan({ cls: "rr-form-label", text: r.label });
      const val = row.createSpan({ cls: "rr-form-val", text: r.form });
      val.title = hint;
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
  appendClickableText(parent: HTMLElement, text: string) {
    const re = /[а-яёА-ЯЁ]+(?:-[а-яёА-ЯЁ]+)*/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last)
        parent.appendText(text.slice(last, m.index));
      const word = m[0];
      const span = parent.createSpan({ cls: "rr-defword", text: word });
      const lp = this.attachLongPressInsert(span, word);
      span.addEventListener("click", (e: MouseEvent) => {
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
  chipGroup(wrap: HTMLElement, words: string[]) {
    const row = wrap.createDiv({ cls: "rr-syn-group" });
    const hint = `${t("chipHint")} \xB7 ${insertHint()}${dragHint()}`;
    for (const w of words) {
      const chip = row.createSpan({ cls: "rr-chip", text: w });
      chip.title = hint;
      this.attachWordActions(chip, w);
    }
  }
  /** Сворачиваемый подраздел «Ассоциаций»: заголовок + счётчик, тело строит build; раскрытость на сессию. */
  semSection(host: HTMLElement, key: string, title: string, count: number, build: (b: HTMLElement) => void) {
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
    const lemmaSuffix = (l: string | null) => l ? " \u2192 " + l : "";
    const wordCount = (groups: string[][]) => groups.reduce((n: number, g: string[]) => n + g.length, 0);
    let any = false;
    const chipSecs: [string, string, Synonyms | null][] = [
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
        const hint = `${t("copyHint")} \xB7 ${insertHint()}${dragHint()}`;
        for (const it of ph.items) {
          const prow = b.createDiv({ cls: "rr-phrase" });
          const pt = prow.createSpan({ cls: "rr-phrase-text", text: it.phrase });
          pt.title = hint;
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
        const hint = `${t("copyHint")} \xB7 ${insertHint()}${dragHint()}`;
        for (const it of prov.items) {
          const prow = b.createDiv({ cls: "rr-phrase" });
          const pt = prow.createSpan({ cls: "rr-phrase-text", text: it });
          pt.title = hint;
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
    const tailSecs: [string, string, Synonyms | null][] = [
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
    const cats: [GenCat, string][] = [
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
    const tierOpts: [number, string][] = [[0, t("lexBase")], [1, t("lexFreq")]];
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
  shuffleInPlace<T>(a: T[]) {
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

export { RhymesView, STARTUP_KEYS, VIEW_TYPE_RHYMES, renderShardList, shardTitle };
