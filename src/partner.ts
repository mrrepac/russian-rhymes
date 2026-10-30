/**
 * Строка-партнёр: к какой из строк выше должна рифмоваться та, что сейчас пишется.
 * Смотрим концовки строфы над курсором, спариваем уже зарифмованные и ищем оставшуюся
 * без пары по самым частым схемам: перекрёстной (АБАБ), смежной (ААББ) и опоясывающей (АББА).
 *
 * ends — последние слова строк строфы сверху вниз, курсор на строке сразу за ними;
 * rhymes(i, j) — насколько рифмуются концовки i и j: 2 — рифма, 1 — созвучие, 0 — нет.
 * Возвращает индекс в ends или -1.
 */
export function partnerIndex(ends: string[], rhymes: (i: number, j: number) => number): number {
  const k = ends.length;
  const mate: number[] = new Array(k).fill(-1);
  const level: number[][] = ends.map((_, i) => ends.map((_, j) => j > i && j - i <= 3 ? rhymes(i, j) : 0));
  // сперва настоящие рифмы, потом созвучия: иначе «домой» успевает спариться с «тепло»
  // раньше, чем «тепло» со «светло». Пара не дальше трёх строк — дальше уже другая строфа
  for (const need of [2, 1]) {
    for (let i = 0; i < k; i++) {
      if (mate[i] >= 0)
        continue;
      for (let j = i + 1; j < k && j - i <= 3; j++) {
        if (mate[j] < 0 && level[i][j] >= need) {
          mate[i] = j;
          mate[j] = i;
          break;
        }
      }
    }
  }
  const free = (i: number) => i >= 0 && mate[i] < 0;
  // АБАБ: строка через одну без пары
  if (free(k - 2))
    return k - 2;
  // АББА: две последние зарифмованы между собой, а третья с конца ждёт пару
  if (free(k - 3) && mate[k - 1] === k - 2)
    return k - 3;
  // ААББ: предыдущая без пары, а выше уже есть соседняя пара — значит, рифмуем подряд
  if (free(k - 1) && mate.some((m, i) => m === i + 1))
    return k - 1;
  return -1;
}

/**
 * Строка — не стих, а имя говорящего или ремарка: «МАША:», «**Маша**», «Старый рыбак:»,
 * «(в сторону)». Такие строки в строфе пропускаются, иначе имя считалось бы концовкой.
 * Строка с двоеточием, но с запятыми или длиннее трёх слов («Пора, красавица, проснись:») — стих.
 */
export function isSpeakerLine(text: string): boolean {
  const raw = text.trim();
  if (/^[(\[].*[)\]]$/.test(raw))
    return true;
  const bold = /^(\*\*|__).+(\*\*|__):?$/.test(raw);
  const t = raw.replace(/^[>\-*_\s]+|[*_\s]+$/g, "").replace(/[*_]/g, "");
  const colon = t.endsWith(":");
  // «Маша (тихо):» — ремарка при имени не считается словом
  const name = t.replace(/:$/, "").replace(/\s*\([^)]*\)\s*/g, " ").trim();
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3 || /[.,;!?—–]/.test(name))
    return false;
  const letters = name.replace(/[^а-яёa-z]/gi, "");
  const caps = letters.length >= 2 && letters === letters.toUpperCase();
  // одно слово с заглавной и без знаков — имя («Маша»): однословная строка стиха почти всегда с точкой или запятой
  const single = words.length === 1 && /^[А-ЯЁA-Z]/.test(name);
  return colon || caps || bold || single;
}
