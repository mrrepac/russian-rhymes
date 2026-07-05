// Оффлайн-словарь: два gzip-файла (words + rhymes), в памяти держатся как
// единые строки с массивами офсетов строк — бинарный поиск без миллиона
// строковых объектов.
import { App, normalizePath, requestUrl } from "obsidian";
import * as pako from "pako";
import { rhymeKey, countSyllables, looksSameRoot, vowelSkeleton, consonantSkeleton, alliterationPrefix } from "./phonetics.js";
import { CHARACTERS } from "./characters";

export type GenCat = "n" | "v" | "a" | "char";

export interface StressVariant {
  s: number; // индекс ударной гласной
  f: number; // частотный бакет 0..9
  p: string; // часть речи: n/v/a/d/x
}

export interface RhymeEntry {
  word: string;
  s: number;
  f: number;
  p: string;
  syl: number;
  exact: boolean; // совпала опорная согласная — точная (богатая) рифма
}

export type DictStatus = "idle" | "loading" | "ready" | "missing" | "error";

export interface DefExample {
  text: string;
  ref?: string; // источник цитаты: автор, произведение
}

export interface DefSense {
  gloss: string; // толкование
  examples?: DefExample[];
}

export interface DefGroup {
  pos: string; // «сущ.», «гл.»… или "" (у личных словарей — имя словаря)
  senses: DefSense[];
}

export interface Definitions {
  lemma: string; // слово, чьи значения показаны (после редиректа форма→лемма)
  etymology?: string; // происхождение слова (только Викисловарь)
  groups: DefGroup[];
}

export interface FormRow {
  label: string; // грамматическая метка: «Р. ед.», «прош. м.», «наст. 1л. ед.»
  form: string; // форма с ударением
}

export interface Forms {
  lemma: string | null; // не null, если формы взяты у леммы формы
  rows: FormRow[];
}

/** Плоский список строк (идиомы, пословицы) с пометкой, чьи они (лемма). */
export interface StringList {
  lemma: string | null;
  items: string[];
}

export interface Synonyms {
  lemma: string | null; // не null, если синонимы взяты у леммы, а не у самой формы
  groups: string[][];
}

export interface PhraseItem {
  phrase: string;
  gloss: string;
}

export interface Phrases {
  lemma: string | null;
  items: PhraseItem[];
}

interface TextIndex {
  text: string;
  offsets: Uint32Array;
}

// разделители богатого формата definitions.txt.gz (см. tools/build-definitions.mjs):
// этимология ␝ группа ; группа = POS ␟ значение ; значение = толкование ␞ пример ; пример = текст ␜ источник
const DEF_GS = "\x1d", DEF_US = "\x1f", DEF_RS = "\x1e", DEF_FS = "\x1c";

function buildIndex(text: string): TextIndex {
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  const offsets = new Uint32Array(count);
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) offsets[n++] = i + 1;
  }
  return { text, offsets };
}

