// Карта словоформа -> лемма (Koziev/NLP_Datasets word2lemma, CC0; база — Зализняк).
// Нужна, чтобы у формы («разуму») показывать толкование и синонимы леммы («разум»).
// Режем размер: берём только формы из нашего словаря рифм (dict/words.txt.gz)
// и только леммы, у которых есть толкование или синонимы.
// Выход: dict/lemmas.txt.gz — "форма\tлемма[,лемма2,лемма3]" (омонимия форм).
// Запуск: node tools/build-lemmas.mjs [--src <word2lemma.dat>]

import { createReadStream, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const i = args.indexOf("--src");
const SRC = i >= 0 ? args[i + 1] : join(HERE, "sources", "word2lemma.dat");
const OUT = join(HERE, "..", "dict");
const WORD_RE = /^[а-яё]+(-[а-яё]+)*$/;

const readGzWords = (name) => {
  const text = gunzipSync(readFileSync(join(OUT, name))).toString("utf8");
  const set = new Set();
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) set.add(line.slice(0, tab));
  }
  return set;
};

const readOpt = (name) => (existsSync(join(OUT, name)) ? readGzWords(name) : new Set());
const ourForms = readGzWords("words.txt.gz");
const defWords = readGzWords("definitions.txt.gz");
const synWords = readGzWords("synonyms.txt.gz");
const antWords = readOpt("antonyms.txt.gz");
const assocWords = readOpt("associations.txt.gz");
console.error(
  `форм в словаре: ${ourForms.size}, лемм: толкования ${defWords.size}, синонимы ${synWords.size}, антонимы ${antWords.size}, ассоциации ${assocWords.size}`
);

const map = new Map(); // форма -> Set(лемм)
let rows = 0;
const rl = createInterface({ input: createReadStream(SRC, "utf8"), crlfDelay: Infinity });
for await (const line of rl) {
  rows++;
  const p = line.split("\t");
  if (p.length < 2) continue;
  const form = p[0].toLowerCase().trim();
  const lemma = p[1].toLowerCase().trim();
  if (form === lemma) continue;
  if (!WORD_RE.test(form) || !WORD_RE.test(lemma)) continue;
  if (!ourForms.has(form)) continue;
  if (!defWords.has(lemma) && !synWords.has(lemma) && !antWords.has(lemma) && !assocWords.has(lemma)) continue;
  let set = map.get(form);
  if (!set) map.set(form, (set = new Set()));
  if (set.size < 3) set.add(lemma);
}
console.error(`строк источника: ${rows}, форм с леммой: ${map.size}`);

const out = [];
for (const [form, lemmas] of map) out.push(`${form}\t${[...lemmas].join(",")}`);
out.sort();

mkdirSync(OUT, { recursive: true });
const raw = out.join("\n");
const gz = gzipSync(raw, { level: 9 });
writeFileSync(join(OUT, "lemmas.txt.gz"), gz);
console.error(`lemmas: ${(raw.length / 1048576).toFixed(1)} MB -> ${(gz.length / 1048576).toFixed(1)} MB`);
