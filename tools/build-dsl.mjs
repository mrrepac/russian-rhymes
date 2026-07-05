// Сборка личных словарей из DSL (Lingvo/GoldenDict) в формат плагина.
// Порт src/dsl.ts на Node: то же, что делает рантайм-импорт в настройках,
// только собирает НЕСКОЛЬКО DSL за один проход и подписывает каждую группу
// толкований именем источника (Ожегов / Ефремова / …).
//
// Вход:  .dsl или .dsl.dz (gzip определяется по сигнатуре, не по расширению),
//        кодировки UTF-16LE / UTF-8 / windows-1251.
// Выход: dict/local-definitions.txt.gz  — строки "слово\tИсточник:знач1;знач2|Источник2:…"
//        dict/local-synonyms.txt.gz     — строки "слово\tсин1,син2|син3,син4"
// Запуск: node tools/build-dsl.mjs [--src <папка с DSL>]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "dict");
const argv = process.argv.slice(2);
const si = argv.indexOf("--src");
const SRC_DIR = si >= 0 ? argv[si + 1] : "C:/Users/re-pa/Desktop/словари";

// Что во что вливаем. label — короткая подпись группы (только для толкований).
// Порядок в definitions задаёт порядок групп во вкладке «Значение».
const CONFIG = [
  { file: "Ru-Ru-OzhegovShvedova.dsl.dz", type: "definitions", label: "Ожегов" },
  { file: "ExplanatoryRuRu.dsl.dz", type: "definitions", label: "Ефремова" },
  { file: "PopularRuRu.dsl.dz", type: "definitions", label: "Популярный" },
  { file: "Rus-Rus_BigDictOfForeignWords_bm.dsl.dz", type: "definitions", label: "Иностр." },
  { file: "Ru-Ru-Vasmer.dsl.dz", type: "definitions", label: "Фасмер" },
  { file: "LingvoThesaurusRuRu.dsl.dz", type: "synonyms", label: "" },
];

const WORD_RE = /^[а-яё]+(-[а-яё]+)*$/;
const SYN_RE = /^[а-яё]+([ -][а-яё]+){0,2}$/;
const MAX_GLOSSES = 10; // сколько значений (строк-смыслов) брать с одного словаря; длину НЕ режем
const MAX_GROUPS = 6; // сколько словарей-источников на слово

const t0 = Date.now();
const log = (m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

function cleanHeadword(s) {
  return s
    .replace(/\{([^}]*)\}/g, "$1") // {опц/ударение} — оставить содержимое
    .replace(/\[\/?[^\]]*\]/g, "") // DSL-теги целиком, включая ударение ['] [/']
    .replace(/\\(.)/g, "$1") // снять экранирование
    .replace(/['’´]/g, "")
    .trim()
    .toLowerCase();
}

function cleanBody(s) {
  return s
    .replace(/\{\{[^}]*\}\}/g, "") // {{служебное}}
    .replace(/\{([^}]*)\}/g, "$1") // {ударение/опц} — оставить букву
    .replace(/\[\/?[^\]]*\]/g, "") // все DSL-теги [m1] [i] [c] [ref] ['] …
    .replace(/[[\]]/g, "") // остаточные скобки от вложенных тегов ([тэ] и т.п.)
    .replace(/\\(.)/g, "$1")
    .replace(/~/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decode(bytes) {
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Buffer.toString не бросает на битых байтах (в отличие от Node TextDecoder) и тянет большие файлы
  let enc = "utf8";
  if (buf[0] === 0xff && buf[1] === 0xfe) enc = "utf16le";
  else if (!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)) {
    const lim = Math.min(buf.length, 4000);
    let marks = 0;
    for (let i = 1; i < lim; i += 2) if (buf[i] === 0x04 || buf[i] === 0x00) marks++;
    if (marks > lim / 5) enc = "utf16le";
  }
  return buf.toString(enc);
}

/** DSL -> Map<слово, string[] групп>. Для definitions группа = "label:g1;g2". */
function convert(text, type, label) {
  const nameMatch = text.match(/#NAME\s+"([^"]*)"/);
  const dictName = nameMatch ? nameMatch[1] : "DSL";
  const entries = new Map();
  let heads = [];
  let body = [];

  const flush = () => {
    if (heads.length && body.length) {
      for (const head of heads) {
        if (!WORD_RE.test(head)) continue;
        if (type === "definitions") {
          const glosses = [];
          for (let g of body) {
            g = g.replace(/[\t|]/g, " ").replace(/;/g, ","); // длину не режем — только структурные разделители
            if (g && !glosses.includes(g)) glosses.push(g);
            if (glosses.length >= MAX_GLOSSES) break;
          }
          if (glosses.length) {
            let arr = entries.get(head);
            if (!arr) entries.set(head, (arr = []));
            if (arr.length < MAX_GROUPS) arr.push(`${label}:${glosses.join(";")}`);
          }
        } else {
          for (const line of body) {
            const words = line
              .split(/[,;]/)
              .map((w) => w.trim().toLowerCase().replace(/\.$/, ""))
              .filter((w) => w && w !== head && SYN_RE.test(w));
            if (!words.length) continue;
            let arr = entries.get(head);
            if (!arr) entries.set(head, (arr = []));
            const sig = words.join(",");
            if (arr.length < MAX_GROUPS && !arr.includes(sig)) arr.push(sig);
          }
        }
      }
    }
    heads = [];
    body = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    if (rawLine.startsWith("#")) continue;
    if (/^[\s\t]/.test(rawLine)) {
      const b = cleanBody(rawLine);
      if (b && b.length >= 3) body.push(b);
    } else {
      if (body.length) flush();
      const hw = cleanHeadword(rawLine);
      if (hw) heads.push(hw);
    }
  }
  flush();
  return { dictName, entries };
}

/** Влить группы источника в общую карту слово->группы, с дедупом и лимитом. */
function mergeInto(target, entries) {
  for (const [word, groups] of entries) {
    let cur = target.get(word);
    if (!cur) target.set(word, (cur = []));
    for (const g of groups) if (cur.length < MAX_GROUPS && !cur.includes(g)) cur.push(g);
  }
}

function writeGz(name, map) {
  const lines = [];
  for (const [w, g] of map) lines.push(`${w}\t${g.join("|")}`);
  lines.sort();
  const raw = lines.join("\n");
  const gz = gzipSync(raw, { level: 9 });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), gz);
  log(`${name}: слов ${map.size}; ${(raw.length / 1048576).toFixed(1)} MB -> ${(gz.length / 1048576).toFixed(1)} MB`);
}

const defs = new Map();
const syns = new Map();

for (const { file, type, label } of CONFIG) {
  const path = join(SRC_DIR, file);
  if (!existsSync(path)) {
    log(`ПРОПУСК (нет файла): ${file}`);
    continue;
  }
  const { dictName, entries } = convert(decode(readFileSync(path)), type, label);
  log(`${file} → «${dictName}» [${type}${label ? " · " + label : ""}]: ${entries.size} слов`);
  mergeInto(type === "definitions" ? defs : syns, entries);
}

if (defs.size) writeGz("local-definitions.txt.gz", defs);
if (syns.size) writeGz("local-synonyms.txt.gz", syns);
log("Готово. Перезапусти Obsidian или переоткрой панель, чтобы подхватить.");
