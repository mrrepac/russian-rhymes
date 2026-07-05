// Обогащение словаря из дампа Викисловаря (kaikki): добавляет слова, которых нет
// в базе Козиева/OpenRussian — неологизмы (хайп, краш, вайб…) и правильные ё-слова
// (мёд, берёза, полёт — в вики ё уже стоит). База НЕ переписывается (безопасно:
// не трогаем небо/все/лет, где е-написание — самостоятельное слово). rhymes.txt
// пересобирается целиком из объединённого списка.
//
// Запуск: node --max-old-space-size=4096 tools/build-enrich.mjs
import { createReadStream, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { createGunzip, gunzipSync, gzipSync } from "node:zlib";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rhymeKey, VOWELS, WORD_RE } from "../src/phonetics.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT = join(HERE, "..", "dict");
const KAIKKI = join(HERE, "sources", "kaikki-ru.jsonl.gz");
const log = (...a) => console.log(...a);

const deyo = (s) => s.replace(/ё/g, "е");
// intj/interj/onomatopeia → «i» (междометия — так их назвал Лев, звукоподражания туда же)
const POS = { noun: "n", verb: "v", adj: "a", adv: "d", intj: "i", interj: "i", onomatopeia: "i" };
const NEO_F = 1; // видимый лексический слой «обычная» (не «редкая», которая выкл по умолчанию)
const BASE_F = 5; // базовая лексика (lexCat: f>=5) — сюда неологизмы и междометия (просьба Льва)
// модные пометы русского Викисловаря (в senses[].categories) → базовая лексика
const MODERN = /Неологизм|Сленг|Жаргон|Интернет|Молодёж/;
const isModernEntry = (o) => (o.senses || []).some((s) => (s.categories || []).some((c) => MODERN.test(c.name || c)));

