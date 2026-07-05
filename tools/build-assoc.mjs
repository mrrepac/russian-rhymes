// Ассоциации КартаСлов (CC BY-NC-SA 4.0, github.com/dkulagin/kartaslov).
// Вход: assoc.safe.csv — "word;assoc;pos_tag;dir;weight;mirror_weight;is_safe".
// Берём прямые ассоциации (dir=DIR, weight>0), топ по весу.
// Выход: dict/associations.txt.gz — "слово\tасс1,асс2,..." (по убыванию веса)
// Запуск: node tools/build-assoc.mjs [--src <assoc.safe.csv>]

import { createReadStream, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const i = args.indexOf("--src");
const SRC = i >= 0 ? args[i + 1] : join(HERE, "sources", "assoc.safe.csv");
const OUT = join(HERE, "..", "dict");

const WORD_RE = /^[а-яё]+([ -][а-яё]+){0,2}$/;
const MAX_ASSOC = 15;

const map = new Map(); // слово -> [{w, weight}]
let rows = 0;
const rl = createInterface({ input: createReadStream(SRC, "utf8"), crlfDelay: Infinity });
for await (const line of rl) {
  rows++;
  if (rows === 1) continue; // шапка
  const p = line.split(";");
  if (p.length < 7) continue;
  const word = p[0].toLowerCase().trim();
  const assoc = p[1].toLowerCase().trim();
  const dir = p[3];
  const weight = parseFloat(p[4]) || 0;
  if (dir !== "DIR" || weight <= 0) continue;
  if (!WORD_RE.test(word) || !WORD_RE.test(assoc) || assoc === word) continue;
  let arr = map.get(word);
  if (!arr) map.set(word, (arr = []));
  arr.push({ w: assoc, weight });
}

const out = [];
for (const [word, arr] of map) {
  arr.sort((a, b) => b.weight - a.weight);
  const seen = new Set();
  const top = [];
  for (const { w } of arr) {
    if (seen.has(w)) continue;
    seen.add(w);
    top.push(w);
    if (top.length >= MAX_ASSOC) break;
  }
  out.push(`${word}\t${top.join(",")}`);
}
out.sort();

mkdirSync(OUT, { recursive: true });
const raw = out.join("\n");
const gz = gzipSync(raw, { level: 9 });
writeFileSync(join(OUT, "associations.txt.gz"), gz);
console.error(`строк: ${rows}, слов с ассоциациями: ${out.length}, ${(raw.length / 1048576).toFixed(1)} MB -> ${(gz.length / 1048576).toFixed(1)} MB`);
