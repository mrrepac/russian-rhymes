// Безопасная карта ёфикации ввода (dict/yo.txt.gz): слово-без-ё -> слово-с-ё.
// Только ОДНОЗНАЧНЫЕ пары, где е-написание в Викисловаре помечено ИСКЛЮЧИТЕЛЬНО как
// «неёфицированная форма <ё-слова>» и не имеет ни одного самостоятельного значения
// (небо=sky, мед=медвуз, лет=формы лето — сами отсекаются). Для рантайм-подмены ввода.
//
// Запуск: node --max-old-space-size=4096 tools/build-yomap.mjs
import { createReadStream, writeFileSync } from "node:fs";
import { createGunzip, gzipSync } from "node:zlib";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const KAIKKI = join(HERE, "sources", "kaikki-ru.jsonl.gz");
const OUT = join(HERE, "..", "dict", "yo.txt.gz");
const WORD_RE = /^[а-яё]+(-[а-яё]+)*$/;
const deyo = (s) => s.replace(/ё/g, "е");
const NEYO = /ёфицированн/; // маркер «неёфицированная форма …» в толковании

// yoByPlain: е-написание -> набор ё-ЛЕММ (у которых оно ё-версия);
// dirty: е-написания, у которых есть СВОЙ смысл (не только «неёфицированная форма»)
const yoByPlain = new Map();
const dirty = new Set();
const rl = createInterface({ input: createReadStream(KAIKKI).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line) continue;
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  const w = (o.word || "").toLowerCase();
  if (!WORD_RE.test(w)) continue;
  const senses = o.senses || [];
  if (w.includes("ё")) {
    // ё-лемма — есть настоящее толкование (сенс с глоссой и без form_of/alt_of)
    const isLemma = senses.some((s) => (s.glosses || []).length && !s.form_of && !s.alt_of);
    if (isLemma) {
      const p = deyo(w);
      if (p !== w) {
        let set = yoByPlain.get(p);
        if (!set) yoByPlain.set(p, (set = new Set()));
        set.add(w);
      }
    }
  } else {
    // «грязное», если есть хоть один смысл БЕЗ маркера «неёфицированная форма»
    // (самостоятельное значение мед=медвуз, небо=sky, или форма другого слова лет=лето)
    const hasOwn = senses.length === 0 || senses.some((s) => !NEYO.test((s.glosses || [])[0] || ""));
    if (hasOwn) dirty.add(w);
  }
}

const pairs = [];
for (const [p, set] of yoByPlain) {
  if (set.size !== 1) continue; // неоднозначная ё-цель (лесок/лёсок и т.п.)
  if (dirty.has(p)) continue;   // у е-написания есть собственный смысл — не подменяем
  pairs.push(`${p}\t${[...set][0]}`);
}
pairs.sort();
const gz = gzipSync(pairs.join("\n"), { level: 9 });
writeFileSync(OUT, gz);
console.log(`yo.txt.gz: ${pairs.length} пар, ${(gz.length / 1024).toFixed(0)} КБ`);
console.log("примеры:", pairs.slice(0, 14).map((p) => p.replace("\t", "→")).join(", "));
const dump = (w) => {
  const set = yoByPlain.get(w);
  console.log(`  ${w}: ${dirty.has(w) ? "заблокировано (свой смысл) ✓" : set ? (set.size > 1 ? "неоднозначно" : "→ " + [...set][0]) : "нет ё-леммы"}`);
};
["береза", "елка", "зеленый", "черный", "счет", "самолет", "полет", "мед", "небо", "лет", "все", "осел"].forEach(dump);
