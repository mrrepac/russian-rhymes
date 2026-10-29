const VOWELS = "\u0430\u0435\u0451\u0438\u043E\u0443\u044B\u044D\u044E\u044F";
/**
 * \u0413\u043B\u0430\u0441\u043D\u044B\u0439 \u0441\u043A\u0435\u043B\u0435\u0442 \u0441\u043B\u043E\u0432\u0430 \u2014 \u043F\u043E \u043D\u0435\u043C\u0443 \u0438\u0449\u0443\u0442\u0441\u044F \u0430\u0441\u0441\u043E\u043D\u0430\u043D\u0441\u044B.
 * @param {string} s
 * @returns {string}
 */
function vowelSkeleton(s) {
  let out = "";
  for (const c of s)
    if (VOWELS.includes(c))
      out += c;
  return out;
}
/** @type {Record<string, string>} */
const CONS_CLASS = {
  \u043F: "T",
  \u0431: "T",
  \u0442: "T",
  \u0434: "T",
  \u043A: "T",
  \u0433: "T",
  \u0444: "S",
  \u0432: "S",
  \u0441: "S",
  \u0437: "S",
  \u0448: "S",
  \u0436: "S",
  \u0445: "S",
  \u0449: "S",
  \u0446: "C",
  \u0447: "C",
  \u043C: "N",
  \u043D: "N",
  \u043B: "L",
  \u0440: "L",
  \u0439: "J"
};
/**
 * Согласный скелет: каждая согласная заменена классом (взрывные, шипящие…).
 * @param {string} s
 * @returns {string}
 */
function consonantSkeleton(s) {
  let out = "";
  for (const c of s) {
    const cl = CONS_CLASS[c];
    if (cl)
      out += cl;
  }
  return out;
}
/**
 * @param {string} w
 * @returns {number}
 */
function countSyllables(w) {
  let n = 0;
  for (const c of w)
    if (VOWELS.includes(c))
      n++;
  return n;
}
/*
 * Транскрипция и оценка рифмы.
 *
 * Слово переводится в звуки: мягкость согласных, й в я/е/ё/ю после гласной и знаков,
 * оглушение и озвончение, упрощение кластеров, редукция заударных гласных. Хвост от
 * ударной гласной записывается строкой — это и есть рифм-ключ: согласная, за ней «'»,
 * если она мягкая (у ч щ й мягкость подразумевается); ударная гласная — одна из
 * «аоуыиэ»; заударные — «ъ» (редуцированная после твёрдой), «и», «ы», «у».
 * Пример: дорога → «огъ», поле → «ол'и», любовь → «оф'», память → «ам'ит'».
 *
 * Рифмы больше не ищутся равенством ключей: два хвоста выравниваются, и каждая
 * замена стоит столько, насколько звуки различаются (б/п почти рядом, м/н близко,
 * р/т далеко). Так одна шкала даёт и точные рифмы, и приблизительные (дорога/погода),
 * и созвучия.
 */
