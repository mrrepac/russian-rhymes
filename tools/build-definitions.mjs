// Толковый словарь из русского Викисловаря (kaikki.org / wiktextract, CC BY-SA).
// Вход: kaikki.org-dictionary-Русский.jsonl.gz (одна JSON-строка на статью).
// Выход:
//   dict/definitions.txt.gz — БОГАТЫЙ формат (значения + ВСЕ примеры + ПОЛНАЯ этимология).
//   dict/forms.txt.gz       — парадигма словоформ с ударениями (склонение/спряжение).
//
// definitions — одна строка на слово (отсортированы, tab после слова — для бинарного поиска):
//   строка-значения:  "слово\t<ЗАПИСЬ>"
//   строка-редирект:  "слово\t>лемма"   (статья-словоформа: показываем толкование леммы)
// ЗАПИСЬ (управляющие разделители, в естественном тексте не встречаются):
//   <этимология> ␝ <группа> ␝ <группа> ...            (␝ = \x1d, GS)
//   группа   = <часть речи> ␟ <значение> ␟ <значение> (␟ = \x1f, US)
//   значение = <толкование> ␞ <пример> ␞ <пример>      (␞ = \x1e, RS; примеры опциональны)
//   пример   = <текст> ␜ <источник>                    (␜ = \x1c, FS; источник опционален)
//
// forms — одна строка на лемму: "слово\tметка:форма|метка:форма" (только однословные формы).
//
// Личные DSL-словари (dict/local-*.txt.gz) — ДРУГОЙ простой формат "POS:g1;g2|…" (build-dsl.mjs).
//
// Запуск: node tools/build-definitions.mjs [--src <файл .jsonl.gz>]

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

// разделители формата (совпадают с парсером в src/dict.ts)
const GS = "\x1d", US = "\x1f", RS = "\x1e", FS = "\x1c";

const MAX_GROUPS = 12; // групп (омонимы/части речи) на слово
const PROPER_CAP = 2; // значений у имени собственного (списки сёл — шум)
const MAX_FORMS = 40; // строк парадигмы на слово
const WORD_RE = /^[а-яё]+(-[а-яё]+)*$/;

const POS_RU = {
  noun: "сущ.",
  verb: "гл.",
  adj: "прил.",
  adv: "нареч.",
  pron: "мест.",
  num: "числ.",
  prep: "предл.",
  conj: "союз",
  particle: "част.",
  intj: "межд.",
  phrase: "фраза",
  character: "",
  name: "имя",
};

// теги форм → короткие русские метки; порядок ORDER задаёт, как метки склеиваются
const FORM_ABBR = {
  past: "прош.", present: "наст.", future: "буд.",
  imperative: "повел.", participle: "прич.", adverbial: "дееприч.",
  active: "действ.", passive: "страд.", "short-form": "кратк.", comparative: "сравн.",
  "first-person": "1л.", "second-person": "2л.", "third-person": "3л.",
  nominative: "И.", genitive: "Р.", dative: "Д.", accusative: "В.",
  instrumental: "Т.", prepositional: "П.", locative: "М.", vocative: "Зв.",
  masculine: "м.", feminine: "ж.", neuter: "с.",
  singular: "ед.", plural: "мн.",
};
const FORM_ORDER = [
  "past", "present", "future", "imperative", "participle", "adverbial", "active", "passive",
  "comparative", "short-form", "first-person", "second-person", "third-person",
  "nominative", "genitive", "dative", "accusative", "instrumental", "prepositional", "locative", "vocative",
  "masculine", "feminine", "neuter", "singular", "plural",
];

