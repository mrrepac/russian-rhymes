// Синонимы и антонимы.
// Источники:
//   1. Тезаурус LibreOffice ru_RU (АОТ + Абрамов 1911, LGPL 2.1) — th_ru_RU.dat
//   2. Русский Викисловарь (kaikki.org / wiktextract, CC BY-SA) — kaikki-ru.jsonl.gz:
//      поля synonyms/antonyms статьи и каждого значения
// Выход:
//   dict/synonyms.txt.gz — "слово\tгруппа|группа" (группа = син1,син2; викигруппа первой)
//   dict/antonyms.txt.gz — "слово\tант1,ант2,..."
// Запуск: node tools/build-synonyms.mjs [--th <th_ru_RU.dat>] [--kaikki <kaikki-ru.jsonl.gz>]

import { createReadStream, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip, gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const TH = argOf("--th", join(HERE, "sources", "th_ru_RU.dat"));
const KAIKKI = argOf("--kaikki", join(HERE, "sources", "kaikki-ru.jsonl.gz"));
const OUT = join(HERE, "..", "dict");

const WORD_RE = /^[а-яё]+([ -][а-яё]+){0,2}$/; // слово или короткая фраза
const MAX_SYN = 18;
const MAX_ANT = 10;

const t0 = Date.now();
const log = (m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

// --- 1) Абрамов/АОТ: группы по смыслам ---
log("Тезаурус Абрамова/АОТ...");
const abramov = new Map(); // слово -> [группы]
{
  const lines = readFileSync(TH, "utf8").split(/\r?\n/);
  let n = 1;
  while (n < lines.length) {
    const head = lines[n++];
    if (!head) continue;
    const bar = head.lastIndexOf("|");
    if (bar < 0) continue;
    const word = head.slice(0, bar).trim().toLowerCase();
    const count = parseInt(head.slice(bar + 1), 10) || 0;
    for (let k = 0; k < count && n < lines.length; k++) {
      const parts = lines[n++]
        .split("|")
        .slice(1)
        .map((s) => s.trim().toLowerCase().replace(/[*/]/g, ""))
        .filter((s) => s && WORD_RE.test(s) && !s.includes(",") && s !== word);
      if (!WORD_RE.test(word) || parts.length === 0) continue;
      let arr = abramov.get(word);
      if (!arr) abramov.set(word, (arr = []));
      arr.push(parts);
    }
  }
  log(`  слов: ${abramov.size}`);
}

// --- 2) Викисловарь: синонимы и антонимы ---
log("Викисловарь (kaikki)...");
const wikiSyn = new Map(); // слово -> Set
const wikiAnt = new Map();
{
  const rl = createInterface({ input: createReadStream(KAIKKI).pipe(createGunzip()), crlfDelay: Infinity });
  const collect = (obj, field) => {
    const out = [];
    for (const rec of obj[field] || []) out.push(rec);
    for (const s of obj.senses || []) for (const rec of s[field] || []) out.push(rec);
    return out;
  };
  for await (const line of rl) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const word = (obj.word || "").toLowerCase();
    if (!/^[а-яё]+(-[а-яё]+)*$/.test(word)) continue;
    for (const [field, map, cap] of [
      ["synonyms", wikiSyn, MAX_SYN],
      ["antonyms", wikiAnt, MAX_ANT],
    ]) {
      for (const rec of collect(obj, field)) {
        const w = (rec.word || "").toLowerCase().trim();
        if (!w || w === word || !WORD_RE.test(w) || w.includes(",")) continue;
        let set = map.get(word);
        if (!set) map.set(word, (set = new Set()));
        if (set.size < cap) set.add(w);
      }
    }
  }
  log(`  синонимы: ${wikiSyn.size} слов, антонимы: ${wikiAnt.size} слов`);
}

// --- 3) Слияние синонимов: викигруппа первой, затем группы Абрамова ---
const allSynWords = new Set([...abramov.keys(), ...wikiSyn.keys()]);
const synOut = [];
for (const word of allSynWords) {
  const groups = [];
  const wiki = wikiSyn.get(word);
  if (wiki && wiki.size) groups.push([...wiki].join(","));
  const seen = new Set();
  for (const g of abramov.get(word) ?? []) {
    const sig = g.join(",");
    if (!seen.has(sig)) {
      seen.add(sig);
      groups.push(sig);
    }
  }
  if (groups.length) synOut.push(`${word}\t${groups.join("|")}`);
}
synOut.sort();

const antOut = [];
for (const [word, set] of wikiAnt) antOut.push(`${word}\t${[...set].join(",")}`);
antOut.sort();

mkdirSync(OUT, { recursive: true });
const synRaw = synOut.join("\n");
const synGz = gzipSync(synRaw, { level: 9 });
writeFileSync(join(OUT, "synonyms.txt.gz"), synGz);
const antRaw = antOut.join("\n");
const antGz = gzipSync(antRaw, { level: 9 });
writeFileSync(join(OUT, "antonyms.txt.gz"), antGz);
log(`synonyms: ${synOut.length} слов, ${(synRaw.length / 1048576).toFixed(1)} MB -> ${(synGz.length / 1048576).toFixed(1)} MB`);
log(`antonyms: ${antOut.length} слов, ${(antRaw.length / 1048576).toFixed(1)} MB -> ${(antGz.length / 1048576).toFixed(1)} MB`);