// ручной патч пропущенных Викисловарём помет (tools/neologisms.tsv): слово -> категория,
// проходит через ту же проверку MODERN — как будто помета была в вики
const catPatch = new Map();
{
  const pf = join(HERE, "neologisms.tsv");
  if (existsSync(pf)) {
    for (const line of readFileSync(pf, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const [w, cat] = t.split("\t");
      if (w && cat && MODERN.test(cat)) catPatch.set(w.trim().toLowerCase(), cat.trim());
    }
  }
}
const isModern = (w, o) => isModernEntry(o) || catPatch.has(w);

// --- 1) существующая база ---
log("Читаю dict/words.txt.gz...");
const base = new Map(); // word -> {variants:[{s,f,p}], maxF}
const baseWords = gunzipSync(readFileSync(join(DICT, "words.txt.gz"))).toString("utf8");
for (const line of baseWords.split("\n")) {
  const tab = line.indexOf("\t");
  if (tab < 0) continue;
  const w = line.slice(0, tab);
  const variants = line.slice(tab + 1).split(";").map((v) => {
    const [s36, f, p] = v.split(",");
    return { s: parseInt(s36, 36), f: +f, p };
  });
  let maxF = 0;
  for (const v of variants) if (v.f > maxF) maxF = v.f;
  base.set(w, { variants, maxF });
}
log(`  база: ${base.size} слов`);

// --- 2) вытащить ударение из статьи kaikki ---
const IPA_V = new Set([..."aɛeiɨouəɐɪʊɵæɔ"]); // слоговые гласные IPA
function stressFromForms(word, forms) {
  let best = null;
  for (const f of forms || []) {
    const fm = f.form || "";
    if (!fm.includes("́")) continue;
    let plain = "", si = -1;
    for (const ch of fm) {
      if (ch === "́") si = plain.length - 1;
      else plain += ch;
    }
    if (plain !== word) continue;
    const tags = f.tags || [];
    const sc = (tags.includes("nominative") ? 2 : 0) + (tags.includes("singular") ? 1 : 0);
    if (!best || sc > best.sc) best = { si, sc };
  }
  return best && best.si >= 0 && VOWELS.includes(word[best.si]) ? best.si : -1;
}
function stressFromIpa(word, sounds) {
  const ipa = (sounds || []).map((s) => s.ipa).find(Boolean);
  if (!ipa) return -1;
  const s = ipa.replace(/[[\]/]/g, "");
  const mark = s.indexOf("ˈ"); // ˈ основное ударение
  if (mark < 0) return -1;
  let syl = 0;
  const before = [...s.slice(0, mark)];
  for (let i = 0; i < before.length; i++) {
    if (IPA_V.has(before[i]) && before[i + 1] !== "̯") syl++; // ◌̯ = неслоговой
  }
  let vi = -1;
  for (let i = 0; i < word.length; i++) {
    if (VOWELS.includes(word[i])) {
      vi++;
      if (vi === syl) return i;
    }
  }
  return -1;
}
function stressOf(word, o, pos) {
  const nv = [...word].filter((c) => VOWELS.includes(c)).length;
  if (nv === 0) return -1;
  // ё всегда ударная — и её знак не помечают комбинирующим акцентом (в формах его нет),
  // поэтому многосложные ё-слова (берёза, полёт) иначе теряются
  const yo = word.indexOf("ё");
  if (yo >= 0) return yo;
  if (nv === 1) { for (let i = 0; i < word.length; i++) if (VOWELS.includes(word[i])) return i; }
  const fromForms = stressFromForms(word, o.forms);
  if (fromForms >= 0) return fromForms;
  // IPA-фолбэк только для несклоняемых (наречия, междометия) — таблиц форм нет;
  // у сущ/глаг/прил требуем ударение из форм: надёжнее и без хвоста бесформенной экзотики
  return pos === "d" || pos === "i" ? stressFromIpa(word, o.sounds) : -1;
}
// причастие/словоформа/альт — не лемма, пропускаем
function isFormOrPart(o) {
  for (const s of o.senses || []) {
    if (s.form_of || s.alt_of) return true;
    const tg = (s.tags || []).join(" ");
    if (/participle|participial|gerund|form-of/.test(tg)) return true;
  }
  const ht = (o.head_templates || []).map((h) => h.name || "").join(" ");
  return /participle|part-|прич/.test(ht);
}

// --- 3) стрим kaikki: собираем новые слова ---
log("Читаю Викисловарь (kaikki)...");
const harvested = new Map(); // word -> {s,p}
let scanned = 0, noStress = 0;
const rl = createInterface({ input: createReadStream(KAIKKI).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line) continue;
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  const w = (o.word || "").toLowerCase();
  const p = POS[o.pos];
  if (!p || !WORD_RE.test(w) || w.length < 2) continue;
  if (base.has(w) || harvested.has(w)) continue;
  if (isFormOrPart(o)) continue;
  scanned++;
  const s = stressOf(w, o, p);
  if (s < 0) { noStress++; continue; }
  let f;
  if (p === "i") f = BASE_F;                    // междометия — базовая
  else if (isModern(w, o)) f = BASE_F;          // неологизмы/сленг/жаргон/интернет/молодёжное (+патч) — базовая
  else if (w.includes("ё") && base.has(deyo(w))) f = Math.max(NEO_F, base.get(deyo(w)).maxF); // ё-слово ~ как е-двойник
  else f = NEO_F;                               // прочее — видимая «обычная»
  harvested.set(w, { s, p, f });
}
log(`  новых слов: ${harvested.size} (без вытащенного ударения отброшено: ${noStress})`);

// --- 4) объединяем и пишем words.txt ---
log("Собираю words.txt...");
const wordLines = [];
for (const [w, { variants }] of base) {
  wordLines.push(`${w}\t${variants.map((v) => `${v.s.toString(36)},${v.f},${v.p}`).join(";")}`);
}
let baseF = 0, intjN = 0;
for (const [w, { s, p, f }] of harvested) {
  if (f >= BASE_F) baseF++;
  if (p === "i") intjN++;
  wordLines.push(`${w}\t${s.toString(36)},${f},${p}`);
}
log(`  в базовой лексике (неологизмы + междометия): ${baseF}; из них междометий: ${intjN}`);
wordLines.sort();

// --- 5) пересобираем rhymes.txt из объединённого списка ---
log("Пересобираю rhymes.txt...");
const byKey = new Map();
const pushRhyme = (word, s, f, p) => {
  const { key } = rhymeKey(word, s);
  let arr = byKey.get(key);
  if (!arr) byKey.set(key, (arr = []));
  arr.push([word, s, f, p]);
};
for (const [w, { variants }] of base) for (const v of variants) pushRhyme(w, v.s, v.f, v.p);
for (const [w, { s, p, f }] of harvested) pushRhyme(w, s, f, p);
const keyLines = [];
for (const [key, arr] of byKey) {
  arr.sort((a, b) => b[2] - a[2] || (a[0] < b[0] ? -1 : 1));
  keyLines.push(`${key}\t${arr.map(([w, s, f, p]) => `${w},${s.toString(36)},${f},${p}`).join("|")}`);
}
keyLines.sort();
log(`  рифм-ключей: ${byKey.size}`);

// --- 6) запись (с бэкапом) ---
for (const f of ["words.txt.gz", "rhymes.txt.gz"]) {
  const p = join(DICT, f);
  if (existsSync(p) && !existsSync(p + ".bak")) copyFileSync(p, p + ".bak");
}
const wordsGz = gzipSync(wordLines.join("\n"), { level: 9 });
const rhymesGz = gzipSync(keyLines.join("\n"), { level: 9 });
writeFileSync(join(DICT, "words.txt.gz"), wordsGz);
writeFileSync(join(DICT, "rhymes.txt.gz"), rhymesGz);
const mb = (n) => (n / 1024 / 1024).toFixed(2) + " МБ";
log(`ГОТОВО: слов ${base.size}+${harvested.size}=${wordLines.length}; words.txt.gz ${mb(wordsGz.length)}, rhymes.txt.gz ${mb(rhymesGz.length)}`);
