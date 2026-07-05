// Фразеологизмы и устойчивые выражения из русского Викисловаря (kaikki, CC BY-SA):
// статьи-фразы («железная дорога», «скатертью дорога») с толкованиями,
// индексированные по каждому содержательному слову фразы И его лемме.
// Выход: dict/phrases.txt.gz — "слово\tфраза~толкование|фраза~толкование"
// Запуск: node tools/build-phrases.mjs [--kaikki <jsonl.gz>] [--lemmas <word2lemma.dat>]

import { createReadStream, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
const KAIKKI = argOf("--kaikki", join(HERE, "sources", "kaikki-ru.jsonl.gz"));
const W2L = argOf("--lemmas", join(HERE, "sources", "word2lemma.dat"));

const PHRASE_RE = /^[а-яё]+([ -][а-яё]+)+$/;
const WORD_RE = /^[а-яё]+(-[а-яё]+)*$/;
const STOP = new Set("и в во не на он она оно они мы вы ты я с со как а то все она так его но да ты к у же за бы по ее мне было вот от меня о из ему при или ни быть был него до вас нибудь опять уж вам ведь там свой их чем была сам чтоб без будто чего раз тоже себе под будет тогда кто этот того потому этого какой ему ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех можно эти два для свои где есть надо ней либо кого мог нет česk".split(" "));
const MAX_PER_WORD = 24;
const MAX_GLOSS = 120;

const t0 = Date.now();
const log = (m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

// леммы для индексации слов фразы (форма -> первая лемма)
const lemmaOf = new Map();
if (existsSync(W2L)) {
  log("Читаю word2lemma...");
  const rl = createInterface({ input: createReadStream(W2L, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const p = line.split("\t");
    if (p.length < 2) continue;
    const form = p[0].toLowerCase().trim();
    const lemma = p[1].toLowerCase().trim();
    if (form !== lemma && WORD_RE.test(form) && WORD_RE.test(lemma) && !lemmaOf.has(form)) lemmaOf.set(form, lemma);
  }
  log(`  лемм: ${lemmaOf.size}`);
}

log("Читаю kaikki (фразы)...");
const byWord = new Map(); // слово -> [{phrase, gloss}]
let phrases = 0;
{
  const rl = createInterface({ input: createReadStream(KAIKKI).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const phrase = (obj.word || "").toLowerCase().trim();
    if (!PHRASE_RE.test(phrase)) continue;
    let gloss = "";
    for (const s of obj.senses || []) {
      const g = (s.glosses && s.glosses[s.glosses.length - 1]) || "";
      if (g) {
        gloss = g.replace(/\s+/g, " ").trim();
        break;
      }
    }
    if (!gloss) continue;
    if (gloss.length > MAX_GLOSS) {
      gloss = gloss.slice(0, MAX_GLOSS);
      const sp = gloss.lastIndexOf(" ");
      if (sp > MAX_GLOSS * 0.6) gloss = gloss.slice(0, sp);
      gloss += "…";
    }
    gloss = gloss.replace(/[\t|~]/g, " ");
    phrases++;

    const targets = new Set();
    for (const w of phrase.split(/[ -]/)) {
      if (w.length < 3 || STOP.has(w)) continue;
      targets.add(w);
      const lm = lemmaOf.get(w);
      if (lm) targets.add(lm);
    }
    for (const target of targets) {
      let arr = byWord.get(target);
      if (!arr) byWord.set(target, (arr = []));
      if (arr.length < MAX_PER_WORD * 2) arr.push({ phrase, gloss });
    }
  }
}
log(`фраз: ${phrases}, слов-ключей: ${byWord.size}`);

const out = [];
for (const [word, arr] of byWord) {
  // короткие и известные фразы первыми
  arr.sort((a, b) => a.phrase.length - b.phrase.length || (a.phrase < b.phrase ? -1 : 1));
  const seen = new Set();
  const items = [];
  for (const { phrase, gloss } of arr) {
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    items.push(`${phrase}~${gloss}`);
    if (items.length >= MAX_PER_WORD) break;
  }
  out.push(`${word}\t${items.join("|")}`);
}
out.sort();

const OUT = join(HERE, "..", "dict");
mkdirSync(OUT, { recursive: true });
const raw = out.join("\n");
const gz = gzipSync(raw, { level: 9 });
writeFileSync(join(OUT, "phrases.txt.gz"), gz);
log(`phrases: ${(raw.length / 1048576).toFixed(1)} MB -> ${(gz.length / 1048576).toFixed(1)} MB`);
