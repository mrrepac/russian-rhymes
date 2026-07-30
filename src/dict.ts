import { normalizePath, requestUrl } from "obsidian";
import { gzip as gzip_1, ungzip as ungzip_1 } from "pako";
import { alliterationPrefix, consonantSkeleton, countSyllables, looksSameRoot, prefixVerbPair, rhymeKey, vowelSkeleton } from "./phonetics";
import { CHARACTERS } from "./characters";

const DEF_GS = "";
const DEF_US = "";
const DEF_RS = "";
const DEF_FS = "";
// сколько распакованных блоков держим про запас: блок ~64 тыс. знаков, шесть штук —
// меньше мегабайта, и подряд идущие слова обычно попадают в уже прочитанный
const BLOCK_CACHE = 6;
// шарды второй волны: формы и толкования, 360 МБ из ~500 МБ всего словаря
const HEAVY_SHARDS = ["forms", "definitions"];
function buildIndex(text) {
  let count = 1;
  for (let i = 0; i < text.length; i++)
    if (text.charCodeAt(i) === 10)
      count++;
  const offsets = new Uint32Array(count);
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10)
      offsets[n++] = i + 1;
  }
  return { text, offsets };
}
function findLine(idx, prefix) {
  const { text, offsets } = idx;
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    const start = offsets[mid];
    if (text.startsWith(prefix, start)) {
      const nl = text.indexOf("\n", start);
      return text.slice(start, nl < 0 ? text.length : nl);
    }
    const probe = text.slice(start, Math.min(start + prefix.length, text.length));
    if (probe < prefix)
      lo = mid + 1;
    else
      hi = mid - 1;
  }
  return null;
}
const RhymeDict = class {
  constructor(app, pluginDir) {
    this.app = app;
    this.pluginDir = pluginDir;
    // папка личных словарей внутри хранилища; пусто — старое место, рядом с плагином
    this.localDir = "";
    // то же для основного словаря: синхронизация не носит подпапки плагина, поэтому
    // словарь в папке плагина приходится качать на каждом устройстве заново. Папка внутри
    // хранилища едет как обычные файлы — и докачка на втором устройстве не нужна вовсе.
    this.mainDir = "";
    // где файлы лежат на самом деле — определяется при загрузке, см. resolveDictDir.
    // Пусто до первого чтения; конструктор намеренно не зовёт normalizePath — класс
    // поднимают из бандла в тестах, и лишняя зависимость в конструкторе всё ломает
    this.activeDictDir = "";
    this.status = "idle";
    this.words = null;
    this.rhymes = null;
    this.syns = null;
    this.ants = null;
    this.assoc = null;
    this.hyper = null;
    this.hypo = null;
    this.related = null;
    this.idioms = null;
    this.proverbs = null;
    this.metagrams = null;
    this.anagrams = null;
    this.formsIdx = null;
    this.defs = null;
    // пулы генератора-пасхалки: по каждой части речи — массив слоёв (0 базовая, 1 частотная);
    // перс — хардкод (без повторов), слои к нему не применяются
    this.gen = null;
    this.chars = [...new Set(CHARACTERS)];
    this.lemmas = null;
    this.phrasesIdx = null;
    // ёфикация ввода: е-написание -> однозначная ё-версия (карта из build-yomap, безопасные пары)
    this.yoMap = /* @__PURE__ */ new Map();
    // личные толковые словари пользователя (DSL): каждый — свой файл local-<id>.txt.gz.
    // Порядок localOrder задаётся манифестом из настроек и определяет порядок групп
    // во вкладке «Значение» (после Викисловаря). enabled — тумблер видимости в выдаче:
    // отключённый словарь остаётся в памяти и на диске, но не даёт групп значений.
    this.local = /* @__PURE__ */ new Map();
    // id личных словарей, чей файл на месте, но не распаковался: удалять такое нельзя,
    // а показывать число слов из настроек — врать, будто словарь работает
    this.localBad = /* @__PURE__ */ new Set();
    this.manifest = [];
    this.localOrder = [];
    this.loading = null;
    // вторая волна: formsIdx и defs держат ~360 МБ из ~500 МБ всего словаря (кириллица
    // в строке V8 — 2 байта на символ), а нужны только во вкладке «Значение». Грузятся
    // при первом её открытии, иначе телефон не пережил бы старт.
    this.heavyStatus = "idle";
    this.loadingHeavy = null;
    // блочные шарды: <шард>.blk.gz — склеенные независимые gzip-члены, <шард>.blkidx.gz —
    // первый ключ и смещение каждого блока. В памяти только индекс (десятки КБ), сам блок
    // тянется Range-запросом по требованию. Пусто — читаем шард по-старому, целиком.
    this.blocks = /* @__PURE__ */ new Map();
    this.blockCache = /* @__PURE__ */ new Map();
    // предпосчёт для assonancesFor: гласный скелет каждого рифм-ключа и позиция таба
    // (конца ключа). Строится лениво один раз; иначе vowelSkeleton пересчитывался бы
    // по ~120k ключей на КАЖДЫЙ показ слова и клик по гласной — фриз главного потока.
    this.rhymeSkel = null;
    this.rhymeKeyEnd = null;
  }
  /** Ленивая загрузка; повторные вызовы ждут один и тот же промис. */
  load() {
    if (this.loading)
      return this.loading;
    this.loading = this.doLoad().catch((e) => {
      if (this.status === "loading")
        this.status = "error";
      console.error("Russian Rhymes: dictionary load failed", e);
    });
    return this.loading;
  }
  /**
   * Приехала ли вторая волна. Блочный шард ждать не надо: его индекс приезжает с первой
   * волной, а сами данные читаются с диска по кускам.
   */
  heavyReady() {
    return this.heavyStatus === "ready" || this.hasBlocks("forms") && this.hasBlocks("definitions");
  }
  /** Читается ли шард блоками с диска (вместо загрузки целиком в память). */
  hasBlocks(name) {
    return this.blocks.has(name);
  }
  /**
   * Загрузить индекс блоков шарда и убедиться, что Range-чтение тут работает: без него
   * пришёл бы весь файл целиком, что как раз и надо избежать. Не получилось — шард
   * останется на старом пути (грузится в память), поэтому молча выходим.
   */
  async loadBlockIndex(name) {
    const raw = await this.readGzPath(this.dictPath(`${name}.blkidx.gz`));
    if (raw === null)
      return;
    const keys = [];
    const offsets = [];
    const lengths = [];
    for (const line of raw.split("\n")) {
      if (!line)
        continue;
      const a = line.indexOf("	");
      const b = line.indexOf("	", a + 1);
      if (a < 0 || b < 0)
        continue;
      keys.push(line.slice(0, a));
      offsets.push(+line.slice(a + 1, b));
      lengths.push(+line.slice(b + 1));
    }
    if (keys.length === 0)
      return;
    this.blocks.set(name, { keys, offsets, lengths });
    // проверяем на самом первом блоке: если Range не поддержан, придёт файл целиком
    const probe = await this.readRange(name, 0);
    if (probe === null) {
      this.blocks.delete(name);
      console.warn(`Russian Rhymes: ${name}.blk.gz — чтение по Range недоступно, читаю шард целиком`);
    }
  }
  /** Сжатый кусок блока i — Range-запросом по ресурсному URL файла. */
  async readRange(name, i) {
    const bi = this.blocks.get(name);
    if (!bi)
      return null;
    const adapter = this.app.vault.adapter;
    if (typeof adapter.getResourcePath !== "function")
      return null;
    const path = this.dictPath(`${name}.blk.gz`);
    const from = bi.offsets[i], len = bi.lengths[i];
    try {
      const resp = await fetch(adapter.getResourcePath(path), {
        headers: { Range: `bytes=${from}-${from + len - 1}` }
      });
      const buf = await resp.arrayBuffer();
      // пришло не ровно столько, сколько просили — Range проигнорирован, блоками нельзя
      return buf.byteLength === len ? buf : null;
    } catch (e) {
      console.error(`Russian Rhymes: Range-чтение ${name} не удалось`, e);
      return null;
    }
  }
  /** Распакованный текст блока i, с кэшем на несколько последних. */
  async blockText(name, i) {
    const ck = name + ":" + i;
    const hit = this.blockCache.get(ck);
    if (hit !== void 0)
      return hit;
    const buf = await this.readRange(name, i);
    if (buf === null)
      return null;
    let text;
    try {
      text = new TextDecoder("utf-8").decode(ungzip_1(new Uint8Array(buf)));
    } catch (e) {
      console.error(`Russian Rhymes: блок ${ck} не распаковался`, e);
      return null;
    }
    this.blockCache.set(ck, text);
    // соседние слова часто попадают в один блок, но держать их все — снова та же память
    if (this.blockCache.size > BLOCK_CACHE)
      this.blockCache.delete(this.blockCache.keys().next().value);
    return text;
  }
  /** Строка блочного шарда: находим нужный блок по индексу и ищем строку уже в нём. */
  async blockLine(name, prefix) {
    const bi = this.blocks.get(name);
    if (!bi)
      return null;
    // последний блок, чей первый ключ не больше искомого
    let lo = 0, hi = bi.keys.length - 1, found = -1;
    while (lo <= hi) {
      const mid = lo + hi >> 1;
      if (bi.keys[mid] <= prefix) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0)
      return null;
    const text = await this.blockText(name, found);
    return text === null ? null : findLine(buildIndex(text), prefix);
  }
  /** Строка шарда: из памяти, если он загружен целиком, иначе с диска по блокам. */
  async shardLine(name, idx, prefix) {
    return idx ? findLine(idx, prefix) : this.blockLine(name, prefix);
  }
  /** Загрузка второй волны; повторные вызовы ждут один и тот же промис. */
  loadHeavy() {
    if (this.loadingHeavy)
      return this.loadingHeavy;
    this.loadingHeavy = this.doLoadHeavy().catch((e) => {
      this.heavyStatus = "error";
      console.error("Russian Rhymes: heavy dictionary load failed", e);
    });
    return this.loadingHeavy;
  }
  async doLoadHeavy() {
    await this.load();
    if (this.status !== "ready") {
      this.heavyStatus = "error";
      return;
    }
    this.heavyStatus = "loading";
    // объектами, а не парами: у массива пар TS выводит на элемент union «строка | функция»,
    // и name + ".txt.gz" ниже становится сложением строки с функцией
    const heavy = [
      { name: "forms", set: (i) => this.formsIdx = i },
      { name: "definitions", set: (i) => this.defs = i }
    ];
    for (const { name, set } of heavy) {
      // блочный шард в память не тянем — ради этого всё и затевалось
      if (this.hasBlocks(name))
        continue;
      // .blk.gz — обычный gzip (склейка членов), читается целиком не хуже .txt.gz.
      // Поэтому в релизе достаточно блочного файла: откат при отсутствии Range берёт его же
      let raw = await this.readGz(name + ".txt.gz");
      if (raw === null)
        raw = await this.readGz(name + ".blk.gz");
      if (raw !== null)
        set(buildIndex(raw));
    }
    this.heavyStatus = "ready";
  }
  readGz(name) {
    // файл основного словаря качается заново по кнопке, поэтому битый можно снести
    // Битый шард можно снести — он качается заново по кнопке. Но НЕ когда словарь лежит
    // в хранилище: удаление уедет синхронизацией и убьёт исправную копию на другом
    // устройстве. Там просто сообщаем о поломке и оставляем файл на месте.
    return this.readGzPath(this.dictPath(name), !this.mainDir);
  }
  /**
   * Прочитать .gz. dropIfCorrupt — сносить ли файл, который не распаковался; так можно
   * поступать только с файлами основного словаря. Личный словарь ниоткуда не качается:
   * его собирают из .dsl минутами, а папка с ним едет синхронизацией — удаление уехало бы
   * и на второе устройство. Поэтому битый личный словарь остаётся лежать, а плагин о нём
   * говорит вслух (localBad).
   */
  async readGzPath(path, dropIfCorrupt = false) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const adapter = this.app.vault.adapter;
    if (!await adapter.exists(path))
      return null;
    const buf = await adapter.readBinary(path);
    try {
      return new TextDecoder("utf-8").decode(ungzip_1(new Uint8Array(buf)));
    } catch (e) {
      if (!dropIfCorrupt) {
        console.error(`Russian Rhymes: corrupt file ${name}, left in place`, e);
        return null;
      }
      console.error(`Russian Rhymes: corrupt shard ${name}, removing`, e);
      try {
        await adapter.remove(path);
      } catch {
        // не удалилось — не беда: файл всё равно перекачивается кнопкой
      }
      return null;
    }
  }
  async doLoad() {
    this.status = "loading";
    await this.resolveDictDir();
    const wordsRaw = await this.readGz("words.txt.gz");
    const rhymesRaw = await this.readGz("rhymes.txt.gz");
    if (wordsRaw === null || rhymesRaw === null) {
      this.status = "missing";
      return;
    }
    this.words = buildIndex(wordsRaw);
    this.rhymes = buildIndex(rhymesRaw);
    this.rhymeSkel = null;
    this.rhymeKeyEnd = null;
    // индексы блочных шардов крошечные, берём их сразу: если они есть, вторая волна
    // этим шардам уже не нужна — читаем с диска
    this.blocks.clear();
    this.blockCache.clear();
    for (const name of HEAVY_SHARDS)
      await this.loadBlockIndex(name);
    const opt = [
      ["synonyms.txt.gz", (i) => this.syns = i],
      ["antonyms.txt.gz", (i) => this.ants = i],
      ["associations.txt.gz", (i) => this.assoc = i],
      ["hypernyms.txt.gz", (i) => this.hyper = i],
      ["hyponyms.txt.gz", (i) => this.hypo = i],
      ["related.txt.gz", (i) => this.related = i],
      ["idioms.txt.gz", (i) => this.idioms = i],
      ["proverbs.txt.gz", (i) => this.proverbs = i],
      ["metagrams.txt.gz", (i) => this.metagrams = i],
      ["anagrams.txt.gz", (i) => this.anagrams = i],
      ["lemmas.txt.gz", (i) => this.lemmas = i],
      ["phrases.txt.gz", (i) => this.phrasesIdx = i]
    ];
    for (const [name, set] of opt) {
      const raw = await this.readGz(name);
      if (raw !== null)
        set(buildIndex(raw));
    }
    const yoRaw = await this.readGz("yo.txt.gz");
    if (yoRaw !== null) {
      for (const line of yoRaw.split("\n")) {
        const tab = line.indexOf("	");
        if (tab > 0)
          this.yoMap.set(line.slice(0, tab), line.slice(tab + 1));
      }
    }
    const genRaw = await this.readGz("generator.txt.gz");
    if (genRaw !== null)
      this.gen = this.parseGenerator(genRaw);
    await this.relocateLocalDicts("");
    this.localBad.clear();
    for (const d of this.manifest) {
      let raw = await this.readGzPath(this.localFilePath(d.id));
      if (raw === null && this.localDir)
        raw = await this.readGzPath(this.legacyLocalPath(d.id));
      if (raw !== null)
        this.local.set(d.id, { name: d.name, idx: buildIndex(raw), enabled: d.enabled, kind: d.kind });
      else if (await this.localFileExists(d.id))
        this.localBad.add(d.id);
    }
    this.status = "ready";
  }
  /**
   * Куда класть личные словари. Папку плагина синхронизация не носит (в ней лежит и
   * 72 МБ основного словаря), поэтому на втором устройстве список словарей был, а самих
   * словарей не было. Папка внутри хранилища едет как обычные файлы.
   */
  setLocalDir(dir) {
    const clean = (dir != null ? dir : "").trim().replace(/^[/\\]+|[/\\]+$/g, "");
    this.localDir = clean ? normalizePath(clean) : "";
  }
  /** Папка основного словаря внутри хранилища; пусто — прежнее место в папке плагина. */
  setMainDir(dir) {
    const clean = (dir != null ? dir : "").trim().replace(/^[/\\]+|[/\\]+$/g, "");
    this.mainDir = clean ? normalizePath(clean) : "";
  }
  /** Куда словарь должен лечь по настройкам. */
  targetDictDir() {
    return this.mainDir || this.legacyDictDir();
  }
  /** Прежнее место — папка плагина. */
  legacyDictDir() {
    return normalizePath(`${this.pluginDir}/dict`);
  }
  /** Файл словаря там, где он реально нашёлся при загрузке (до неё — прежнее место). */
  dictPath(name) {
    return normalizePath(`${this.activeDictDir || this.legacyDictDir()}/${name}`);
  }
  /**
   * Где словарь лежит на самом деле: сначала папка из настроек, иначе прежнее место.
   * Так переезд можно не доводить до конца — плагин всё равно найдёт файлы.
   */
  async resolveDictDir() {
    const adapter = this.app.vault.adapter;
    for (const dir of [this.targetDictDir(), this.legacyDictDir()]) {
      if (await adapter.exists(normalizePath(`${dir}/words.txt.gz`))) {
        this.activeDictDir = dir;
        return;
      }
    }
    this.activeDictDir = this.targetDictDir();
  }
  /** Создать папку словаря по уровням (в хранилище её может не быть вовсе). */
  async ensureDictDir(dir) {
    const adapter = this.app.vault.adapter;
    let path = "";
    for (const part of dir.split("/")) {
      path = path ? `${path}/${part}` : part;
      if (!await adapter.exists(path))
        await adapter.mkdir(path);
    }
  }
  /**
   * Перенести файлы словаря в папку из настроек. Личные словари не трогаем — у них свой
   * переезд. Файл, который уже есть на новом месте, не перезаписываем. onProgress(готово,
   * всего, имя) — переезд идёт десятками мегабайт, без индикатора это выглядит зависанием.
   */
  async relocateDict(oldDir, onProgress) {
    const adapter = this.app.vault.adapter;
    const dst = this.targetDictDir();
    if (!oldDir || oldDir === dst)
      return 0;
    let names = [];
    try {
      const listing = await adapter.list(oldDir);
      names = (listing.files || []).map((p) => p.split("/").pop());
    } catch {
      return 0;
    }
    names = names.filter((n) => /\.(txt|blk|blkidx)\.gz$/.test(n) && !n.startsWith("local-") || n === "files.json");
    if (names.length === 0)
      return 0;
    await this.ensureDictDir(dst);
    let moved = 0, done = 0;
    for (const n of names) {
      const from = normalizePath(`${oldDir}/${n}`);
      const to = normalizePath(`${dst}/${n}`);
      done++;
      if (onProgress)
        onProgress(done, names.length, n);
      if (from === to || await adapter.exists(to) || !await adapter.exists(from))
        continue;
      await adapter.writeBinary(to, await adapter.readBinary(from));
      try {
        await adapter.remove(from);
      } catch {
        // копия уже на новом месте; не снёсся старый файл — это не потеря данных
      }
      moved++;
    }
    this.activeDictDir = dst;
    return moved;
  }
  localFilePath(id) {
    return this.localDir ? normalizePath(`${this.localDir}/local-${id}.txt.gz`) : this.legacyLocalPath(id);
  }
  /** Прежнее место — внутри папки плагина. */
  legacyLocalPath(id) {
    return normalizePath(`${this.pluginDir}/dict/local-${id}.txt.gz`);
  }
  /** Файл словаря лежит на месте, но не читается — его надо ввозить из .dsl заново. */
  isLocalBroken(id) {
    return this.localBad.has(id);
  }
  /** Есть ли файл словаря на этом устройстве (список-то приезжает синхронизацией). */
  async localFileExists(id) {
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(this.localFilePath(id)))
      return true;
    return this.localDir ? adapter.exists(this.legacyLocalPath(id)) : false;
  }
  /** Создать папку под личные словари (в хранилище или, если она не задана, в плагине). */
  async ensureLocalDir() {
    const adapter = this.app.vault.adapter;
    const dir = this.localDir || normalizePath(`${this.pluginDir}/dict`);
    let path = "";
    for (const part of dir.split("/")) {
      path = path ? `${path}/${part}` : part;
      if (!await adapter.exists(path))
        await adapter.mkdir(path);
    }
  }
  /**
   * Перенести файлы словарей из прежней папки в текущую: пустой oldDir — переезд со
   * старого места в плагине (разовая миграция при загрузке), иначе смена папки в настройках.
   * Если в новой папке файл уже есть, старый не трогаем — он там лишний, но и не потерян.
   */
  async relocateLocalDicts(oldDir) {
    const adapter = this.app.vault.adapter;
    let moved = 0;
    for (const d of this.manifest) {
      const src = oldDir ? normalizePath(`${oldDir}/local-${d.id}.txt.gz`) : this.legacyLocalPath(d.id);
      const dst = this.localFilePath(d.id);
      if (src === dst || await adapter.exists(dst) || !await adapter.exists(src))
        continue;
      await this.ensureLocalDir();
      await adapter.writeBinary(dst, await adapter.readBinary(src));
      try {
        await adapter.remove(src);
      } catch {
        // то же: словарь уже переехал, старый файл в худшем случае просто остался лежать
      }
      moved++;
    }
    return moved;
  }
  /**
   * Скачать файлы словаря с baseUrl (GitHub-релиз) в папку dict/. Личные словари
   * (local-*) не трогаются. Возобновляемо: уже скачанный файл нужного размера
   * пропускается. onProgress(done, total, name) — для индикатора.
   */
  async downloadDict(baseUrl, onProgress) {
    const adapter = this.app.vault.adapter;
    // качаем сразу в папку из настроек: если словарь живёт в хранилище, скачанное
    // тут же поедет синхронизацией на остальные устройства
    const dir = this.targetDictDir();
    await this.ensureDictDir(dir);
    this.activeDictDir = dir;
    const base = baseUrl.trim().replace(/\/+$/, "") + "/";
    const listResp = await requestUrl({ url: base + "files.json" });
    const files = JSON.parse(listResp.text).files;
    if (!Array.isArray(files) || files.length === 0)
      throw new Error("empty files.json");
    let done = 0;
    for (const f of files) {
      // .blk.gz — блочный шард, .blkidx.gz — его индекс; без них словарь не доедет до телефона
      if (!/^[\w-]+\.(txt|blk|blkidx)\.gz$/.test(f.name) || f.name.startsWith("local-"))
        continue;
      const path = normalizePath(`${dir}/${f.name}`);
      if (await adapter.exists(path)) {
        const stat = await adapter.stat(path);
        if (stat && stat.size === f.size) {
          onProgress(++done, files.length, f.name);
          continue;
        }
      }
      const buf = await this.fetchChunked(base + f.name, f.size);
      try {
        ungzip_1(new Uint8Array(buf));
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
  async fetchChunked(url, size) {
    const CHUNK = 3 * 1024 * 1024;
    if (size <= CHUNK)
      return (await requestUrl({ url })).arrayBuffer;
    const out = new Uint8Array(size);
    let off = 0;
    while (off < size) {
      const end = Math.min(off + CHUNK, size) - 1;
      const resp = await requestUrl({ url, headers: { Range: `bytes=${off}-${end}` } });
      const chunk = new Uint8Array(resp.arrayBuffer);
      if (chunk.length === 0)
        throw new Error(`empty chunk at ${off} for ${url}`);
      if (resp.status === 200 && chunk.length >= size)
        return resp.arrayBuffer;
      out.set(chunk.subarray(0, Math.min(chunk.length, size - off)), off);
      off += chunk.length;
    }
    return out.buffer;
  }
  /** Перечитать словарь после скачивания (сброс кэша загрузки). */
  async reloadAfterDownload() {
    this.status = "idle";
    this.loading = null;
    // вторую волну тоже перечитать: докачанные formsIdx/defs иначе остались бы пустыми
    this.heavyStatus = "idle";
    this.loadingHeavy = null;
    this.formsIdx = null;
    this.defs = null;
    this.blocks.clear();
    this.blockCache.clear();
    await this.load();
  }
  /** Разбор generator.txt.gz: секции «#n»/«#v»/«#a», строки «слово\tслой». */
  parseGenerator(raw) {
    const g = { n: [], v: [], a: [] };
    let cur = null;
    for (const line of raw.split("\n")) {
      if (line === "#n")
        cur = g.n;
      else if (line === "#v")
        cur = g.v;
      else if (line === "#a")
        cur = g.a;
      else if (line && cur) {
        const tab = line.indexOf("	");
        if (tab < 0)
          continue;
        const tier = +line.slice(tab + 1);
        if (!Number.isInteger(tier) || tier < 0 || tier > 32)
          continue;
        while (cur.length <= tier)
          cur.push([]);
        cur[tier].push(line.slice(0, tab));
      }
    }
    return g;
  }
  /** Объединённый пул слов для генератора по выбранным категориям и слоям (без повторов).
   * Перемешивание и «мешок без повторов» — на стороне view. */
  generatorPool(cats, tiers) {
    const out = [];
    for (const c of cats) {
      if (c === "char")
        out.push(...this.chars);
      else if (this.gen) {
        for (const t2 of tiers)
          if (this.gen[c][t2])
            out.push(...this.gen[c][t2]);
      }
    }
    return [...new Set(out)];
  }
  /**
   * Манифест личных словарей из настроек: задаёт, какие файлы грузить и в каком
   * порядке показывать. Вызывать до load(); повторный вызов синхронизирует порядок
   * и имена уже загруженных индексов.
   */
  setLocalManifest(dicts) {
    this.manifest = dicts.map((d) => ({ id: d.id, name: d.name, enabled: d.enabled, kind: d.kind === "syns" ? "syns" : "defs" }));
    this.localOrder = dicts.map((d) => d.id);
    for (const d of dicts) {
      const e = this.local.get(d.id);
      if (e) {
        e.name = d.name;
        e.enabled = d.enabled;
        e.kind = d.kind === "syns" ? "syns" : "defs";
      }
    }
  }
  /** Включить/отключить личный словарь в выдаче (файл и индекс остаются загруженными). */
  setEnabled(id, enabled) {
    const e = this.local.get(id);
    if (e)
      e.enabled = enabled;
    const m = this.manifest.find((x) => x.id === id);
    if (m)
      m.enabled = enabled;
  }
  /** Добавить/заменить личный словарь: записать файл, построить индекс, встать в конец порядка. */
  async importDict(id, name, entries, kind) {
    const lines = [];
    for (const [w, g] of entries)
      lines.push(`${w}	${g.join("|")}`);
    lines.sort();
    const raw = lines.join("\n");
    const adapter = this.app.vault.adapter;
    await this.ensureLocalDir();
    const gz = gzip_1(raw);
    await adapter.writeBinary(this.localFilePath(id), gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength));
    this.local.set(id, { name, idx: buildIndex(raw), enabled: true, kind: kind === "syns" ? "syns" : "defs" });
    this.localBad.delete(id);
    if (!this.localOrder.includes(id))
      this.localOrder.push(id);
    return entries.size;
  }
  /** Удалить личный словарь (файл + индекс + место в порядке). */
  async deleteDict(id) {
    const adapter = this.app.vault.adapter;
    for (const path of [this.localFilePath(id), this.legacyLocalPath(id)]) {
      if (await adapter.exists(path))
        await adapter.remove(path);
    }
    this.local.delete(id);
    this.localBad.delete(id);
    this.localOrder = this.localOrder.filter((x) => x !== id);
  }
  /** Переименовать личный словарь (имя — подпись группы во вкладке «Значение»). */
  renameDict(id, name) {
    const e = this.local.get(id);
    if (e)
      e.name = name;
  }
  /** Леммы словоформы по словарю Зализняка («разуму» -> [разум]). */
  lemmasOf(word) {
    if (!this.lemmas)
      return [];
    const line = findLine(this.lemmas, word + "	");
    return line ? line.slice(word.length + 1).split(",") : [];
  }
  /** Простой формат личных DSL-словарей: "POS:толк1;толк2|POS:…" (без примеров/этимологии). */
  parseLocalGroups(rec) {
    return rec.split("|").map((g) => {
      const colon = g.indexOf(":");
      const pos = colon > 0 ? g.slice(0, colon) : "";
      const senses = g.slice(colon + 1).split(";").map((gloss) => ({ gloss }));
      return { pos, senses };
    });
  }
  /** Богатая статья Викисловаря: этимология + группы с примерами (см. build-definitions.mjs). */
  parseWikiRecord(rec) {
    const parts = rec.split(DEF_GS);
    const etymology = parts[0] || "";
    const groups = [];
    for (const gp of parts.slice(1)) {
      const seg = gp.split(DEF_US);
      const pos = seg[0];
      const senses = seg.slice(1).map((s) => {
        const chunks = s.split(DEF_RS);
        const examples = chunks.slice(1).map((e) => {
          const fs = e.indexOf(DEF_FS);
          return fs >= 0 ? { text: e.slice(0, fs), ref: e.slice(fs + 1) } : { text: e };
        });
        return examples.length ? { gloss: chunks[0], examples } : { gloss: chunks[0] };
      });
      groups.push({ pos, senses, wiki: true });
    }
    return { etymology, groups };
  }
  /** Группы личных толковых словарей для слова — в порядке localOrder, каждая подписана именем словаря. */
  localDefGroups(word) {
    const out = [];
    for (const id of this.localOrder) {
      const e = this.local.get(id);
      if (!e || !e.enabled || e.kind === "syns")
        continue;
      const line = findLine(e.idx, word + "	");
      if (!line)
        continue;
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
  async defArticle(word) {
    const localGroups = this.localDefGroups(word);
    let lemma = word;
    let mainGroups = [];
    let etymology = "";
    if (this.defs || this.hasBlocks("definitions")) {
      let line = await this.shardLine("definitions", this.defs, lemma + "	");
      if (line && line[lemma.length + 1] === ">") {
        lemma = line.slice(lemma.length + 2);
        line = await this.shardLine("definitions", this.defs, lemma + "	");
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
    const groups = [...mainGroups, ...localGroups].slice(0, 20);
    if (groups.length === 0)
      return null;
    return {
      lemma: localGroups.length > 0 && mainGroups.length === 0 ? word : lemma,
      etymology: etymology || void 0,
      groups,
      wiki: mainGroups,
      local: localGroups
    };
  }
  /**
   * Толкования: статья Викисловаря всегда идёт первой. Если у самой формы её нет
   * («шнурки», «юмора»), берём статью леммы — иначе «Значение» показывало бы одни
   * личные словари, у которых форма нашлась как отдельное заглавное слово.
   */
  async definitionsFor(word) {
    const own = await this.defArticle(word);
    if (own && own.wiki.length > 0)
      return own;
    const names = [];
    const groups = [];
    const wiki = [];
    let etymology = own ? own.etymology : void 0;
    for (const lm of this.lemmasOf(word).slice(0, 2)) {
      const d = await this.defArticle(lm);
      if (d && !names.includes(d.lemma)) {
        names.push(d.lemma);
        groups.push(...d.groups);
        wiki.push(...d.wiki);
        if (!etymology && d.etymology)
          etymology = d.etymology;
      }
    }
    if (own) {
      // статьи личных словарей по самой форме — после статьи леммы и без повторов словарей
      const seen = new Set(groups.map((g) => g.pos));
      for (const g of own.local)
        if (!seen.has(g.pos))
          groups.push(g);
    }
    if (groups.length === 0)
      return null;
    return {
      lemma: names.length ? names.join(", ") : own.lemma,
      etymology,
      groups: groups.slice(0, 8),
      wiki,
      local: own ? own.local : []
    };
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
  buildRhymeIndex() {
    const idx = this.rhymes;
    if (!idx) {
      this.rhymeSkel = [];
      this.rhymeKeyEnd = new Uint32Array(0);
      return;
    }
    const { text, offsets } = idx;
    const n = offsets.length;
    const skel = new Array(n);
    const ends = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const start = offsets[i];
      const lineEnd = i + 1 < n ? offsets[i + 1] - 1 : text.length;
      let tab = text.indexOf("	", start);
      if (tab < 0 || tab > lineEnd)
        tab = -1;
      ends[i] = tab < 0 ? 0 : tab;
      skel[i] = tab < 0 ? "\uFFFF" : vowelSkeleton(text.slice(start, tab));
    }
    this.rhymeSkel = skel;
    this.rhymeKeyEnd = ends;
  }
  assonancesFor(word, s) {
    const res = { conson: [], asson: [] };
    if (!this.rhymes)
      return res;
    const { key } = rhymeKey(word, s);
    const skel = vowelSkeleton(key);
    if (!skel)
      return res;
    if (!this.rhymeSkel || !this.rhymeKeyEnd)
      this.buildRhymeIndex();
    const skelArr = this.rhymeSkel;
    const ends = this.rhymeKeyEnd;
    const qCons = consonantSkeleton(key);
    const { text, offsets } = this.rhymes;
    const qSyl = countSyllables(word);
    const qVerb = this.isVerb(word);
    for (let i = 0; i < offsets.length; i++) {
      if (skelArr[i] !== skel)
        continue;
      const start = offsets[i];
      const tab = ends[i];
      const k = text.slice(start, tab);
      if (k === key)
        continue;
      const out = consonantSkeleton(k) === qCons ? res.conson : res.asson;
      const nl = text.indexOf("\n", tab);
      const rec = text.slice(tab + 1, nl < 0 ? text.length : nl);
      for (const item of rec.split("|")) {
        const [w, s36, f, p] = item.split(",");
        if (w === word || w.length < 3 || p === "x" || looksSameRoot(w, word))
          continue;
        if (qVerb && p === "v" && prefixVerbPair(w, word))
          continue;
        out.push({ word: w, s: parseInt(s36, 36), f: +f, p, syl: countSyllables(w), exact: false });
      }
    }
    const cmp = (a, b) => b.f - a.f || Math.abs(a.syl - qSyl) - Math.abs(b.syl - qSyl) || (a.word < b.word ? -1 : 1);
    res.conson.sort(cmp);
    res.asson.sort(cmp);
    res.conson = res.conson.slice(0, 2e3);
    res.asson = res.asson.slice(0, 2e3);
    return res;
  }
  groupsAt(idx, word) {
    if (!idx)
      return null;
    const line = findLine(idx, word + "	");
    if (!line)
      return null;
    return line.slice(word.length + 1).split("|").map((g) => g.split(","));
  }
  /** Свои группы слова, иначе — группы его лемм (с пометкой, чьи они). */
  resolveGroups(get, word, maxGroups) {
    const own = get(word);
    if (own)
      return { lemma: null, groups: own.slice(0, maxGroups) };
    const names = [];
    const groups = [];
    for (const lm of this.lemmasOf(word).slice(0, 2)) {
      const g = get(lm);
      if (g && !names.includes(lm)) {
        names.push(lm);
        groups.push(...g);
      }
    }
    if (groups.length === 0)
      return null;
    return { lemma: names.join(", "), groups: groups.slice(0, maxGroups) };
  }
  /** Синонимы: Викисловарь + Абрамов/АОТ. */
  synonymsFor(word) {
    return this.resolveGroups((w) => this.groupsAt(this.syns, w), word, 10);
  }
  /**
   * Личные словари синонимов — каждый отдельным блоком во вкладке «Синонимы»,
   * в том же порядке, что задан перетаскиванием в настройках.
   */
  localSynDicts(word) {
    const out = [];
    for (const id of this.localOrder) {
      const e = this.local.get(id);
      if (!e || !e.enabled || e.kind !== "syns")
        continue;
      const res = this.resolveGroups((w) => this.groupsAt(e.idx, w), word, 6);
      if (res)
        out.push({ id, name: e.name, lemma: res.lemma, groups: res.groups });
    }
    return out;
  }
  /** Антонимы (Викисловарь). */
  antonymsFor(word) {
    return this.resolveGroups((w) => this.groupsAt(this.ants, w), word, 3);
  }
  /** Ассоциации (КартаСлов). */
  associationsFor(word) {
    return this.resolveGroups((w) => this.groupsAt(this.assoc, w), word, 3);
  }
  /** Гиперонимы — общее понятие (Викисловарь): дорога → пространство, линия. */
  hypernymsFor(word) {
    return this.resolveGroups((w) => this.groupsAt(this.hyper, w), word, 1);
  }
  /** Гипонимы — частные виды (Викисловарь): дорога → улица, тропа, шоссе. */
  hyponymsFor(word) {
    return this.resolveGroups((w) => this.groupsAt(this.hypo, w), word, 1);
  }
  /** Родственные слова — однокоренные (Викисловарь): быстрый → быстро, быстрота. */
  relatedFor(word) {
    return this.resolveGroups((w) => this.groupsAt(this.related, w), word, 1);
  }
  /** Метаграммы — слова, отличающиеся одной буквой (Викисловарь): хлеб → Глеб, хлев. */
  metagramsFor(word) {
    return this.resolveGroups((w) => this.groupsAt(this.metagrams, w), word, 1);
  }
  /** Анаграммы (Викисловарь): дом → мод. */
  anagramsFor(word) {
    return this.resolveGroups((w) => this.groupsAt(this.anagrams, w), word, 1);
  }
  phraseItems(word) {
    if (!this.phrasesIdx)
      return null;
    const line = findLine(this.phrasesIdx, word + "	");
    if (!line)
      return null;
    return line.slice(word.length + 1).split("|").map((it) => {
      const tilde = it.indexOf("~");
      return { phrase: tilde > 0 ? it.slice(0, tilde) : it, gloss: tilde > 0 ? it.slice(tilde + 1) : "" };
    });
  }
  /** Фразы и идиомы со словом (Викисловарь); свои, иначе — по леммам. */
  phrasesFor(word) {
    const own = this.phraseItems(word);
    if (own)
      return { lemma: null, items: own };
    const names = [];
    const items = [];
    const seen = /* @__PURE__ */ new Set();
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
    if (items.length === 0)
      return null;
    return { lemma: names.join(", "), items };
  }
  stringListAt(idx, word, sep) {
    if (!idx)
      return null;
    const line = findLine(idx, word + "	");
    return line ? line.slice(word.length + 1).split(sep) : null;
  }
  /** Свой список строк, иначе — списки лемм (идиомы/пословицы; sep — разделитель файла). */
  resolveStringList(idx, word, sep) {
    const own = this.stringListAt(idx, word, sep);
    if (own)
      return { lemma: null, items: own };
    const names = [];
    const items = [];
    const seen = /* @__PURE__ */ new Set();
    for (const lm of this.lemmasOf(word).slice(0, 2)) {
      const got = this.stringListAt(idx, lm, sep);
      if (got && !names.includes(lm)) {
        names.push(lm);
        for (const it of got)
          if (!seen.has(it)) {
            seen.add(it);
            items.push(it);
          }
      }
    }
    if (items.length === 0)
      return null;
    return { lemma: names.join(", "), items };
  }
  /** Устойчивые сочетания и идиомы (Викисловарь): вот где собака зарыта. */
  idiomsFor(word) {
    return this.resolveStringList(this.idioms, word, "|");
  }
  /** Пословицы и поговорки (Викисловарь): хлеб — всему голова. */
  proverbsFor(word) {
    return this.resolveStringList(this.proverbs, word, "|");
  }
  /** Парадигма словоформ с ударениями (Викисловарь); свои, иначе — у леммы формы. */
  async formsFor(word) {
    const parse = async (w) => {
      const line = await this.shardLine("forms", this.formsIdx, w + "	");
      if (!line)
        return null;
      return line.slice(w.length + 1).split("|").map((e) => {
        const c = e.indexOf(":");
        return { label: c >= 0 ? e.slice(0, c) : "", form: c >= 0 ? e.slice(c + 1) : e };
      });
    };
    const own = await parse(word);
    if (own)
      return { lemma: null, rows: own };
    for (const lm of this.lemmasOf(word).slice(0, 1)) {
      const rows = await parse(lm);
      if (rows)
        return { lemma: lm, rows };
    }
    return null;
  }
  /** Ёфикация ввода: е-написание -> однозначная ё-версия (береза->берёза); мед/небо/лет не трогает. */
  normalizeYo(word) {
    let _a;
    return (_a = this.yoMap.get(word)) != null ? _a : word;
  }
  /**
   * Аллитерации: слова с тем же начальным согласным кластером (стр → страна, строка,
   * струна…) — для созвучных зачинов строк. Слова отсортированы, поэтому нижнюю границу
   * префикса ищем бинарно, дальше линейный скан по блоку.
   */
  alliterationsFor(word) {
    let _a;
    if (!this.words)
      return [];
    const prefix = alliterationPrefix(word);
    if (prefix.length < 2)
      return [];
    const { text, offsets } = this.words;
    let lo = 0, hi = offsets.length - 1, start = offsets.length;
    while (lo <= hi) {
      const mid = lo + hi >> 1;
      const s = offsets[mid];
      const probe = text.slice(s, Math.min(s + prefix.length, text.length));
      if (probe < prefix)
        lo = mid + 1;
      else {
        start = mid;
        hi = mid - 1;
      }
    }
    const qSyl = countSyllables(word);
    const out = [];
    for (let i = start; i < offsets.length; i++) {
      const s = offsets[i];
      if (!text.startsWith(prefix, s))
        break;
      const tab = text.indexOf("	", s);
      const w = text.slice(s, tab);
      if (w === word || looksSameRoot(w, word))
        continue;
      const nl = text.indexOf("\n", tab);
      const [s36, f, p] = text.slice(tab + 1, nl < 0 ? text.length : nl).split(";")[0].split(",");
      if (p === "x")
        continue;
      out.push({ word: w, s: parseInt(s36, 36), f: +f, p, syl: countSyllables(w), exact: false });
    }
    const byLemma = /* @__PURE__ */ new Map();
    for (const e of out) {
      const lemma = (_a = this.lemmasOf(e.word)[0]) != null ? _a : e.word;
      const prev = byLemma.get(lemma);
      if (!prev || e.word === lemma || prev.word !== lemma && e.f > prev.f)
        byLemma.set(lemma, e);
    }
    const list = [...byLemma.values()];
    list.sort((a, b) => b.f - a.f || Math.abs(a.syl - qSyl) - Math.abs(b.syl - qSyl) || (a.word < b.word ? -1 : 1));
    return list.slice(0, 2e3);
  }
  /** Варианты ударения слова или null, если слова нет. */
  lookup(word) {
    if (!this.words)
      return null;
    const line = findLine(this.words, word + "	");
    if (!line)
      return null;
    return line.slice(word.length + 1).split(";").map((v) => {
      const [s36, f, p] = v.split(",");
      return { s: parseInt(s36, 36), f: +f, p };
    });
  }
  /** Глагол ли слово хоть в одном варианте — для отсева приставочных пар. */
  isVerb(word) {
    const v = this.lookup(word);
    return !!v && v.some((x) => x.p === "v");
  }
  /** Отранжированные рифмы к слову в конкретном варианте ударения. */
  rhymesFor(word, s) {
    if (!this.rhymes)
      return [];
    const { key, support } = rhymeKey(word, s);
    const line = findLine(this.rhymes, key + "	");
    if (!line)
      return [];
    const qSyl = countSyllables(word);
    const qVerb = this.isVerb(word);
    const out = [];
    for (const item of line.slice(key.length + 1).split("|")) {
      const [w, s36, f, p] = item.split(",");
      // однобуквенные «а», «о», «и» — не рифмы, а мусор словаря; раньше их прятало
      // хвостовое правило, теперь отсекаем прямо
      if (w === word || w.length < 2 || looksSameRoot(w, word))
        continue;
      if (qVerb && p === "v" && prefixVerbPair(w, word))
        continue;
      const si = parseInt(s36, 36);
      out.push({
        word: w,
        s: si,
        f: +f,
        p,
        syl: countSyllables(w),
        exact: rhymeKey(w, si).support === support
      });
    }
    out.sort(
      (a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0) || b.f - a.f || Math.abs(a.syl - qSyl) - Math.abs(b.syl - qSyl) || (a.word < b.word ? -1 : 1)
    );
    return out;
  }
};

export { RhymeDict };
