// Контрольный прогон собранного словаря: читает dict/*.gz как плагин
// (распаковка + поиск), печатает варианты ударений и топ рифм.
// Запуск: node tools/test-dict.mjs слово [слово...]

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rhymeKey, countSyllables, markStress, looksSameRoot, vowelSkeleton, consonantSkeleton } from "../src/phonetics.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT = join(HERE, "..", "dict");

const words = gunzipSync(readFileSync(join(DICT, "words.txt.gz"))).toString("utf8").split("\n");
const rhymes = gunzipSync(readFileSync(join(DICT, "rhymes.txt.gz"))).toString("utf8").split("\n");

// бинарный поиск строки по префиксу "слово\t" в отсортированном массиве строк
function findLine(lines, prefix) {
  let lo = 0, hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const line = lines[mid];
    if (line.startsWith(prefix)) return line;
    if (line < prefix) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

const POS_RU = { n: "сущ", v: "гл", a: "прил", d: "нареч", x: "проч" };

for (const q0 of process.argv.slice(2)) {
  const q = q0.toLowerCase();
  console.log(`\n=== ${q} ===`);
  const line = findLine(words, q + "\t");
  if (!line) { console.log("  (нет в словаре)"); continue; }
  const variants = line.slice(q.length + 1).split(";").map((v) => {
    const [s36, f, p] = v.split(",");
    return { s: parseInt(s36, 36), f: +f, p };
  });
  for (const v of variants) {
    const { key, support } = rhymeKey(q, v.s);
    const rline = findLine(rhymes, key + "\t");
    const group = rline
      ? rline.slice(key.length + 1).split("|").map((e) => {
          const [w, s36, f, p] = e.split(",");
          return { w, s: parseInt(s36, 36), f: +f, p };
        })
      : [];
    const qSyl = countSyllables(q);
    const list = group
      .filter((e) => e.w !== q && !looksSameRoot(e.w, q))
      .map((e) => {
        const sup = rhymeKey(e.w, e.s).support;
        return { ...e, exact: sup === support ? 1 : 0 };
      })
      .sort((a, b) => b.exact - a.exact || b.f - a.f || Math.abs(countSyllables(a.w) - qSyl) - Math.abs(countSyllables(b.w) - qSyl));
    console.log(`  ${markStress(q, v.s)} (${POS_RU[v.p]}, част.${v.f})  [ключ ${key} | опора ${support || "—"} | рифм ${list.length}]`);
    console.log("  " + list.slice(0, 25).map((e) => markStress(e.w, e.s) + (e.f === 0 ? "°" : "")).join(", "));

    // созвучия и ассонансы: другие ключи с тем же гласным скелетом
    const skel = vowelSkeleton(key);
    const qCons = consonantSkeleton(key);
    const cons = [];
    const asson = [];
    for (const rl of rhymes) {
      const tab = rl.indexOf("\t");
      if (tab < 0) continue;
      const k = rl.slice(0, tab);
      if (k === key || vowelSkeleton(k) !== skel) continue;
      const target = consonantSkeleton(k) === qCons ? cons : asson;
      for (const e of rl.slice(tab + 1).split("|")) {
        const [w, s36, f, p] = e.split(",");
        if (w === q || w.length < 3 || p === "x" || looksSameRoot(w, q)) continue;
        target.push({ w, s: parseInt(s36, 36), f: +f });
      }
    }
    cons.sort((a, b) => b.f - a.f);
    asson.sort((a, b) => b.f - a.f);
    console.log("  созвучия:  " + cons.slice(0, 20).map((e) => markStress(e.w, e.s)).join(", "));
    console.log("  ассонансы: " + asson.slice(0, 20).map((e) => markStress(e.w, e.s)).join(", "));
  }
}
