// Сборка оффлайн-словаря рифм из трёх открытых источников:
//   1. all_accents.tsv  — Koziev/NLP_Datasets (CC0): 1,67 млн словоформ с ударением
//   2. openrussian-*.csv — OpenRussian.org (CC BY-SA 4.0): парадигмы с ударениями,
//      источник вариантов для омографов (за́мок/замо́к, доро́га/дорога́)
//   3. term2freq.dat    — Koziev/NLP_Datasets (CC0): частоты словоформ по частям речи
//
// Выход (папка dict/ рядом с manifest.json):
//   words.txt.gz  — "слово\ts,f,p[;s,f,p...]", сортировка по слову (бинарный поиск)
//   rhymes.txt.gz — "ключ\tслово,s,f,p[|слово,s,f,p...]", сортировка по ключу
//   meta.json     — счётчики и версия формата
// где s = индекс ударной гласной (base36), f = частотный бакет 0..9, p = часть речи (n/v/a/d/x)
//
// Запуск: node tools/build-dict.mjs [--src <папка с исходниками>] [--minf <порог частоты>]

import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rhymeKey, WORD_RE, VOWELS } from "../src/phonetics.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const SRC = argOf("--src", join(HERE, "sources"));
const OUT = join(HERE, "..", "dict");
const MINF = parseInt(argOf("--minf", "5"), 10); // порог частоты для слов, известных только Козиеву

if (!existsSync(SRC)) {
  console.error(`Нет папки исходников: ${SRC}\nСм. tools/sources/README.md — откуда скачать датасеты.`);
  process.exit(1);
}

// --- POS-классы term2freq -> компактные коды ---
function posCode(tag) {
  if (tag.startsWith("СУЩ")) return "n";
  if (tag.startsWith("ГЛАГОЛ") || tag.startsWith("ИНФИНИТИВ") || tag.startsWith("ДЕЕПРИЧ") || tag.startsWith("БЕЗЛИЧ")) return "v";
  if (tag.startsWith("ПРИЛАГ") || tag.startsWith("ПРИЧАСТ") || tag.startsWith("КРАТК")) return "a";
  if (tag.startsWith("НАРЕЧ")) return "d";
  return "x";
}
// какие POS-бакеты забирает вариант из данного файла OpenRussian
const OR_CLAIMS = {
  nouns: ["n"],
  verbs: ["v"],
  adjectives: ["a"],
  others: ["d", "x"],
};

