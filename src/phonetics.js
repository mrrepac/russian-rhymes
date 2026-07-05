// Фонетика русской рифмы. Общий модуль: используется и скриптом сборки
// словаря (tools/build-dict.mjs), и плагином в рантайме — ключи обязаны
// совпадать, поэтому файл один.

export const VOWELS = "аеёиоуыэюя";
export const WORD_RE = /^[а-яё]+(-[а-яё]+)*$/;

/**
 * Гласный скелет строки — только гласные, по порядку.
 * У рифм-ключа это «рисунок» ассонанса: ударная гласная + заударные.
 * @param {string} s
 */
export function vowelSkeleton(s) {
  let out = "";
  for (const c of s) if (VOWELS.includes(c)) out += c;
  return out;
}

// Фонетические классы согласных для созвучий: смычные, щелевые,
// аффрикаты, носовые, плавные. Глухие и звонкие — один класс (г/к, в/ф).
const CONS_CLASS = {
  п: "T", б: "T", т: "T", д: "T", к: "T", г: "T",
  ф: "S", в: "S", с: "S", з: "S", ш: "S", ж: "S", х: "S", щ: "S",
  ц: "C", ч: "C",
  м: "N", н: "N",
  л: "L", р: "L",
  й: "J",
};

/**
 * Скелет согласных по фонетическим классам. Созвучие = у ключей совпадают
 * и гласный, и классовый согласный скелет (дорога «ога»=T ~ погода «ода»=T).
 * @param {string} s
 */
export function consonantSkeleton(s) {
  let out = "";
  for (const c of s) {
    const cl = CONS_CLASS[c];
    if (cl) out += cl;
  }
  return out;
}

/** @param {string} w */
export function countSyllables(w) {
  let n = 0;
  for (const c of w) if (VOWELS.includes(c)) n++;
  return n;
}

const DEVOICE = { б: "п", в: "ф", г: "к", д: "т", ж: "ш", з: "с" };
const VOICELESS = "пфктшсхцчщ";

// Наречия/предикативы на -ого/-его, где г звучит как [г] (мнОго→[мнОга], стрОго,
// дОрого), а НЕ как [в]. В отличие от род. падежа прил./мест. (красного, его,
// многого) их нельзя нормализовать -ого→-ово ниже — иначе они сваливаются в рифмы
// со «слово/клёво». Различить по одной строке слова нельзя (стро́го нареч. vs
// стро́гого прил.), поэтому — явный список.
const OGO_KEEP_G = new Set([
  "много", "немного", "намного",
  "строго", "настрого", "нестрого",
  "дорого", "недорого", "задорого",
  "убого", "полого", "отлого",
]);

/**
 * Рифм-ключ: фонетически нормализованный хвост слова от ударной гласной,
 * плюс опорная согласная (последняя согласная перед ударной гласной).
 * Рифмуются слова с одинаковым ключом; совпадение опоры = точная рифма.
 * @param {string} word слово в нижнем регистре
 * @param {number} stressIdx индекс ударной гласной
 * @returns {{key: string, support: string}}
 */
export function rhymeKey(word, stressIdx) {
  let tail = word.slice(stressIdx);
  const head = word.slice(0, stressIdx);

  // возвратные глаголы: -тся/-ться звучат как [ца]
  tail = tail.replace(/ться$/, "ца").replace(/тся$/, "ца");
  // окончания -ого/-его звучат как [ово]/[ево] (род. падеж прил./мест.: красного→[во]),
  // но НЕ у наречий (много/строго/дорого — там [г]); их держим отдельным списком
  if (!OGO_KEEP_G.has(word)) tail = tail.replace(/([ое])го$/, "$1во");
  // непроизносимые согласные в кластерах
  tail = tail
    .replace(/рдц/g, "рц")
    .replace(/лнц/g, "нц")
    .replace(/стн/g, "сн")
    .replace(/здн/g, "зн")
    .replace(/вств/g, "ств")
    .replace(/стл/g, "сл")
    .replace(/нтг/g, "нг");
  // сч/зч -> щ, тч/дч -> ч
  tail = tail.replace(/[сз]ч/g, "щ").replace(/[тд]ч/g, "ч");

  const chars = [...tail];
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    let c = chars[i];
    // «конец слова» для оглушения: дальше ничего ИЛИ только ь/ъ (рожь→[рош],
    // голубь→[голуп], кровь→[кроф]) — сам ь/ъ звука не даёт
    let atEnd = true;
    for (let j = i + 1; j < chars.length; j++) if (chars[j] !== "ь" && chars[j] !== "ъ") { atEnd = false; break; }
    const next = chars[i + 1];
    // оглушение звонкой в конце слова и перед глухой
    if (DEVOICE[c] && (atEnd || (next && VOICELESS.includes(next)))) c = DEVOICE[c];
    // жи/ши/ци фонетически [ы], же/ше/це — [э]
    if (c === "и" && out.length && "жшц".includes(out[out.length - 1])) c = "ы";
    if (c === "е" && out.length && "жшц".includes(out[out.length - 1])) c = "э";
    out.push(c);
  }
  const t = out.join("");

  // редукция заударных гласных: о/а -> а, е/и/я -> и
  const first = t[0];
  const rest = [...t.slice(1)]
    .map((ch) => {
      if (ch === "о" || ch === "а") return "а";
      if (ch === "е" || ch === "и" || ch === "я") return "и";
      if (ch === "ё") return "о";
      return ch;
    })
    .join("");
  const stressed = first === "ё" ? "о" : first;
  // финальный ь после шипящих не звучит (ночь = [ноч])
  const key = (stressed + rest).replace(/([жшчщц])ь$/, "$1");

  let support = "";
  for (let i = head.length - 1; i >= 0; i--) {
    const ch = head[i];
    if (ch === "ь" || ch === "ъ") continue;
    if (VOWELS.includes(ch)) break;
    support = ch;
    break;
  }
  return { key, support };
}

/**
 * Слово с комбинирующим знаком ударения после ударной гласной.
 * Ударение не ставится, если гласная одна или это ё.
 * @param {string} word
 * @param {number} stressIdx
 */
export function markStress(word, stressIdx) {
  if (countSyllables(word) < 2) return word;
  if (word[stressIdx] === "ё") return word;
  if (stressIdx < 0 || stressIdx >= word.length) return word;
  return word.slice(0, stressIdx + 1) + "́" + word.slice(stressIdx + 1);
}

/**
 * Грубая проверка однокоренности для фильтра выдачи:
 * одно слово оканчивается на другое целиком (стихи/двустихи) либо
 * слова совпадают почти целиком — расходятся только в паре последних букв
 * (россия/россии, катя/кате — словоформы, а не рифмы).
 * @param {string} a @param {string} b
 */
export function looksSameRoot(a, b) {
  if (a.endsWith(b) || b.endsWith(a)) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 3 && i >= Math.max(a.length, b.length) - 2;
}

/**
 * Начальный кластер для аллитерации: согласные до первой гласной (стр-ана → «стр»,
 * к-от → «к»); слово с гласной в начале — сама эта гласная (я-блоко → «я»).
 * По нему подбираются слова с тем же началом.
 * @param {string} word
 */
export function alliterationPrefix(word) {
  if (!word) return "";
  if (VOWELS.includes(word[0])) return word[0];
  let p = "";
  for (const c of word) {
    if (VOWELS.includes(c) || c === "ь" || c === "ъ" || c === "-") break;
    p += c;
  }
  return p;
}