const CONS = "пбтдкгфвсзшжхцчщмнлрй";
const KEY_VOWELS = "аоуыиэъ";
const ALWAYS_SOFT = "чщй";
const ALWAYS_HARD = "жшц";
const SOFT_SERIES = "яеёюи";
/** @type {Record<string, string>} */
const VOWEL_QUALITY = { а: "а", я: "а", о: "о", ё: "о", у: "у", ю: "у", ы: "ы", и: "и", э: "э", е: "э" };
/** @type {Record<string, string>} */
const DEVOICE = { б: "п", в: "ф", г: "к", д: "т", ж: "ш", з: "с" };
/** @type {Record<string, string>} */
const VOICE = { п: "б", ф: "в", к: "г", т: "д", ш: "ж", с: "з" };
const VOICELESS = "пфктшсхцчщ";
const VOICING = "бгджз";
const OGO_KEEP_G = new Set([
  "много", "немного", "намного", "строго", "настрого", "нестрого", "дорого", "недорого",
  "задорого", "убого", "полого", "отлого"
]);
/** Где «чн» и «чт» звучат как «шн» и «шт» (конечно, что); в остальных словах — как пишется. */
const SH_WORDS = /^(?:(?:ни|кое-)?что(?:бы|-то|-нибудь|-либо)?|конечно|скучн\S*|нарочн\S*|яичниц\S*|скворечн\S*|прачечн\S*|горчичник\S*)$/;
/** @type {[RegExp, string][]} */
const CLUSTERS = [
  [/вств/g, "ств"], [/здн/g, "зн"], [/стн/g, "сн"], [/стл/g, "сл"], [/лнц/g, "нц"], [/рдц/g, "рц"],
  [/[нд]тск/g, "нск"], [/ндск/g, "нск"], [/стск/g, "ск"], [/нтг/g, "нг"], [/[сзж]ч/g, "щ"],
  [/[тд]ч/g, "ч"], [/[тд]ь?с(?=[кт])/g, "ц"], [/[сз]ш/g, "ш"], [/[сз]ж/g, "ж"], [/г(?=[кч])/g, "х"]
];
/**
 * Звуки слова и номер ударной гласной среди них.
 * @param {string} word
 * @param {number} stressIdx индекс ударной гласной в слове
 * @returns {{ toks: { v: boolean, b: string, s: boolean }[], st: number }}
 */
function transcribe(word, stressIdx) {
  let w = word.toLowerCase();
  if (!VOWELS.includes(w[stressIdx])) {
    stressIdx = -1;
    for (let i = 0; i < w.length; i++)
      if (VOWELS.includes(w[i])) {
        stressIdx = i;
        break;
      }
  }
  if (stressIdx >= 0)
    w = w.slice(0, stressIdx + 1) + "+" + w.slice(stressIdx + 1);
  if (!OGO_KEEP_G.has(word))
    w = w.replace(/([ое]\+?)го(\+?)$/, "$1во$2");
  if (SH_WORDS.test(word))
    w = w.replace(/ч(?=[нт])/g, "ш");
  w = w.replace(/ть?ся$/, "ца");
  for (const [re, to] of CLUSTERS)
    w = w.replace(re, to);
  const toks = [];
  let st = -1;
  let sep = true;
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    if (c === "+")
      continue;
    const prev = toks[toks.length - 1];
    if (VOWELS.includes(c)) {
      const soft = SOFT_SERIES.includes(c);
      const afterCons = prev && !prev.v && !sep;
      if (soft && afterCons && !ALWAYS_HARD.includes(prev.b))
        prev.s = true;
      if (soft && c !== "и" && (!prev || prev.v || sep))
        toks.push({ v: false, b: "й", s: true });
      else if (c === "и" && sep && prev && !prev.v)
        toks.push({ v: false, b: "й", s: true });
      let q = VOWEL_QUALITY[c];
      if (q === "и" && afterCons && ALWAYS_HARD.includes(prev.b))
        q = "ы";
      if (w[i + 1] === "+")
        st = toks.length;
      toks.push({ v: true, b: q, s: false });
      sep = false;
    } else if (c === "ь") {
      if (prev && !prev.v && !ALWAYS_HARD.includes(prev.b))
        prev.s = true;
      sep = true;
    } else if (CONS.includes(c)) {
      if (prev && !prev.v && prev.b === c && !sep)
        continue;
      toks.push({ v: false, b: c, s: ALWAYS_SOFT.includes(c) });
      sep = false;
    } else
      sep = true;
  }
  // оглушение на конце и перед глухой, озвончение перед звонкой (кроме в)
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    if (t.v)
      continue;
    const next = toks[i + 1];
    if (!next) {
      if (DEVOICE[t.b])
        t.b = DEVOICE[t.b];
    } else if (!next.v) {
      if (VOICELESS.includes(next.b) && DEVOICE[t.b])
        t.b = DEVOICE[t.b];
      else if (VOICING.includes(next.b) && VOICE[t.b])
        t.b = VOICE[t.b];
    }
  }
  // после оглушения сошлись одинаковые соседи (бесстрашный): одна согласная
  for (let i = toks.length - 1; i > 0; i--) {
    const a = toks[i - 1], b = toks[i];
    if (!a.v && !b.v && a.b === b.b) {
      a.s = b.s;
      if (st > i - 1)
        st--;
      toks.splice(i, 1);
    }
  }
  if (st < 0)
    st = toks.findIndex((t) => t.v);
  // мягкость зубных перед мягкими зубными: грусть [грус'т'], песня [п'эс'н'ъ]
  for (let i = toks.length - 2; i >= 0; i--) {
    const t = toks[i], n = toks[i + 1];
    if (!t.v && !n.v && n.s && "тдсзн".includes(t.b) && "тдсзнлчщ".includes(n.b))
      t.s = true;
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t.v || i === st)
      continue;
    const p = toks[i - 1];
    const soft = !!p && !p.v && p.s;
    const q = t.b;
    if (i > st) {
      if (q === "а" || q === "о")
        t.b = soft && i !== toks.length - 1 ? "и" : "ъ";
      else if (q === "э")
        t.b = soft ? "и" : "ы";
    } else {
      if (q === "а" || q === "о" || q === "э")
        t.b = soft ? "и" : q === "э" ? "ы" : "а";
    }
  }
  return { toks, st };
}
/** @param {{ v: boolean, b: string, s: boolean }} t */
function tokStr(t) {
  return t.v || !t.s || ALWAYS_SOFT.includes(t.b) ? t.b : t.b + "'";
}
/**
 * Опорная согласная без полной транскрипции — то же, что rhymeKey(...).support, но
 * по двум-трём буквам перед ударной гласной: поиск зовёт её на каждого кандидата, а у
 * открытого хвоста (рука, окно) кандидатов десятки тысяч. Совпадение с rhymeKey
 * проверяется на всём словаре (tests/gold.mjs --support).
 * @param {string} word
 * @param {number} stressIdx
 */
