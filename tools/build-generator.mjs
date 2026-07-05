// Пулы слов для генератора-пасхалки «фристайл»: общеупотребимые существительные
// (им.п. ед.ч.), глаголы (инфинитив), прилагательные (им.п. ед.ч. м.р.) — заголовки
// статей русского Викисловаря как раз в этих формах. Частота и ударение — из words.txt.gz.
// Выход: dict/generator.txt.gz — секции «#n»/«#v»/«#a», слова с ударением, по частоте.
// Запуск: node tools/build-generator.mjs [--src <kaikki-ru.jsonl.gz>]

import { createReadStream, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip, gunzipSync, gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markStress } from "../src/phonetics.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const iSrc = args.indexOf("--src");
const SRC = iSrc >= 0 ? args[iSrc + 1] : join(HERE, "sources", "kaikki-ru.jsonl.gz");
const OUT = join(HERE, "..", "dict");

const WORD_RE = /^[а-яё]+$/; // одно слово, без дефисов/пробелов
const CAP_TIER = 8000; // слов на (категория × лексический слой), топ по частоте
// лексический слой по частотному бакету 0..9 — как в панели рифм (view.ts lexCat)
const lexCat = (f) => (f >= 5 ? 0 : f >= 3 ? 1 : f >= 1 ? 2 : 3); // 0 базовая..3 редкая

// POS в Викисловаре шумит: в топ по частоте лезут местоимения, предикативы, сравнительные,
// союзы. Отсекаем по форме окончания и стоп-листом служебных слов.
const VERB_END = /(ть|ти|чь|ся)$/; // инфинитив, вкл. возвратные -ться/-чься
const ADJ_END = /(ый|ий|ой)$/; // прилагательное в им.п. ед.ч. м.р. (не сравнит./предикатив)
const STOP = new Set([
  "это", "оно", "она", "они", "он", "кто", "что", "никто", "ничто", "некто", "нечто",
  "сам", "себя", "весь", "всё", "тот", "этот", "сей", "каждый", "любой", "иной", "другой",
  "свой", "наш", "ваш", "твой", "мой", "чей", "такой", "который", "какой",
]);
const okWord = (pos, w) => {
  if (STOP.has(w)) return false;
  if (pos === "verb") return VERB_END.test(w);
  if (pos === "adj") return ADJ_END.test(w);
  return true; // noun
};

const t0 = Date.now();
const log = (m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

// частота + ударение по слову из words.txt.gz (берём вариант с макс. частотой)
log("words.txt.gz…");
const words = new Map(); // word -> { f, s }
{
  const text = gunzipSync(readFileSync(join(OUT, "words.txt.gz"))).toString("utf8");
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const w = line.slice(0, tab);
    let bestF = -1, bestS = 0;
    for (const v of line.slice(tab + 1).split(";")) {
      const [s36, f] = v.split(",");
      const fi = +f;
      if (fi > bestF) {
        bestF = fi;
        bestS = parseInt(s36, 36);
      }
    }
    words.set(w, { f: bestF, s: bestS });
  }
  log(`  слов: ${words.size}`);
}

const cats = { noun: new Map(), verb: new Map(), adj: new Map() }; // pos -> Map(word -> {f, marked})
let lines = 0;
const rl = createInterface({ input: createReadStream(SRC).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of rl) {
  lines++;
  if (lines % 100000 === 0) log(`строк: ${lines}`);
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  const pos = obj.pos;
  const bucket = cats[pos];
  if (!bucket) continue;
  if (/^[А-ЯЁ]/.test(obj.word || "")) continue; // имена собственные — вон
  const w = (obj.word || "").toLowerCase();
  if (!WORD_RE.test(w) || w.length < 3) continue;
  // статьи-словоформы (form-of) не берём — нужна лемма
  const senses = obj.senses || [];
  if (senses.length > 0 && senses.every((s) => (s.form_of && s.form_of.length) || (s.tags || []).includes("form-of"))) continue;
  if (!okWord(pos, w)) continue;
  const info = words.get(w);
  if (!info) continue; // нет в словаре ударений — пропускаем (нужно ударение)
  if (!bucket.has(w)) bucket.set(w, { f: info.f, marked: markStress(w, info.s) });
}
log(`прочитано строк: ${lines}`);

// Только базовая (слой 0) и частотная (слой 1) — Лев решил без обычной/редкой.
// Формат: секции «#n»/«#v»/«#a», строки «слово\tслой» (0 базовая, 1 частотная).
const TIERS = 2;
const out = [];
for (const [pos, key] of [["noun", "n"], ["verb", "v"], ["adj", "a"]]) {
  out.push("#" + key);
  const byTier = [[], [], [], []];
  for (const x of cats[pos].values()) byTier[lexCat(x.f)].push(x);
  let kept = 0;
  for (let t = 0; t < TIERS; t++) {
    byTier[t].sort((a, b) => b.f - a.f);
    for (const x of byTier[t].slice(0, CAP_TIER)) {
      out.push(`${x.marked}\t${t}`);
      kept++;
    }
  }
  log(`${pos}: базовая ${Math.min(byTier[0].length, CAP_TIER)}, частотная ${Math.min(byTier[1].length, CAP_TIER)} → взято ${kept} (обыч/редк отброшены)`);
}

mkdirSync(OUT, { recursive: true });
const raw = out.join("\n");
const gz = gzipSync(raw, { level: 9 });
writeFileSync(join(OUT, "generator.txt.gz"), gz);
log(`generator: ${(raw.length / 1048576).toFixed(2)} MB -> ${(gz.length / 1048576).toFixed(2)} MB`);
