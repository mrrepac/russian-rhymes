// Семантические связи и «игра слов» из русского Викисловаря (kaikki.org / wiktextract, CC BY-SA).
// Вход: kaikki-ru.jsonl.gz. Поля берём и из статьи, и из каждого значения.
// Выход (формат "слово\tзнач1<sep>знач2…"):
//   dict/hypernyms.txt.gz  (,) — гиперонимы: дорога→пространство, линия
//   dict/hyponyms.txt.gz   (,) — гипонимы: дорога→улица, тропа, шоссе
//   dict/related.txt.gz    (,) — родственные слова: быстрый→быстро, быстрота
//   dict/idioms.txt.gz     (|) — устойчивые сочетания/идиомы (derived): вот где собака зарыта
//   dict/proverbs.txt.gz   (|) — пословицы и поговорки: хлеб — всему голова
//   dict/metagrams.txt.gz  (,) — метаграммы (слово в одну букву): хлеб→Глеб, хлев
//   dict/anagrams.txt.gz   (,) — анаграммы
// Слова-связи (,) — только кириллица, короткие фразы; фразы (|) — предложения.
// Запуск: node tools/build-linkages.mjs [--src <kaikki-ru.jsonl.gz>]

import { createReadStream, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip, gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const iSrc = args.indexOf("--src");
const SRC = iSrc >= 0 ? args[iSrc + 1] : join(HERE, "sources", "kaikki-ru.jsonl.gz");
const OUT = join(HERE, "..", "dict");

const HEAD_RE = /^[а-яё]+(-[а-яё]+)*$/; // заголовочное слово статьи
const LINK_RE = /^[а-яё]+([ -][а-яё]+){0,2}$/; // связанное слово / короткая фраза (lowercase)
const WORD_RE = /^[а-яёА-ЯЁ]+(-[а-яёА-ЯЁ]+)*$/; // одно слово (регистр сохраняем — Глеб)

const clean = (s) => (s || "").replace(/[\x1c-\x1f]/g, " ").replace(/\s+/g, " ").trim();

// связь-слово: '?' режет хвост-альтернативу; dropProper выкидывает имена собственные
function linkVal(raw, dropProper) {
  let v = clean(raw).split(/[?？]/)[0].trim();
  if (!v) return null;
  if (dropProper && /^[А-ЯЁ]/.test(v)) return null;
  v = v.toLowerCase();
  return LINK_RE.test(v) ? v : null;
}
// одно слово, регистр сохраняем (метаграммы/анаграммы)
function wordVal(raw) {
  const v = clean(raw).split(/[?？]/)[0].trim();
  return WORD_RE.test(v) ? v : null;
}
// фраза/предложение: без латиницы и цифр, '|' заменяем (это наш разделитель)
function phraseVal(raw, lower, min, max) {
  let v = clean(raw).replaceAll("|", "/").replace(/[\^*△▲✳]/g, "").replace(/\s+/g, " ").trim();
  if (lower) v = v.toLowerCase();
  if (v.length < min || v.length > max) return null;
  if (!/[а-яё]/i.test(v) || /[a-z0-9]/i.test(v)) return null;
  return v;
}

const SPECS = [
  { field: "hypernyms", file: "hypernyms.txt.gz", cap: 16, sep: ",", accept: (r) => linkVal(r, false) },
  { field: "hyponyms", file: "hyponyms.txt.gz", cap: 20, sep: ",", accept: (r) => linkVal(r, false) },
  { field: "related", file: "related.txt.gz", cap: 24, sep: ",", accept: (r) => linkVal(r, true) },
  { field: "derived", file: "idioms.txt.gz", cap: 30, sep: "|", accept: (r) => phraseVal(r, true, 3, 70) },
  { field: "proverbs", file: "proverbs.txt.gz", cap: 24, sep: "|", accept: (r) => phraseVal(r, false, 6, 140) },
  { field: "metagrams", file: "metagrams.txt.gz", cap: 24, sep: ",", accept: wordVal },
  { field: "anagrams", file: "anagrams.txt.gz", cap: 24, sep: ",", accept: wordVal },
];

const maps = new Map(SPECS.map((s) => [s.field, new Map()])); // field -> (word -> Set)

const t0 = Date.now();
const log = (m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

// значения поля и из статьи, и из каждого значения (у proverbs/derived — тоже .word)
function collect(obj, field) {
  const out = [];
  for (const rec of obj[field] || []) out.push(rec.word);
  for (const s of obj.senses || []) for (const rec of s[field] || []) out.push(rec.word);
  return out;
}

let lines = 0;
const rl = createInterface({ input: createReadStream(SRC).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of rl) {
  lines++;
  if (lines % 200000 === 0) log(`строк: ${lines}`);
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  const word = (obj.word || "").toLowerCase();
  if (!HEAD_RE.test(word)) continue;
  for (const spec of SPECS) {
    const map = maps.get(spec.field);
    let set = null;
    for (const raw of collect(obj, spec.field)) {
      const v = spec.accept(raw);
      if (!v || v.toLowerCase() === word) continue;
      if (!set) {
        set = map.get(word);
        if (!set) map.set(word, (set = new Set()));
      }
      if (set.size < spec.cap) set.add(v);
    }
  }
}
log(`прочитано строк: ${lines}`);

mkdirSync(OUT, { recursive: true });
for (const spec of SPECS) {
  const map = maps.get(spec.field);
  const rows = [];
  for (const [word, set] of map) if (set.size) rows.push(`${word}\t${[...set].join(spec.sep)}`);
  rows.sort();
  const raw = rows.join("\n");
  const gz = gzipSync(raw, { level: 9 });
  writeFileSync(join(OUT, spec.file), gz);
  log(`${spec.field}: ${rows.length} слов, ${(raw.length / 1048576).toFixed(1)} MB -> ${(gz.length / 1048576).toFixed(1)} MB`);
}