function supportOf(word, stressIdx) {
  const v = word[stressIdx];
  if (!VOWELS.includes(v))
    return rhymeKey(word, stressIdx).support;
  const softV = SOFT_SERIES.includes(v);
  const prev = word[stressIdx - 1];
  // дефис транскрипция пропускает насквозь (ам-ам), здесь так не угадать
  if (prev === "-" || (prev === "ь" || prev === "ъ") && !softV || prev === "й" && CONS.includes(word[stressIdx - 2] ?? ""))
    return rhymeKey(word, stressIdx).support;
  if (!prev || VOWELS.includes(prev) || !CONS.includes(prev) && prev !== "ь" && prev !== "ъ")
    return softV && v !== "и" ? "й" : "";
  if (prev === "ь" || prev === "ъ") {
    // свинья: опора [н'й] — й плюс согласная перед знаком, см. rhymeKey
    const c = word[stressIdx - 2];
    if (!c || !CONS.includes(c))
      return "й";
    const soft = ALWAYS_SOFT.includes(c) || prev === "ь" && !ALWAYS_HARD.includes(c);
    return (soft && !ALWAYS_SOFT.includes(c) ? c + "'" : c) + "й";
  }
  let c = prev;
  const p2 = word[stressIdx - 2];
  if (c === "ч" && p2 && "сзжтд".includes(p2) || c === "ш" && p2 && "сз".includes(p2) || c === "ж" && p2 && "сз".includes(p2))
    return rhymeKey(word, stressIdx).support;
  if (c === "г" && stressIdx === word.length - 1 && (v === "о") && /[ое]го$/.test(word) && !OGO_KEEP_G.has(word))
    c = "в";
  const soft = ALWAYS_SOFT.includes(c) || softV && !ALWAYS_HARD.includes(c);
  return soft && !ALWAYS_SOFT.includes(c) ? c + "'" : c;
}
/**
 * Рифм-ключ слова: хвост от ударной гласной в звуках, плюс опорная согласная —
 * последняя перед ударной гласной («», если перед ней гласная или начало слова).
 * @param {string} word
 * @param {number} stressIdx индекс ударной гласной
 * @returns {{ key: string, support: string }}
 */
