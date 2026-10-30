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