// схлопнуть пробелы, убрать хвостовые вики-ссылки [1], управляющие символы формата
// и артефакты вырезанных тегов (задвоенные запятые «перен., , неисч.»)
function clean(s) {
  return (s || "")
    .replace(/[\x1c-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\[\d+\]\s*$/g, "")
    .replace(/(?:,\s*){2,}/g, ", ")
    .replace(/^[\s,;]+/, "")
    .trim();
}

// Этимология Викисловаря: «Происходит от ??» / «От ??» — заглушки (нет данных, ~86%); выкидываем.
function normalizeEtym(et) {
  if (!et || /\?\?/.test(et)) return "";
  const body = et.replace(/^происходит\s+от\s*/i, "").replace(/^от\s*/i, "").trim();
  if (body.length < 3 || /^[?.\s]+$/.test(body)) return "";
  return et; // полная длина — Лев просил не подрезать
}

// метка формы из её тегов; "" если нет ни одного значимого тега
function formLabel(tags) {
  const set = new Set(tags || []);
  const parts = [];
  for (const t of FORM_ORDER) if (set.has(t) && FORM_ABBR[t]) parts.push(FORM_ABBR[t]);
  return parts.join(" ");
}

const t0 = Date.now();
const log = (m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

const defs = new Map(); // word -> { etym, groups:[{pos, proper, senses:[{gloss, ex:[{text,ref}]}]}] }
const forms = new Map(); // word -> [{label, form}]
const redirects = new Map(); // word -> lemma
let lines = 0, exTotal = 0, etymCount = 0;

const rl = createInterface({
  input: createReadStream(SRC).pipe(createGunzip()),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  lines++;
  if (lines % 100000 === 0) log(`строк: ${lines}, слов: ${defs.size}, форм: ${forms.size}, редиректов: ${redirects.size}`);
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  const isProper = /^[А-ЯЁ]/.test(obj.word || "");
  const word = (obj.word || "").toLowerCase();
  if (!WORD_RE.test(word)) continue;
  const senses = obj.senses || [];

  // статья-словоформа: все значения — form-of («форма род.п. слова дорога»)
  const formOf = senses.length > 0 && senses.every((s) => (s.form_of && s.form_of.length) || (s.tags || []).includes("form-of"));
  if (formOf) {
    const target = senses.find((s) => s.form_of && s.form_of.length);
    const lemma = target ? (target.form_of[0].word || "").toLowerCase() : "";
    if (lemma && lemma !== word && WORD_RE.test(lemma) && !defs.has(word) && !redirects.has(word)) {
      redirects.set(word, lemma);
    }
    continue;
  }

  // парадигма форм (первая непустая статья слова): только однословные формы с меткой
  if (!forms.has(word) && (obj.forms || []).length) {
    const rows = [];
    for (const f of obj.forms) {
      let form = clean(f.form || "");
      // пропускаем аналитические формы (с пробелом/слэшем: «буду… идти») и акцентную лемму
      if (!form || /[\s/]/.test(form) || (f.tags || []).includes("stressed")) continue;
      // снимаем вики-сноски (^ △ ▲ *): оставляем кириллицу, знак ударения и дефис
      form = form.replace(/[^Ѐ-ӿ́\-]/g, "");
      const label = formLabel(f.tags);
      if (!form || !label) continue;
      rows.push({ label, form });
      if (rows.length >= MAX_FORMS) break;
    }
    if (rows.length) forms.set(word, rows);
  }

  // значения статьи с примерами (все примеры — Лев просил не подрезать)
  const parsed = [];
  for (const s of senses) {
    const gloss = clean((s.glosses && s.glosses[s.glosses.length - 1]) || "");
    if (!gloss) continue;
    if (parsed.some((p) => p.gloss === gloss)) continue;
    const ex = [];
    for (const e of s.examples || []) {
      const text = clean(e.text || e.example || "");
      if (!text || text === gloss) continue;
      ex.push({ text, ref: clean(e.ref || "") });
    }
    parsed.push({ gloss, ex });
  }
  if (parsed.length === 0) continue;
  if (isProper) parsed.length = Math.min(parsed.length, PROPER_CAP);

  const pos = POS_RU[obj.pos] ?? "";
  let entry = defs.get(word);
  if (!entry) defs.set(word, (entry = { etym: "", groups: [] }));

  if (!entry.etym) {
    const et = normalizeEtym(clean((obj.etymology_texts || []).join(" ")));
    if (et) {
      entry.etym = et;
      etymCount++;
    }
  }

  const same = entry.groups.find((g) => g.pos === pos && g.proper === isProper);
  if (same) {
    const cap = isProper ? PROPER_CAP : Infinity;
    for (const p of parsed) {
      if (same.senses.length >= cap) break;
      if (!same.senses.some((x) => x.gloss === p.gloss)) same.senses.push(p);
    }
  } else if (entry.groups.length < MAX_GROUPS) {
    entry.groups.push({ pos, proper: isProper, senses: parsed });
  }
  redirects.delete(word);
}
log(`Готово чтение: строк ${lines}, слов ${defs.size}, форм ${forms.size}, редиректов ${redirects.size}, с этимологией ${etymCount}`);

const encodeSense = (s) => {
  exTotal += s.ex.length;
  const parts = [s.gloss];
  for (const e of s.ex) parts.push(e.ref ? e.text + FS + e.ref : e.text);
  return parts.join(RS);
};
const encodeGroup = (g) => [g.pos, ...g.senses.map(encodeSense)].join(US);

const out = [];
for (const [word, entry] of defs) {
  entry.groups.sort((a, b) => (a.proper ? 1 : 0) - (b.proper ? 1 : 0));
  const rec = [entry.etym, ...entry.groups.map(encodeGroup)].join(GS);
  out.push(`${word}\t${rec}`);
}
let redirKept = 0;
for (const [word, lemma] of redirects) {
  if (defs.has(lemma)) {
    out.push(`${word}\t>${lemma}`);
    redirKept++;
  }
}
out.sort();

const formsOut = [];
for (const [word, rows] of forms) {
  formsOut.push(`${word}\t${rows.map((r) => `${r.label}:${r.form}`).join("|")}`);
}
formsOut.sort();

mkdirSync(OUT, { recursive: true });
const raw = out.join("\n");
const gz = gzipSync(raw, { level: 9 });
writeFileSync(join(OUT, "definitions.txt.gz"), gz);
const fRaw = formsOut.join("\n");
const fGz = gzipSync(fRaw, { level: 9 });
writeFileSync(join(OUT, "forms.txt.gz"), fGz);
log(
  `definitions: слов ${defs.size} + редиректов ${redirKept}, примеров ${exTotal}, этимологий ${etymCount}; ` +
    `${(raw.length / 1048576).toFixed(1)} MB -> ${(gz.length / 1048576).toFixed(1)} MB`
);
log(`forms: ${formsOut.length} слов; ${(fRaw.length / 1048576).toFixed(1)} MB -> ${(fGz.length / 1048576).toFixed(1)} MB`);