const t0 = Date.now();
const log = (m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// --- 1) Koziev: базовое ударение ---
log("Читаю all_accents.tsv...");
const kz = new Map(); // word -> stressIdx
{
  const rl = createInterface({ input: createReadStream(join(SRC, "all_accents.tsv"), "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const word = line.slice(0, tab).trim().toLowerCase();
    if (!WORD_RE.test(word)) continue;
    const marked = line.slice(tab + 1).trim().toLowerCase();
    const caret = marked.indexOf("^");
    const s = caret >= 0 ? caret : word.indexOf("ё");
    if (s < 0 || !VOWELS.includes(word[s])) continue;
    kz.set(word, s);
  }
}
log(`  Koziev: ${kz.size} форм`);

// --- 2) OpenRussian: варианты ударений с указанием источника ---
log("Читаю OpenRussian CSV...");
const or = new Map(); // word -> Map(stressIdx -> Set(srcFile))
for (const f of ["nouns", "verbs", "adjectives", "others"]) {
  const text = readFileSync(join(SRC, `openrussian-${f}.csv`), "utf8");
  for (const line of text.split("\n").slice(1)) {
    for (const rawCell of line.split("\t")) {
      for (let piece of rawCell.split(",")) {
        piece = piece.trim().toLowerCase().replace(/[*/]/g, "");
        if (!piece || !piece.includes("'")) continue;
        const word = piece.replace(/'/g, "");
        if (!WORD_RE.test(word)) continue;
        const s = piece.indexOf("'") - 1;
        if (s < 0 || !VOWELS.includes(word[s])) continue;
        let m = or.get(word);
        if (!m) or.set(word, (m = new Map()));
        let set = m.get(s);
        if (!set) m.set(s, (set = new Set()));
        set.add(f);
      }
    }
  }
}
log(`  OpenRussian: ${or.size} форм`);

// --- 3) Частоты по частям речи ---
log("Читаю term2freq.dat...");
const fb = new Map(); // word -> {n,v,a,d,x}
{
  const rl = createInterface({ input: createReadStream(join(SRC, "term2freq.dat"), "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const p = line.split("\t");
    if (p.length < 3) continue;
    const w = p[0].toLowerCase();
    if (!WORD_RE.test(w)) continue;
    const f = parseInt(p[2], 10) || 0;
    if (!f) continue;
    const code = posCode(p[1]);
    let rec = fb.get(w);
    if (!rec) fb.set(w, (rec = { n: 0, v: 0, a: 0, d: 0, x: 0 }));
    rec[code] += f;
  }
}
log(`  частоты: ${fb.size} форм`);

// --- 3.5) Патчи: ручные исправления ударений (см. patches.tsv) ---
const patches = new Map(); // word -> stressIdx
{
  const pf = join(HERE, "patches.tsv");
  if (existsSync(pf)) {
    for (const line of readFileSync(pf, "utf8").split(/\r?\n/)) {
      const rec = line.trim().toLowerCase();
      if (!rec || rec.startsWith("#") || !rec.includes("'")) continue;
      const word = rec.replace(/'/g, "");
      const s = rec.indexOf("'") - 1;
      if (!WORD_RE.test(word) || s < 0 || !VOWELS.includes(word[s])) {
        console.error(`  ! патч пропущен (не гласная/не слово): ${line}`);
        continue;
      }
      patches.set(word, s);
    }
    log(`  патчей: ${patches.size}`);
  }
}

// --- 4) Слияние вариантов и раздача частот ---
log("Сливаю варианты...");
const allWords = new Set([...kz.keys(), ...or.keys(), ...patches.keys()]);
const bucket = (f) => (f <= 0 ? 0 : Math.min(9, 1 + Math.floor(Math.log10(f))));

let kept = 0, dropped = 0, homographs = 0;
const wordLines = [];
const byKey = new Map(); // key -> [[word, s, f, p], ...] (f — бакет)

for (const word of allWords) {
  const freqs = fb.get(word) || { n: 0, v: 0, a: 0, d: 0, x: 0 };
  const total = freqs.n + freqs.v + freqs.a + freqs.d + freqs.x;
  const orM = or.get(word);
  const kzS = kz.get(word);
  const patchS = patches.get(word);

  // слово известно только Козиеву и слишком редкое -> мусор (опечатки, экзотика)
  if (!orM && patchS === undefined && total < MINF) { dropped++; continue; }

  // варианты: stressIdx -> {claims: Set<posCode>, fromOr: bool}
  const variants = new Map();
  if (patchS !== undefined) {
    // патч авторитетен и полностью заменяет варианты слова
    variants.set(patchS, { claims: new Set(), fromOr: true });
  } else if (orM) {
    for (const [s, files] of orM) {
      const claims = new Set();
      for (const f of files) for (const c of OR_CLAIMS[f]) claims.add(c);
      variants.set(s, { claims, fromOr: true });
    }
  }
  if (patchS === undefined && kzS !== undefined && !variants.has(kzS)) {
    variants.set(kzS, { claims: new Set(), fromOr: false });
  }

  // сколько вариантов претендует на каждый POS-бакет (делим поровну)
  const claimCount = { n: 0, v: 0, a: 0, d: 0, x: 0 };
  for (const v of variants.values()) for (const c of v.claims) claimCount[c]++;

  const assigned = new Map(); // s -> freq
  let sumAssigned = 0;
  for (const [s, v] of variants) {
    let f = 0;
    for (const c of v.claims) f += freqs[c] / claimCount[c];
    assigned.set(s, f);
    sumAssigned += f;
  }
  if (patchS !== undefined) {
    // патч: единственный вариант получает всю частоту слова (минимум бакет 1)
    assigned.set(patchS, Math.max(total, 1));
  }
  // нераспределённый остаток: Koziev-варианту без OR-подтверждения,
  // а если такого нет — варианту-лидеру
  let rest = patchS !== undefined ? 0 : Math.max(0, total - sumAssigned);
  if (rest > 0) {
    const kzOnly = [...variants.entries()].filter(([, v]) => !v.fromOr);
    if (!orM) {
      // слово только из Козиева — весь вес ему
      for (const [s] of kzOnly) assigned.set(s, total);
    } else if (kzOnly.length > 0 && sumAssigned > 0) {
      // конфликт источников: Козиеву — остаток, урезанный вчетверо (недоверие)
      for (const [s] of kzOnly) assigned.set(s, (assigned.get(s) || 0) + rest / 4);
    } else {
      // остаток лидеру по уже назначенному
      let best = null, bestF = -1;
      for (const [s, f] of assigned) if (f > bestF) { best = s; bestF = f; }
      if (best !== null) assigned.set(best, assigned.get(best) + rest);
    }
  }

  // часть речи варианта: самый жирный из его бакетов, иначе argmax слова
  const wordPos = Object.entries(freqs).sort((a, b) => b[1] - a[1])[0][0];
  const parts = [];
  const sorted = [...variants.entries()].sort((a, b) => (assigned.get(b[0]) || 0) - (assigned.get(a[0]) || 0));
  for (const [s, v] of sorted) {
    let p = wordPos, pf = -1;
    for (const c of v.claims) if (freqs[c] > pf) { pf = freqs[c]; p = c; }
    const f = bucket(assigned.get(s) || 0);
    parts.push(`${s.toString(36)},${f},${p}`);
    const { key } = rhymeKey(word, s);
    let arr = byKey.get(key);
    if (!arr) byKey.set(key, (arr = []));
    arr.push([word, s, f, p]);
  }
  if (parts.length > 1) homographs++;
  wordLines.push(`${word}\t${parts.join(";")}`);
  kept++;
}
log(`  слов: ${kept} (омографов: ${homographs}), отброшено: ${dropped}, рифм-ключей: ${byKey.size}`);

// --- 5) Запись ---
log("Пишу dict/...");
mkdirSync(OUT, { recursive: true });

wordLines.sort();
const wordsRaw = wordLines.join("\n");
const wordsGz = gzipSync(wordsRaw, { level: 9 });
writeFileSync(join(OUT, "words.txt.gz"), wordsGz);

const keyLines = [];
for (const [key, arr] of byKey) {
  arr.sort((a, b) => b[2] - a[2] || (a[0] < b[0] ? -1 : 1));
  keyLines.push(`${key}\t${arr.map(([w, s, f, p]) => `${w},${s.toString(36)},${f},${p}`).join("|")}`);
}
keyLines.sort();
const rhymesRaw = keyLines.join("\n");
const rhymesGz = gzipSync(rhymesRaw, { level: 9 });
writeFileSync(join(OUT, "rhymes.txt.gz"), rhymesGz);

const meta = {
  format: 1,
  built: new Date().toISOString().slice(0, 10),
  words: kept,
  homographs,
  keys: byKey.size,
  minFreq: MINF,
  sources: [
    "Koziev/NLP_Datasets (all_accents, term2freq) — CC0",
    "OpenRussian.org via Badestrand/russian-dictionary — CC BY-SA 4.0",
  ],
};
writeFileSync(join(OUT, "meta.json"), JSON.stringify(meta, null, 2));

const mb = (n) => (n / 1024 / 1024).toFixed(2) + " MB";
log(`ГОТОВО: words ${mb(wordsRaw.length)} -> ${mb(wordsGz.length)}, rhymes ${mb(rhymesRaw.length)} -> ${mb(rhymesGz.length)}`);
