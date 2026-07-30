const VOWELS = "\u0430\u0435\u0451\u0438\u043E\u0443\u044B\u044D\u044E\u044F";
function vowelSkeleton(s) {
  let out = "";
  for (const c of s)
    if (VOWELS.includes(c))
      out += c;
  return out;
}
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
function consonantSkeleton(s) {
  let out = "";
  for (const c of s) {
    const cl = CONS_CLASS[c];
    if (cl)
      out += cl;
  }
  return out;
}
function countSyllables(w) {
  let n = 0;
  for (const c of w)
    if (VOWELS.includes(c))
      n++;
  return n;
}
const DEVOICE = { \u0431: "\u043F", \u0432: "\u0444", \u0433: "\u043A", \u0434: "\u0442", \u0436: "\u0448", \u0437: "\u0441" };
const VOICELESS = "\u043F\u0444\u043A\u0442\u0448\u0441\u0445\u0446\u0447\u0449";
const OGO_KEEP_G = /* @__PURE__ */ new Set([
  "\u043C\u043D\u043E\u0433\u043E",
  "\u043D\u0435\u043C\u043D\u043E\u0433\u043E",
  "\u043D\u0430\u043C\u043D\u043E\u0433\u043E",
  "\u0441\u0442\u0440\u043E\u0433\u043E",
  "\u043D\u0430\u0441\u0442\u0440\u043E\u0433\u043E",
  "\u043D\u0435\u0441\u0442\u0440\u043E\u0433\u043E",
  "\u0434\u043E\u0440\u043E\u0433\u043E",
  "\u043D\u0435\u0434\u043E\u0440\u043E\u0433\u043E",
  "\u0437\u0430\u0434\u043E\u0440\u043E\u0433\u043E",
  "\u0443\u0431\u043E\u0433\u043E",
  "\u043F\u043E\u043B\u043E\u0433\u043E",
  "\u043E\u0442\u043B\u043E\u0433\u043E"
]);
function rhymeKey(word, stressIdx) {
  let tail = word.slice(stressIdx);
  const head = word.slice(0, stressIdx);
  tail = tail.replace(/ться$/, "\u0446\u0430").replace(/тся$/, "\u0446\u0430");
  if (!OGO_KEEP_G.has(word))
    tail = tail.replace(/([ое])го$/, "$1\u0432\u043E");
  tail = tail.replace(/рдц/g, "\u0440\u0446").replace(/лнц/g, "\u043D\u0446").replace(/стн/g, "\u0441\u043D").replace(/здн/g, "\u0437\u043D").replace(/вств/g, "\u0441\u0442\u0432").replace(/стл/g, "\u0441\u043B").replace(/нтг/g, "\u043D\u0433");
  tail = tail.replace(/[сз]ч/g, "\u0449").replace(/[тд]ч/g, "\u0447");
  const chars = [...tail];
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    let c = chars[i];
    let atEnd = true;
    for (let j = i + 1; j < chars.length; j++)
      if (chars[j] !== "\u044C" && chars[j] !== "\u044A") {
        atEnd = false;
        break;
      }
    const next = chars[i + 1];
    if (DEVOICE[c] && (atEnd || next && VOICELESS.includes(next)))
      c = DEVOICE[c];
    if (c === "\u0438" && out.length && "\u0436\u0448\u0446".includes(out[out.length - 1]))
      c = "\u044B";
    if (c === "\u0435" && out.length && "\u0436\u0448\u0446".includes(out[out.length - 1]))
      c = "\u044D";
    out.push(c);
  }
  const t2 = out.join("");
  const first = t2[0];
  const rest = [...t2.slice(1)].map((ch) => {
    if (ch === "\u043E" || ch === "\u0430")
      return "\u0430";
    if (ch === "\u0435" || ch === "\u0438" || ch === "\u044F")
      return "\u0438";
    if (ch === "\u0451")
      return "\u043E";
    return ch;
  }).join("");
  const stressed = first === "\u0451" ? "\u043E" : first;
  const key = (stressed + rest).replace(/([жшчщц])ь$/, "$1");
  let support = "";
  for (let i = head.length - 1; i >= 0; i--) {
    const ch = head[i];
    if (ch === "\u044C" || ch === "\u044A")
      continue;
    if (VOWELS.includes(ch))
      break;
    support = ch;
    break;
  }
  return { key, support };
}
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
 */
function prefixVerbPair(a, b) {
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short === long || !long.endsWith(short))
    return false;
  return VERB_PREFIXES.has(long.slice(0, long.length - short.length));
}
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

export { VOWELS, alliterationPrefix, consonantSkeleton, countSyllables, looksSameRoot, markStress, prefixVerbPair, rhymeKey, vowelSkeleton };