function rhymeKey(word, stressIdx) {
  const { toks, st } = transcribe(word, stressIdx);
  if (st < 0)
    return { key: "", support: "" };
  const key = toks.slice(st).map(tokStr).join("");
  const p = toks[st - 1];
  if (!p || p.v)
    return { key, support: "" };
  // й из «ья/ьи» (свинья, статьи) слышится вместе с согласной перед знаком: опора — обе,
  // иначе меня/свинья и пути/статьи разошлись бы по опоре, а это точные рифмы
  const pp = toks[st - 2];
  const support = p.b === "й" && pp && !pp.v ? tokStr(pp) + "й" : tokStr(p);
  return { key, support };
}
// --- оценка рифмы -------------------------------------------------------------
// Звуки кодируются числами: согласная — 2·номер + мягкость, гласная — 42 + номер.
const V0 = CONS.length * 2;
const NCODES = V0 + KEY_VOWELS.length;
const GROUPS = ["пбтдкг", "фвсзшжхщ", "цч", "мн", "лр", "й"];
const VOICE_PAIRS = ["пб", "тд", "кг", "фв", "сз", "шж"];
/** @type {Record<string, number>} */
const CLOSE_PAIRS = { кх: 0.4, гх: 0.4, сш: 0.4, зж: 0.4, щш: 0.3, чщ: 0.4, цс: 0.4, цт: 0.5, чш: 0.5, чт: 0.5, мн: 0.35, лр: 0.4, йл: 0.7 };
/** @param {string} a @param {string} b */
function baseCost(a, b) {
  if (a === b)
    return 0;
  const pair = a < b ? a + b : b + a;
  if (VOICE_PAIRS.some((p) => p === pair || p === b + a))
    return 0.25;
  const close = CLOSE_PAIRS[pair] ?? CLOSE_PAIRS[b + a];
  if (close !== undefined)
    return close;
  if (GROUPS.some((g) => g.includes(a) && g.includes(b)))
    return 0.5;
  return 0.9;
}
/** @type {Record<string, number>} */
// заударные ъ и и после мягкой почти не различимы на слух: время/креме, буря/бури
const VOWEL_PAIRS = { ъи: 0.15, ъы: 0.3, иы: 0.25, иэ: 0.3, ыэ: 0.35 };
const COST = new Float64Array(NCODES * NCODES);
for (let i = 0; i < NCODES; i++)
  for (let j = 0; j < NCODES; j++) {
    let c;
    if (i < V0 && j < V0) {
      c = baseCost(CONS[i >> 1], CONS[j >> 1]);
      if ((i & 1) !== (j & 1))
        c = Math.min(1, c + (i >> 1 === j >> 1 ? 0.2 : 0.15));
    } else if (i >= V0 && j >= V0) {
      const a = KEY_VOWELS[i - V0], b = KEY_VOWELS[j - V0];
      c = a === b ? 0 : VOWEL_PAIRS[a + b] ?? VOWEL_PAIRS[b + a] ?? 0.8;
    } else
      c = 99;
    COST[i * NCODES + j] = c;
  }
/**
 * Ключ строкой → коды звуков.
 * @param {string} key
 * @returns {Uint8Array}
 */
