import { Inflate as Inflate_1 } from "pako";

const WORD_RE = /^[а-яё]+(-[а-яё]+)*$/;
const SYN_RE = /^[а-яё]+([ -][а-яё]+){0,2}$/;
const MAX_GLOSSES = 10;
const MAX_GROUPS = 6;
const MAX_DECOMP = 200 * 1024 * 1024;
export type DslType = "definitions" | "synonyms";
/** Разобранный словарь: имя из #NAME и статьи «заголовок -> строки групп». */
export interface DslConversion {
  name: string;
  entries: Map<string, string[]>;
}
function ungzipCapped(bytes: Uint8Array): Uint8Array {
  const inflator = new Inflate_1();
  const passThrough = inflator.onData.bind(inflator);
  let total = 0;
  inflator.onData = (chunk: Uint8Array) => {
    total += chunk.length;
    if (total > MAX_DECOMP)
      throw new Error("DSL too large after decompression");
    passThrough(chunk);
  };
  inflator.push(bytes, true);
  if (inflator.err)
    throw new Error("bad gzip: " + inflator.msg);
  // pako объявляет result как «строка или байты»: строка бывает только в строковом
  // режиме, который тут не включён
  return inflator.result as Uint8Array;
}
function cleanHeadword(s: string) {
  return s.replace(/\{([^}]*)\}/g, "$1").replace(/\[\/?[^\]]*\]/g, "").replace(/\\(.)/g, "$1").replace(/['’´]/g, "").trim().toLowerCase();
}
function cleanBody(s: string) {
  return s.replace(/\{\{[^}]*\}\}/g, "").replace(/\{([^}]*)\}/g, "$1").replace(/\[\/?[^\]]*\]/g, "").replace(/[[\]]/g, "").replace(/<<|>>/g, "").replace(/\\(.)/g, "$1").replace(/~/g, "").replace(/\s+/g, " ").trim();
}
const SYN_COUNT_RE = /кол-?\s?во синонимов/i;
const SYN_STOP = /* @__PURE__ */ new Set(["сущ", "гл", "прил", "нареч", "нар", "межд", "предл", "союз", "част", "числ", "мест", "см", "syn"]);
const SYN_MAX_WORDS = 80;
// в ASIS полно описательных оборотов («противодействовавший насильственным действиям») —
// это не синонимы для песни, а длинные чипы, которые распирают панель
const SYN_MAX_LEN = 28;
/**
 * Строка синонимического словаря — в список слов. Форматы разные: у ASIS это
 * «• <<автодорога>> 10» (маркер, ссылка, ранг частотности), у Александровой —
 * «1. см. <<путь>>» и ряды с пометами «распевать (разг.)». Угловые скобки снимает
 * cleanBody, здесь убираем маркеры, нумерацию, пометы в скобках и цифры-ранги.
 */
function synWords(line: string, head: string): string[] {
  if (SYN_COUNT_RE.test(line))
    return [];
  const cleaned = line.replace(/^[\s•·*–—-]+/, "").replace(/^\d+[.)]\s*/, "").replace(/^[^:,;]{1,24}:\s*/, "").replace(/\([^)]*\)/g, " ").replace(/\d+/g, " ");
  const out: string[] = [];
  for (const part of cleaned.split(/[,;]/)) {
    const w = part.trim().toLowerCase().replace(/^см\.?\s*/, "").replace(/\.$/, "").trim();
    if (!w || w.length > SYN_MAX_LEN || w === head || SYN_STOP.has(w) || !SYN_RE.test(w) || out.includes(w))
      continue;
    out.push(w);
  }
  return out;
}
function convertDsl(data: ArrayBuffer, type: DslType): DslConversion {
  let bytes: Uint8Array = new Uint8Array(data);
  if (bytes.length > 2 && bytes[0] === 31 && bytes[1] === 139)
    bytes = ungzipCapped(bytes);
  let enc = "utf-8";
  if (bytes[0] === 255 && bytes[1] === 254)
    enc = "utf-16le";
  else if (!(bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191)) {
    const lim = Math.min(bytes.length, 4e3);
    let marks = 0;
    for (let i = 1; i < lim; i += 2)
      if (bytes[i] === 4 || bytes[i] === 0)
        marks++;
    if (marks > lim / 5)
      enc = "utf-16le";
  }
  let text: string;
  if (enc === "utf-8") {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder("windows-1251").decode(bytes);
    }
  } else {
    text = new TextDecoder(enc).decode(bytes);
  }
  const nameMatch = text.match(/#NAME\s+"([^"]*)"/);
  const name = nameMatch ? nameMatch[1] : "DSL";
  const entries = /* @__PURE__ */ new Map<string, string[]>();
  let heads: string[] = [];
  let body: string[] = [];
  const flush = () => {
    if (heads.length && body.length) {
      for (const head of heads) {
        if (!WORD_RE.test(head))
          continue;
        if (type === "definitions") {
          const glosses: string[] = [];
          for (let g of body) {
            g = g.replace(/[\t|]/g, " ").replace(/;/g, ",");
            if (g && !glosses.includes(g))
              glosses.push(g);
            if (glosses.length >= MAX_GLOSSES)
              break;
          }
          if (glosses.length) {
            let arr = entries.get(head);
            if (!arr)
              entries.set(head, arr = []);
            if (arr.length < MAX_GROUPS)
              arr.push(":" + glosses.join(";"));
          }
        } else {
          const rows: string[][] = [];
          for (const line of body) {
            const words = synWords(line, head);
            if (words.length)
              rows.push(words);
          }
          if (!rows.length)
            continue;
          // у ASIS каждый синоним на своей строке — из сотни строк вышла бы сотня групп
          // по одному слову; такие списки сводим в один ряд, а осмысленные группы
          // (значения у Александровой) оставляем как есть
          const groups: string[][] = rows.length > MAX_GROUPS ? [([] as string[]).concat(...rows)] : rows;
          let arr = entries.get(head);
          if (!arr)
            entries.set(head, arr = []);
          for (const words of groups) {
            const uniq: string[] = [];
            for (const w of words)
              if (!uniq.includes(w))
                uniq.push(w);
            const sig = uniq.slice(0, SYN_MAX_WORDS).join(",");
            if (arr.length < MAX_GROUPS && !arr.includes(sig))
              arr.push(sig);
          }
        }
      }
    }
    heads = [];
    body = [];
  };
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim())
      continue;
    if (rawLine.startsWith("#"))
      continue;
    if (/^[\s\t]/.test(rawLine)) {
      const b = cleanBody(rawLine);
      if (b && b.length >= 3)
        body.push(b);
    } else {
      if (body.length)
        flush();
      const hw = cleanHeadword(rawLine);
      if (hw)
        heads.push(hw);
    }
  }
  flush();
  return { name, entries };
}

export { convertDsl };
