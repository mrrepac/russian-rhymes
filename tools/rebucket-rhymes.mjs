// Пересобрать dict/rhymes.txt.gz из уже готового dict/words.txt.gz по ТЕКУЩЕМУ
// rhymeKey (src/phonetics.js). Нужно после правки фонетики ключа, когда сам набор
// слов и их ударения не меняются, — быстрее полного build-enrich (без потока kaikki).
// words.txt.gz НЕ трогаем. Делает .rebak-бэкап и печатает контрольные группы.
//
// Запуск: node tools/rebucket-rhymes.mjs
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rhymeKey } from "../src/phonetics.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT = join(HERE, "..", "dict");

const wordsRaw = gunzipSync(readFileSync(join(DICT, "words.txt.gz"))).toString("utf8");
const byKey = new Map();
let words = 0, variants = 0;
for (const line of wordsRaw.split("\n")) {
  const tab = line.indexOf("\t");
  if (tab < 0) continue;
  const w = line.slice(0, tab);
  words++;
  for (const v of line.slice(tab + 1).split(";")) {
    const [s36, f, p] = v.split(",");
    const s = parseInt(s36, 36);
    const bf = +f;
    const { key } = rhymeKey(w, s);
    let arr = byKey.get(key);
    if (!arr) byKey.set(key, (arr = []));
    arr.push([w, s, bf, p]);
    variants++;
  }
}

const keyLines = [];
for (const [key, arr] of byKey) {
  arr.sort((a, b) => b[2] - a[2] || (a[0] < b[0] ? -1 : 1));
  keyLines.push(`${key}\t${arr.map(([w, s, f, p]) => `${w},${s.toString(36)},${f},${p}`).join("|")}`);
}
keyLines.sort();

// бэкап перед записью (однократный .rebak, чтобы не затирать .bak от build-enrich)
const out = join(DICT, "rhymes.txt.gz");
if (existsSync(out) && !existsSync(out + ".rebak")) copyFileSync(out, out + ".rebak");
const gz = gzipSync(keyLines.join("\n"), { level: 9 });
writeFileSync(out, gz);

const mb = (n) => (n / 1048576).toFixed(2) + " МБ";
console.log(`слов: ${words}, вариантов: ${variants}, рифм-ключей: ${byKey.size}`);
console.log(`rhymes.txt.gz: ${mb(gz.length)}`);

// контрольные группы (должны отражать правки #1 наречий и #2 оглушения ь)
const show = (key) => {
  const arr = (byKey.get(key) || []).slice(0, 14).map((e) => e[0]);
  console.log(`  [${key}] ${arr.join(", ")}${byKey.get(key) && byKey.get(key).length > 14 ? " …" : ""}`);
};
console.log("Контроль #2 (оглушение перед ь): рожь/нож должны быть в одном ключе 'ош':");
show("ош");
console.log("Контроль #1 (наречия -ого держат [г]): 'ога' — наречия; 'ова' — слово/клёво:");
show("ога");
show("ова");