function encodeKey(key) {
  const out = [];
  for (let i = 0; i < key.length; i++) {
    const c = key[i];
    const ci = CONS.indexOf(c);
    if (ci >= 0) {
      const soft = ALWAYS_SOFT.includes(c) || key[i + 1] === "'";
      out.push(ci * 2 + (soft ? 1 : 0));
    } else {
      const vi = KEY_VOWELS.indexOf(c);
      if (vi >= 0)
        out.push(V0 + vi);
    }
  }
  return Uint8Array.from(out);
}
/** @param {number} code */
const isVowelCode = (code) => code >= V0;
/**
 * Класс ключа: ударная гласная (и/ы — одна) и число заударных слогов. Рифмуются только
 * ключи одного класса — у остальных другой ударный звук или другой ритм.
 * @param {Uint8Array} codes
 */
function keyClass(codes) {
  if (codes.length === 0)
    return "";
  let q = KEY_VOWELS[codes[0] - V0] ?? "";
  if (q === "ы")
    q = "и";
  let n = 0;
  for (let i = 1; i < codes.length; i++)
    if (isVowelCode(codes[i]))
      n++;
  return q + n;
}
/**
 * Вес звука: согласные сразу за ударной гласной слышны сильнее всего.
 * @param {Uint8Array} codes
 */
function weights(codes) {
  const w = new Float64Array(codes.length);
  let seenVowel = false;
  for (let i = 0; i < codes.length; i++) {
    if (i > 0 && isVowelCode(codes[i]))
      seenVowel = true;
    w[i] = i === 0 || !seenVowel ? 1 : 0.75;
  }
  return w;
}
/**
 * Цена выпадения звука: гласная выпасть не может, конечная согласная — дешевле, после согласной — ещё дешевле.
 * @param {Uint8Array} codes
 * @param {number} i
 */
function gapCost(codes, i) {
  const c = codes[i];
  if (isVowelCode(c))
    return 99;
  if (c >> 1 === CONS.indexOf("й"))
    return 0.4;
  if (i === codes.length - 1)
    return i > 0 && !isVowelCode(codes[i - 1]) ? 0.4 : 0.5;
  return 0.6;
}
const dpPrev = new Float64Array(64);
const dpCur = new Float64Array(64);
/**
 * Сходство двух хвостов одного класса, 0…1: 1 — звучат одинаково.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
function tailSimilarity(a, b) {
  const n = a.length, m = b.length;
  if (n === 0 || m === 0 || n > 60 || m > 60)
    return 0;
  const wa = weights(a), wb = weights(b);
  let total = 0;
  for (let i = 0; i < n; i++)
    total += wa[i];
  for (let j = 0; j < m; j++)
    total += wb[j];
  total /= 2;
  // ударные гласные стоят друг против друга всегда
  dpPrev[0] = COST[a[0] * NCODES + b[0]];
  for (let j = 1; j < m; j++)
    dpPrev[j] = dpPrev[j - 1] + gapCost(b, j) * wb[j];
  for (let i = 1; i < n; i++) {
    dpCur[0] = dpPrev[0] + gapCost(a, i) * wa[i];
    for (let j = 1; j < m; j++) {
      const w = (wa[i] + wb[j]) / 2;
      const sub = dpPrev[j - 1] + COST[a[i] * NCODES + b[j]] * w;
      const del = dpPrev[j] + gapCost(a, i) * wa[i];
      const ins = dpCur[j - 1] + gapCost(b, j) * wb[j];
      dpCur[j] = Math.min(sub, del, ins);
    }
    dpPrev.set(dpCur.subarray(0, m));
  }
  return Math.max(0, 1 - dpPrev[m - 1] / total);
}
/**
 * Сходство опорных согласных, 0…1. Пустая опора — гласная или начало слова. Опора «Cй»
 * (свинья → н'й) сверяется и по й, и по согласной перед ним — со скидкой 0.1.
 * @param {string} a
 * @param {string} b
 */