/** Бинарный поиск строки, начинающейся с prefix (строки отсортированы по code units). */
function findLine(idx: TextIndex, prefix: string): string | null {
  const { text, offsets } = idx;
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = offsets[mid];
    if (text.startsWith(prefix, start)) {
      const nl = text.indexOf("\n", start);
      return text.slice(start, nl < 0 ? text.length : nl);
    }
    const probe = text.slice(start, Math.min(start + prefix.length, text.length));
    if (probe < prefix) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

export class RhymeDict {
  status: DictStatus = "idle";
  private words: TextIndex | null = null;
  private rhymes: TextIndex | null = null;
  private syns: TextIndex | null = null;
  private ants: TextIndex | null = null;
  private assoc: TextIndex | null = null;
  private hyper: TextIndex | null = null;
  private hypo: TextIndex | null = null;
  private related: TextIndex | null = null;
  private idioms: TextIndex | null = null;
  private proverbs: TextIndex | null = null;
  private metagrams: TextIndex | null = null;
  private anagrams: TextIndex | null = null;
  private formsIdx: TextIndex | null = null;
  private defs: TextIndex | null = null;
  // пулы генератора-пасхалки: по каждой части речи — массив слоёв (0 базовая, 1 частотная);
  // перс — хардкод (без повторов), слои к нему не применяются
  private gen: { n: string[][]; v: string[][]; a: string[][] } | null = null;
  private chars: string[] = [...new Set(CHARACTERS)];
  private lemmas: TextIndex | null = null;
  private phrasesIdx: TextIndex | null = null;
  // ёфикация ввода: е-написание -> однозначная ё-версия (карта из build-yomap, безопасные пары)
  private yoMap = new Map<string, string>();
  // личные толковые словари пользователя (DSL): каждый — свой файл local-<id>.txt.gz.
  // Порядок localOrder задаётся манифестом из настроек и определяет порядок групп
  // во вкладке «Значение» (после Викисловаря). enabled — тумблер видимости в выдаче:
  // отключённый словарь остаётся в памяти и на диске, но не даёт групп значений.
  private local = new Map<string, { name: string; idx: TextIndex; enabled: boolean }>();
  private manifest: Array<{ id: string; name: string; enabled: boolean }> = [];
  private localOrder: string[] = [];
  private loading: Promise<void> | null = null;
  // предпосчёт для assonancesFor: гласный скелет каждого рифм-ключа и позиция таба
  // (конца ключа). Строится лениво один раз; иначе vowelSkeleton пересчитывался бы
  // по ~120k ключей на КАЖДЫЙ показ слова и клик по гласной — фриз главного потока.
  private rhymeSkel: string[] | null = null;
  private rhymeKeyEnd: Uint32Array | null = null;

  constructor(private app: App, private pluginDir: string) {}

  /** Ленивая загрузка; повторные вызовы ждут один и тот же промис. */
  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.doLoad().catch((e) => {
      if (this.status === "loading") this.status = "error";
      console.error("Russian Rhymes: dictionary load failed", e);
    });
    return this.loading;
  }

  private async readGz(name: string): Promise<string | null> {
    const path = normalizePath(`${this.pluginDir}/dict/${name}`);
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path))) return null;
    const buf = await adapter.readBinary(path);
    try {
      return new TextDecoder("utf-8").decode(pako.ungzip(new Uint8Array(buf)));
    } catch (e) {
      // битый/недокачанный шард: удаляем, чтобы следующее «Скачать» забрало его
      // заново. Иначе проверка по размеру в downloadDict пропускала бы его вечно,
      // и плагин навсегда застревал бы в состоянии error без выхода из UI.
      console.error(`Russian Rhymes: corrupt shard ${name}, removing`, e);
      try { await adapter.remove(path); } catch { /* уже удалён/недоступен */ }
      return null;
    }
  }

  private async doLoad(): Promise<void> {
    this.status = "loading";
    const wordsRaw = await this.readGz("words.txt.gz");
    const rhymesRaw = await this.readGz("rhymes.txt.gz");
    if (wordsRaw === null || rhymesRaw === null) {
      this.status = "missing";
      return;
    }
    this.words = buildIndex(wordsRaw);
    this.rhymes = buildIndex(rhymesRaw);
    this.rhymeSkel = null; // словарь перечитан — сбросить предпосчёт (построится лениво)
    this.rhymeKeyEnd = null;
    // остальные словари опциональны: без файлов работают только рифмы
    const opt: Array<[string, (idx: TextIndex) => void]> = [
      ["synonyms.txt.gz", (i) => (this.syns = i)],
      ["antonyms.txt.gz", (i) => (this.ants = i)],
      ["associations.txt.gz", (i) => (this.assoc = i)],
      ["hypernyms.txt.gz", (i) => (this.hyper = i)],
      ["hyponyms.txt.gz", (i) => (this.hypo = i)],
      ["related.txt.gz", (i) => (this.related = i)],
      ["idioms.txt.gz", (i) => (this.idioms = i)],
      ["proverbs.txt.gz", (i) => (this.proverbs = i)],
      ["metagrams.txt.gz", (i) => (this.metagrams = i)],
      ["anagrams.txt.gz", (i) => (this.anagrams = i)],
      ["forms.txt.gz", (i) => (this.formsIdx = i)],
      ["definitions.txt.gz", (i) => (this.defs = i)],
      ["lemmas.txt.gz", (i) => (this.lemmas = i)],
      ["phrases.txt.gz", (i) => (this.phrasesIdx = i)],
    ];
    for (const [name, set] of opt) {
      const raw = await this.readGz(name);
      if (raw !== null) set(buildIndex(raw));
    }
    // карта ёфикации ввода (е-написание -> ё-версия), опциональна
    const yoRaw = await this.readGz("yo.txt.gz");
    if (yoRaw !== null) {
      for (const line of yoRaw.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab > 0) this.yoMap.set(line.slice(0, tab), line.slice(tab + 1));
      }
    }
    // пулы генератора-пасхалки «фристайл» (сущ/гл/прил)
    const genRaw = await this.readGz("generator.txt.gz");
    if (genRaw !== null) this.gen = this.parseGenerator(genRaw);
    // личные толковые словари — по манифесту из настроек (порядок сохраняется)
    for (const d of this.manifest) {
      const raw = await this.readGz(`local-${d.id}.txt.gz`);
      if (raw !== null) this.local.set(d.id, { name: d.name, idx: buildIndex(raw), enabled: d.enabled });
    }
    this.status = "ready";
  }

  private localFilePath(id: string): string {
    return normalizePath(`${this.pluginDir}/dict/local-${id}.txt.gz`);
  }

  /**
   * Скачать файлы словаря с baseUrl (GitHub-релиз) в папку dict/. Личные словари
   * (local-*) не трогаются. Возобновляемо: уже скачанный файл нужного размера
   * пропускается. onProgress(done, total, name) — для индикатора.
   */
  async downloadDict(
    baseUrl: string,
    onProgress: (done: number, total: number, name: string) => void
  ): Promise<void> {
    const adapter = this.app.vault.adapter;
    const dir = normalizePath(`${this.pluginDir}/dict`);
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    const base = baseUrl.trim().replace(/\/+$/, "") + "/";

    // список файлов и размеров — files.json рядом с ассетами.
    // Парсим text вручную: GitHub отдаёт ассеты как octet-stream, .json может не сработать.
    const listResp = await requestUrl({ url: base + "files.json" });
    const files: Array<{ name: string; size: number }> = JSON.parse(listResp.text).files;
    if (!Array.isArray(files) || files.length === 0) throw new Error("empty files.json");

    let done = 0;
    for (const f of files) {
      // строгая проверка имени (только «слово.txt.gz») — никаких путей/«..», и
      // личные словари local-* не трогаем
      if (!/^[\w-]+\.txt\.gz$/.test(f.name) || f.name.startsWith("local-")) continue;
      const path = normalizePath(`${dir}/${f.name}`);
      if (await adapter.exists(path)) {
        const stat = await adapter.stat(path);
        if (stat && stat.size === f.size) {
          onProgress(++done, files.length, f.name);
          continue;
        }
      }
      const buf = await this.fetchChunked(base + f.name, f.size);
      // не пишем на диск, пока не убедились, что скачанное распаковывается: иначе
      // мусор нужного размера (ошибка CDN, заглушка) осел бы навсегда (см. readGz)
      try {
        pako.ungzip(new Uint8Array(buf));
      } catch {
        throw new Error(`corrupt download (bad gzip): ${f.name}`);
      }
      await adapter.writeBinary(path, buf);
      onProgress(++done, files.length, f.name);
    }
  }

  /**
   * Скачать файл, дробя на Range-куски (~3 МБ), чтобы мобильный requestUrl не держал
   * весь ответ в памяти (37 МБ одним куском роняют Obsidian на телефоне). Если сервер
   * игнорирует Range (вернул весь файл первым куском) — используем как есть.
   */
  private async fetchChunked(url: string, size: number): Promise<ArrayBuffer> {
    const CHUNK = 3 * 1024 * 1024;
    if (size <= CHUNK) return (await requestUrl({ url })).arrayBuffer;
    const out = new Uint8Array(size);
    let off = 0;
    while (off < size) {
      const end = Math.min(off + CHUNK, size) - 1;
      const resp = await requestUrl({ url, headers: { Range: `bytes=${off}-${end}` } });
      const chunk = new Uint8Array(resp.arrayBuffer);
      if (chunk.length === 0) throw new Error(`empty chunk at ${off} for ${url}`);
      // сервер проигнорировал Range (ответ 200, не 206) — это ВЕСЬ файл целиком, на
      // любом шаге; берём его как есть. Прежняя проверка `off === 0` ловила лишь
      // первый кусок, и непоследовательный прокси мог вклеить «голову» файла в хвост.
      if (resp.status === 200 && chunk.length >= size) return resp.arrayBuffer;
      out.set(chunk.subarray(0, Math.min(chunk.length, size - off)), off);
      off += chunk.length;
    }
    return out.buffer;
  }

  /** Перечитать словарь после скачивания (сброс кэша загрузки). */
  async reloadAfterDownload(): Promise<void> {
    this.status = "idle";
    this.loading = null;
    await this.load();
  }

  /** Разбор generator.txt.gz: секции «#n»/«#v»/«#a», строки «слово\tслой». */
  private parseGenerator(raw: string): { n: string[][]; v: string[][]; a: string[][] } {
    const g = { n: [] as string[][], v: [] as string[][], a: [] as string[][] };
    let cur: string[][] | null = null;
    for (const line of raw.split("\n")) {
      if (line === "#n") cur = g.n;
      else if (line === "#v") cur = g.v;
      else if (line === "#a") cur = g.a;
      else if (line && cur) {
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        const tier = +line.slice(tab + 1);
        // потолок: без него строка «слово\t2000000000» в подменённом файле дала бы
        // цикл на 2 млрд итераций push([]) → OOM-краш. Слоёв всегда единицы.
        if (!Number.isInteger(tier) || tier < 0 || tier > 32) continue;
        while (cur.length <= tier) cur.push([]);
        cur[tier].push(line.slice(0, tab));
      }
    }
    return g;
  }

  /** Есть ли пулы сущ/гл/прил для генератора (перс есть всегда — хардкод). */
  hasGeneratorPools(): boolean {
    return !!this.gen;
  }

  /** Объединённый пул слов для генератора по выбранным категориям и слоям (без повторов).
   * Перемешивание и «мешок без повторов» — на стороне view. */
  generatorPool(cats: GenCat[], tiers: number[]): string[] {
    const out: string[] = [];
    for (const c of cats) {
      if (c === "char") out.push(...this.chars);
      else if (this.gen) for (const t of tiers) if (this.gen[c][t]) out.push(...this.gen[c][t]);
    }
    return [...new Set(out)];
  }

  /**
   * Манифест личных словарей из настроек: задаёт, какие файлы грузить и в каком
   * порядке показывать. Вызывать до load(); повторный вызов синхронизирует порядок
   * и имена уже загруженных индексов.
   */
  setLocalManifest(dicts: Array<{ id: string; name: string; enabled: boolean }>): void {
    this.manifest = dicts.map((d) => ({ id: d.id, name: d.name, enabled: d.enabled }));
    this.localOrder = dicts.map((d) => d.id);
    for (const d of dicts) {
      const e = this.local.get(d.id);
      if (e) {
        e.name = d.name;
        e.enabled = d.enabled;
      }
    }
  }

  /** Включить/отключить личный словарь в выдаче (файл и индекс остаются загруженными). */
  setEnabled(id: string, enabled: boolean): void {
    const e = this.local.get(id);
    if (e) e.enabled = enabled;
    const m = this.manifest.find((x) => x.id === id);
    if (m) m.enabled = enabled;
  }

  /** Число слов в личном словаре по id (0, если ещё не загружен). */
  localWords(id: string): number {
    return this.local.get(id)?.idx.offsets.length ?? 0;
  }

  /** Добавить/заменить личный словарь: записать файл, построить индекс, встать в конец порядка. */
  async importDict(id: string, name: string, entries: Map<string, string[]>): Promise<number> {
    const lines: string[] = [];
    for (const [w, g] of entries) lines.push(`${w}\t${g.join("|")}`);
    lines.sort();
    const raw = lines.join("\n");
    const adapter = this.app.vault.adapter;
    const dir = normalizePath(`${this.pluginDir}/dict`);
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    const gz = pako.gzip(raw);
    await adapter.writeBinary(this.localFilePath(id), gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer);
    this.local.set(id, { name, idx: buildIndex(raw), enabled: true });
    if (!this.localOrder.includes(id)) this.localOrder.push(id);
    return entries.size;
  }

  /** Удалить личный словарь (файл + индекс + место в порядке). */
  async deleteDict(id: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const path = this.localFilePath(id);
    if (await adapter.exists(path)) await adapter.remove(path);
    this.local.delete(id);
    this.localOrder = this.localOrder.filter((x) => x !== id);
  }

  /** Переставить порядок личных словарей (без переписи файлов). */
  setOrder(ids: string[]): void {
    this.localOrder = ids.slice();
  }

  /** Переименовать личный словарь (имя — подпись группы во вкладке «Значение»). */
  renameDict(id: string, name: string): void {
    const e = this.local.get(id);
    if (e) e.name = name;
  }

  /** Леммы словоформы по словарю Зализняка («разуму» -> [разум]). */
  private lemmasOf(word: string): string[] {
    if (!this.lemmas) return [];
    const line = findLine(this.lemmas, word + "\t");
    return line ? line.slice(word.length + 1).split(",") : [];
  }

  /** Простой формат личных DSL-словарей: "POS:толк1;толк2|POS:…" (без примеров/этимологии). */
  private parseLocalGroups(rec: string): DefGroup[] {
    return rec.split("|").map((g) => {
      const colon = g.indexOf(":");
      const pos = colon > 0 ? g.slice(0, colon) : "";
      const senses: DefSense[] = g.slice(colon + 1).split(";").map((gloss) => ({ gloss }));
      return { pos, senses };
    });
  }

  /** Богатая статья Викисловаря: этимология + группы с примерами (см. build-definitions.mjs). */
  private parseWikiRecord(rec: string): { etymology: string; groups: DefGroup[] } {
    const parts = rec.split(DEF_GS);
    const etymology = parts[0] || "";
    const groups: DefGroup[] = [];
    for (const gp of parts.slice(1)) {
      const seg = gp.split(DEF_US);
      const pos = seg[0];
      const senses: DefSense[] = seg.slice(1).map((s) => {
        const chunks = s.split(DEF_RS);
        const examples: DefExample[] = chunks.slice(1).map((e) => {
          const fs = e.indexOf(DEF_FS);
          return fs >= 0 ? { text: e.slice(0, fs), ref: e.slice(fs + 1) } : { text: e };
        });
        return examples.length ? { gloss: chunks[0], examples } : { gloss: chunks[0] };
      });
      groups.push({ pos, senses });
    }
    return { etymology, groups };
  }

  /** Группы личных толковых словарей для слова — в порядке localOrder, каждая подписана именем словаря. */
  private localDefGroups(word: string): DefGroup[] {
    const out: DefGroup[] = [];
    for (const id of this.localOrder) {
      const e = this.local.get(id);
      if (!e || !e.enabled) continue;
      const line = findLine(e.idx, word + "\t");
      if (!line) continue;
      for (const g of this.parseLocalGroups(line.slice(word.length + 1))) {
        out.push({ pos: e.name, senses: g.senses });
      }
    }
    return out;
  }

  /**
   * Статья толкового словаря по точному слову: сначала Викисловарь
   * (с form_of-редиректом), затем личные DSL в заданном пользователем порядке.
   */
  private defArticle(word: string): Definitions | null {
    const localGroups = this.localDefGroups(word);

    let lemma = word;
    let mainGroups: DefGroup[] = [];
    let etymology = "";
    if (this.defs) {
      let line = findLine(this.defs, lemma + "\t");
      if (line && line[lemma.length + 1] === ">") {
        lemma = line.slice(lemma.length + 2);
        line = findLine(this.defs, lemma + "\t");
      }
      if (line) {
        const rec = line.slice(lemma.length + 1);
        if (!rec.startsWith(">")) {
          const parsed = this.parseWikiRecord(rec);
          etymology = parsed.etymology;
          mainGroups = parsed.groups;
        }
      }
    }
    // Викисловарь первым, затем личные словари по порядку; потолок повыше, чтобы
    // несколько личных словарей не выдавливали друг друга
    const groups = [...mainGroups, ...localGroups].slice(0, 20);
    if (groups.length === 0) return null;
    return {
      lemma: localGroups.length > 0 && mainGroups.length === 0 ? word : lemma,
      etymology: etymology || undefined,
      groups,
    };
  }

  /** Толкования: сначала своя статья, иначе — статьи лемм формы. */
  definitionsFor(word: string): Definitions | null {
    const own = this.defArticle(word);
    if (own) return own;
    const names: string[] = [];
    const groups: DefGroup[] = [];
    let etymology: string | undefined;
    for (const lm of this.lemmasOf(word).slice(0, 2)) {
      const d = this.defArticle(lm);
      if (d && !names.includes(d.lemma)) {
        names.push(d.lemma);
        groups.push(...d.groups);
        if (!etymology && d.etymology) etymology = d.etymology;
      }
    }
    if (groups.length === 0) return null;
    return { lemma: names.join(", "), etymology, groups: groups.slice(0, 8) };
  }

  /**
   * Созвучия и ассонансы: слова, чей рифм-ключ имеет тот же гласный скелет
   * (ударная гласная + рисунок заударных), но сам ключ другой — точные рифмы
   * уже показаны во вкладке рифм.
   * conson: согласные того же фонетического класса (дорога/погода);
   * asson: остальные совпадения по гласным (дорога/дома).
   * Один скан по ~114 тыс. ключей даёт оба списка сразу — так пустые
   * разделы можно гасить в момент показа слова без второго прохода.
   */
  /** Один раз построить гласные скелеты всех рифм-ключей и позиции табов (для assonancesFor). */
  private buildRhymeIndex(): void {
    const idx = this.rhymes;
    if (!idx) { this.rhymeSkel = []; this.rhymeKeyEnd = new Uint32Array(0); return; }
    const { text, offsets } = idx;
    const n = offsets.length;
    const skel = new Array<string>(n);
    const ends = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const start = offsets[i];
      const lineEnd = i + 1 < n ? offsets[i + 1] - 1 : text.length;
      let tab = text.indexOf("\t", start);
      if (tab < 0 || tab > lineEnd) tab = -1; // строка без таба (битый шард) — не индексируем
      ends[i] = tab < 0 ? 0 : tab;
      // "￿" — скелет, который не совпадёт ни с одним валидным (пропустит строку)
      skel[i] = tab < 0 ? "￿" : vowelSkeleton(text.slice(start, tab));
    }
    this.rhymeSkel = skel;
    this.rhymeKeyEnd = ends;
  }

  assonancesFor(word: string, s: number): { conson: RhymeEntry[]; asson: RhymeEntry[] } {
    const res = { conson: [] as RhymeEntry[], asson: [] as RhymeEntry[] };
    if (!this.rhymes) return res;
    const { key } = rhymeKey(word, s);
    const skel = vowelSkeleton(key);
    if (!skel) return res;
    if (!this.rhymeSkel || !this.rhymeKeyEnd) this.buildRhymeIndex();
    const skelArr = this.rhymeSkel!;
    const ends = this.rhymeKeyEnd!;
    const qCons = consonantSkeleton(key);
    const { text, offsets } = this.rhymes;
    const qSyl = countSyllables(word);
    for (let i = 0; i < offsets.length; i++) {
      if (skelArr[i] !== skel) continue; // дешёвый предпосчитанный фильтр вместо vowelSkeleton
      const start = offsets[i];
      const tab = ends[i];
      const k = text.slice(start, tab);
      if (k === key) continue;
      const out = consonantSkeleton(k) === qCons ? res.conson : res.asson;
      const nl = text.indexOf("\n", tab);
      const rec = text.slice(tab + 1, nl < 0 ? text.length : nl);
      for (const item of rec.split("|")) {
        const [w, s36, f, p] = item.split(",");
        // служебная мелочь (до/но/что) — шум
        if (w === word || w.length < 3 || p === "x" || looksSameRoot(w, word)) continue;
        out.push({ word: w, s: parseInt(s36, 36), f: +f, p, syl: countSyllables(w), exact: false });
      }
    }
    const cmp = (a: RhymeEntry, b: RhymeEntry) =>
      b.f - a.f ||
      Math.abs(a.syl - qSyl) - Math.abs(b.syl - qSyl) ||
      (a.word < b.word ? -1 : 1);
    res.conson.sort(cmp);
    res.asson.sort(cmp);
    res.conson = res.conson.slice(0, 2000);
    res.asson = res.asson.slice(0, 2000);
    return res;
  }

  private groupsAt(idx: TextIndex | null, word: string): string[][] | null {
    if (!idx) return null;
    const line = findLine(idx, word + "\t");
    if (!line) return null;
    return line
      .slice(word.length + 1)
      .split("|")
      .map((g) => g.split(","));
  }

  /** Свои группы слова, иначе — группы его лемм (с пометкой, чьи они). */
  private resolveGroups(get: (w: string) => string[][] | null, word: string, maxGroups: number): Synonyms | null {
    const own = get(word);
    if (own) return { lemma: null, groups: own.slice(0, maxGroups) };
    const names: string[] = [];
    const groups: string[][] = [];
    for (const lm of this.lemmasOf(word).slice(0, 2)) {
      const g = get(lm);
      if (g && !names.includes(lm)) {
        names.push(lm);
        groups.push(...g);
      }
    }
    if (groups.length === 0) return null;
    return { lemma: names.join(", "), groups: groups.slice(0, maxGroups) };
  }

  /** Синонимы: Викисловарь + Абрамов/АОТ. */
  synonymsFor(word: string): Synonyms | null {
    return this.resolveGroups((w) => this.groupsAt(this.syns, w), word, 10);
  }

  /** Антонимы (Викисловарь). */
  antonymsFor(word: string): Synonyms | null {
    return this.resolveGroups((w) => this.groupsAt(this.ants, w), word, 3);
  }

  /** Ассоциации (КартаСлов). */
  associationsFor(word: string): Synonyms | null {
    return this.resolveGroups((w) => this.groupsAt(this.assoc, w), word, 3);
  }

  /** Гиперонимы — общее понятие (Викисловарь): дорога → пространство, линия. */
  hypernymsFor(word: string): Synonyms | null {
    return this.resolveGroups((w) => this.groupsAt(this.hyper, w), word, 1);
  }

  /** Гипонимы — частные виды (Викисловарь): дорога → улица, тропа, шоссе. */
  hyponymsFor(word: string): Synonyms | null {
    return this.resolveGroups((w) => this.groupsAt(this.hypo, w), word, 1);
  }

  /** Родственные слова — однокоренные (Викисловарь): быстрый → быстро, быстрота. */
  relatedFor(word: string): Synonyms | null {
    return this.resolveGroups((w) => this.groupsAt(this.related, w), word, 1);
  }

  /** Метаграммы — слова, отличающиеся одной буквой (Викисловарь): хлеб → Глеб, хлев. */
  metagramsFor(word: string): Synonyms | null {
    return this.resolveGroups((w) => this.groupsAt(this.metagrams, w), word, 1);
  }

  /** Анаграммы (Викисловарь): дом → мод. */
  anagramsFor(word: string): Synonyms | null {
    return this.resolveGroups((w) => this.groupsAt(this.anagrams, w), word, 1);
  }

  private phraseItems(word: string): PhraseItem[] | null {
    if (!this.phrasesIdx) return null;
    const line = findLine(this.phrasesIdx, word + "\t");
    if (!line) return null;
    return line
      .slice(word.length + 1)
      .split("|")
      .map((it) => {
        const tilde = it.indexOf("~");
        return { phrase: tilde > 0 ? it.slice(0, tilde) : it, gloss: tilde > 0 ? it.slice(tilde + 1) : "" };
      });
  }

  /** Фразы и идиомы со словом (Викисловарь); свои, иначе — по леммам. */
  phrasesFor(word: string): Phrases | null {
    const own = this.phraseItems(word);
    if (own) return { lemma: null, items: own };
    const names: string[] = [];
    const items: PhraseItem[] = [];
    const seen = new Set<string>();
    for (const lm of this.lemmasOf(word).slice(0, 2)) {
      const got = this.phraseItems(lm);
      if (got && !names.includes(lm)) {
        names.push(lm);
        for (const it of got) {
          if (!seen.has(it.phrase)) {
            seen.add(it.phrase);
            items.push(it);
          }
        }
      }
    }
    if (items.length === 0) return null;
    return { lemma: names.join(", "), items };
  }

  private stringListAt(idx: TextIndex | null, word: string, sep: string): string[] | null {
    if (!idx) return null;
    const line = findLine(idx, word + "\t");
    return line ? line.slice(word.length + 1).split(sep) : null;
  }

  /** Свой список строк, иначе — списки лемм (идиомы/пословицы; sep — разделитель файла). */
  private resolveStringList(idx: TextIndex | null, word: string, sep: string): StringList | null {
    const own = this.stringListAt(idx, word, sep);
    if (own) return { lemma: null, items: own };
    const names: string[] = [];
    const items: string[] = [];
    const seen = new Set<string>();
    for (const lm of this.lemmasOf(word).slice(0, 2)) {
      const got = this.stringListAt(idx, lm, sep);
      if (got && !names.includes(lm)) {
        names.push(lm);
        for (const it of got) if (!seen.has(it)) { seen.add(it); items.push(it); }
      }
    }
    if (items.length === 0) return null;
    return { lemma: names.join(", "), items };
  }

  /** Устойчивые сочетания и идиомы (Викисловарь): вот где собака зарыта. */
  idiomsFor(word: string): StringList | null {
    return this.resolveStringList(this.idioms, word, "|");
  }

  /** Пословицы и поговорки (Викисловарь): хлеб — всему голова. */
  proverbsFor(word: string): StringList | null {
    return this.resolveStringList(this.proverbs, word, "|");
  }

  /** Парадигма словоформ с ударениями (Викисловарь); свои, иначе — у леммы формы. */
  formsFor(word: string): Forms | null {
    const parse = (w: string): FormRow[] | null => {
      if (!this.formsIdx) return null;
      const line = findLine(this.formsIdx, w + "\t");
      if (!line) return null;
      return line
        .slice(w.length + 1)
        .split("|")
        .map((e) => {
          const c = e.indexOf(":");
          return { label: c >= 0 ? e.slice(0, c) : "", form: c >= 0 ? e.slice(c + 1) : e };
        });
    };
    const own = parse(word);
    if (own) return { lemma: null, rows: own };
    for (const lm of this.lemmasOf(word).slice(0, 1)) {
      const rows = parse(lm);
      if (rows) return { lemma: lm, rows };
    }
    return null;
  }

  /** Ёфикация ввода: е-написание -> однозначная ё-версия (береза->берёза); мед/небо/лет не трогает. */
  normalizeYo(word: string): string {
    return this.yoMap.get(word) ?? word;
  }

  /**
   * Аллитерации: слова с тем же начальным согласным кластером (стр → страна, строка,
   * струна…) — для созвучных зачинов строк. Слова отсортированы, поэтому нижнюю границу
   * префикса ищем бинарно, дальше линейный скан по блоку.
   */
  alliterationsFor(word: string): RhymeEntry[] {
    if (!this.words) return [];
    const prefix = alliterationPrefix(word);
    if (prefix.length < 2) return []; // одиночная буква (к-, с-) — слишком широко, не аллитерация
    const { text, offsets } = this.words;
    // нижняя граница: первая строка, не меньшая prefix
    let lo = 0, hi = offsets.length - 1, start = offsets.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = offsets[mid];
      const probe = text.slice(s, Math.min(s + prefix.length, text.length));
      if (probe < prefix) lo = mid + 1;
      else { start = mid; hi = mid - 1; }
    }
    const qSyl = countSyllables(word);
    const out: RhymeEntry[] = [];
    for (let i = start; i < offsets.length; i++) {
      const s = offsets[i];
      if (!text.startsWith(prefix, s)) break; // вышли за блок префикса
      const tab = text.indexOf("\t", s);
      const w = text.slice(s, tab);
      if (w === word || looksSameRoot(w, word)) continue;
      const nl = text.indexOf("\n", tab);
      const [s36, f, p] = text.slice(tab + 1, nl < 0 ? text.length : nl).split(";")[0].split(",");
      if (p === "x") continue;
      out.push({ word: w, s: parseInt(s36, 36), f: +f, p, syl: countSyllables(w), exact: false });
    }
    // дедуп по лемме (Зализняк): грам. формы одного слова (странный/странное/странным)
    // схлопываются в одну запись; представитель — сама лемма, иначе самая частотная форма
    const byLemma = new Map<string, RhymeEntry>();
    for (const e of out) {
      const lemma = this.lemmasOf(e.word)[0] ?? e.word;
      const prev = byLemma.get(lemma);
      if (!prev || e.word === lemma || (prev.word !== lemma && e.f > prev.f)) byLemma.set(lemma, e);
    }
    const list = [...byLemma.values()];
    list.sort((a, b) => b.f - a.f || Math.abs(a.syl - qSyl) - Math.abs(b.syl - qSyl) || (a.word < b.word ? -1 : 1));
    return list.slice(0, 2000);
  }

  /** Варианты ударения слова или null, если слова нет. */
  lookup(word: string): StressVariant[] | null {
    if (!this.words) return null;
    const line = findLine(this.words, word + "\t");
    if (!line) return null;
    return line
      .slice(word.length + 1)
      .split(";")
      .map((v) => {
        const [s36, f, p] = v.split(",");
        return { s: parseInt(s36, 36), f: +f, p };
      });
  }

  /** Отранжированные рифмы к слову в конкретном варианте ударения. */
  rhymesFor(word: string, s: number): RhymeEntry[] {
    if (!this.rhymes) return [];
    const { key, support } = rhymeKey(word, s);
    const line = findLine(this.rhymes, key + "\t");
    if (!line) return [];
    const qSyl = countSyllables(word);
    const out: RhymeEntry[] = [];
    for (const item of line.slice(key.length + 1).split("|")) {
      const [w, s36, f, p] = item.split(",");
      if (w === word || looksSameRoot(w, word)) continue;
      const si = parseInt(s36, 36);
      out.push({
        word: w,
        s: si,
        f: +f,
        p,
        syl: countSyllables(w),
        exact: rhymeKey(w, si).support === support,
      });
    }
    out.sort(
      (a, b) =>
        (b.exact ? 1 : 0) - (a.exact ? 1 : 0) ||
        b.f - a.f ||
        Math.abs(a.syl - qSyl) - Math.abs(b.syl - qSyl) ||
        (a.word < b.word ? -1 : 1)
    );
    return out;
  }
}