function supportSimilarity(a, b) {
  if (!a && !b)
    return 1;
  if (!a || !b)
    return 0.4;
  const A = supportCodes(a), B = supportCodes(b);
  /** @param {number} x @param {number} y */
  const sim = (x, y) => 1 - Math.min(1, COST[x * NCODES + y]);
  let best = sim(A[A.length - 1], B[B.length - 1]);
  if (A.length > 1 || B.length > 1)
    best = Math.max(best, 0.9 * sim(A[0], B[0]));
  return best;
}
/** @type {Map<string, Uint8Array>} опор всего несколько десятков, а сверяются они на каждом кандидате */
const SUPPORT_CODES = new Map();
/** @param {string} s */
function supportCodes(s) {
  let c = SUPPORT_CODES.get(s);
  if (c === undefined)
    SUPPORT_CODES.set(s, c = encodeKey(s));
  return c;
}
/**
 * Два звука левее опоры, ближний первым: доро́га → [о, д]. По ним меряется глубина рифмы.
 * @param {string} word
 * @param {number} stressIdx
 * @returns {number[]} коды звуков (encodeKey), 0–2 штуки
 */
function preSupport(word, stressIdx) {
  const { toks, st } = transcribe(word, stressIdx);
  const out = [];
  for (let i = st - 2; i >= 0 && i >= st - 3; i--)
    out.push(encodeKey(tokStr(toks[i]))[0]);
  return out;
}
/**
 * Глубина рифмы, 0…1: насколько совпадают звуки левее опоры. Дальний звук считается,
 * только если совпал ближний — доро́га/поро́га (о, потом д/п) глубже, чем доро́га/стро́го.
 * @param {number[]} a preSupport запроса
 * @param {number[]} b preSupport кандидата
 */
function depthSimilarity(a, b) {
  if (!a.length || !b.length)
    return 0;
  const near = 1 - Math.min(1, COST[a[0] * NCODES + b[0]]);
  if (near < 0.7 || a.length < 2 || b.length < 2)
    return near / 2;
  return (near + 1 - Math.min(1, COST[a[1] * NCODES + b[1]])) / 2;
}
const RHYME_MIN = 0.8;
const EXACT_MIN = 0.95;
const CONSON_MIN = 0.6;
/**
 * Итоговая оценка слова-кандидата. Открытый хвост (рука, окно — одна ударная гласная)
 * держится только на опоре: без неё рука/вода — созвучие, а не рифма.
 * @param {number} tail сходство хвостов
 * @param {boolean} open хвост — одна гласная
 * @param {number} sup сходство опор
 */
function wordScore(tail, open, sup) {
  return open ? tail * (0.5 + 0.5 * sup) : tail;
}
/**
 * Гласные двух хвостов одного класса попарно близки — условие ассонанса.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
function vowelsCompatible(a, b) {
  let i = 0, j = 0;
  for (; ; ) {
    while (i < a.length && !isVowelCode(a[i]))
      i++;
    while (j < b.length && !isVowelCode(b[j]))
      j++;
    if (i >= a.length || j >= b.length)
      return i >= a.length && j >= b.length;
    if (COST[a[i] * NCODES + b[j]] > 0.35)
      return false;
    i++;
    j++;
  }
}
/**
 * Раздел, в который попадает кандидат.
 * @param {number} score итоговая оценка
 * @param {number} tail сходство хвостов
 * @param {number} sup сходство опор
 * @param {boolean} vowelsOk гласные совместимы (vowelsCompatible)
 * @returns {"exact" | "near" | "conson" | "asson" | "none"}
 */
function tierOf(score, tail, sup, vowelsOk) {
  if (score >= RHYME_MIN)
    return tail >= EXACT_MIN && sup >= 0.75 ? "exact" : "near";
  if (score >= CONSON_MIN)
    return "conson";
  return vowelsOk ? "asson" : "none";
}
/**
 * Оценить пару слов целиком — для тестов и эталона.
 * @param {string} w1
 * @param {number} s1
 * @param {string} w2
 * @param {number} s2
 * @returns {{ score: number, tier: "exact" | "near" | "conson" | "asson" | "none" }}
 */
function rhymePair(w1, s1, w2, s2) {
  const a = rhymeKey(w1, s1), b = rhymeKey(w2, s2);
  const ca = encodeKey(a.key), cb = encodeKey(b.key);
  if (!ca.length || keyClass(ca) !== keyClass(cb))
    return { score: 0, tier: "none" };
  const tail = tailSimilarity(ca, cb);
  const sup = supportSimilarity(a.support, b.support);
  const score = wordScore(tail, ca.length === 1, sup);
  return { score, tier: tierOf(score, tail, sup, vowelsCompatible(ca, cb)) };
}
/**
 * Поставить знак ударения после указанной гласной. Односложные и «ё» не трогаем.
 * @param {string} word
 * @param {number} stressIdx
 * @returns {string}
 */
function markStress(word, stressIdx) {
  if (countSyllables(word) < 2)
    return word;
  if (word[stressIdx] === "\u0451")
    return word;
  if (stressIdx < 0 || stressIdx >= word.length)
    return word;
  return word.slice(0, stressIdx + 1) + "\u0301" + word.slice(stressIdx + 1);
}
/**
 * Формы одного гнезда: педантичное/педантичная, дорога/дороги — рифмовать нечем.
 * Совпадать должно почти всё слово (>=3/4 длины), иначе под правило попадали разные
 * корни с общим началом: весна/весла, весна/веса — нормальные рифмы.
 * Хвостовое вхождение (мороз/роз, окно/но, сон/персон) однокоренным НЕ считается:
 * раньше оно выбрасывалось скопом и уносило половину самых певучих рифм.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function looksSameRoot(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i])
    i++;
  const max = Math.max(a.length, b.length);
  return i >= 3 && i >= max - 2 && i * 4 >= max * 3;
}
const VERB_PREFIXES = /* @__PURE__ */ new Set([
  "в", "вз", "вс", "взо", "воз", "вос", "возо", "вы", "до", "за", "из", "ис", "изо", "на", "над", "надо",
  "не", "недо", "о", "об", "обо", "обез", "обес", "от", "ото", "пере", "по", "под", "подо", "пре", "пред", "при", "про",
  "раз", "рас", "разо", "роз", "рос", "с", "со", "у"
]);
/**
 * Приставочная пара глаголов: ходить/уходить, петь/спеть — рифма ни о чём, её и убираем.
 * Проверка только для глаголов и только по списку приставок: у глаголов приставка —
 * закрытый класс, поэтому случайные совпадения (петь/терпеть, жить/служить, пить/купить)
 * сюда не попадают, а у существительных так нельзя — до/рога и по/года разного корня.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function prefixVerbPair(a, b) {
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short === long || !long.endsWith(short))
    return false;
  return VERB_PREFIXES.has(long.slice(0, long.length - short.length));
}
/**
 * Начальный согласный кластер — по нему ищутся аллитерации.
 * @param {string} word
 * @returns {string}
 */
function alliterationPrefix(word) {
  if (!word)
    return "";
  if (VOWELS.includes(word[0]))
    return word[0];
  let p = "";
  for (const c of word) {
    if (VOWELS.includes(c) || c === "\u044C" || c === "\u044A" || c === "-")
      break;
    p += c;
  }
  return p;
}

export {
  VOWELS, alliterationPrefix, consonantSkeleton, countSyllables, encodeKey, keyClass, looksSameRoot, markStress,
  depthSimilarity, preSupport, prefixVerbPair, CONSON_MIN, RHYME_MIN, rhymeKey, rhymePair, supportOf, supportSimilarity, tailSimilarity, tierOf, transcribe, vowelSkeleton,
  vowelsCompatible, wordScore
};
