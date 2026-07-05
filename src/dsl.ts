// Конвертер словарей формата DSL (Lingvo/GoldenDict) — работает прямо в плагине.
// Поддерживает .dsl и .dsl.dz (gzip), кодировки UTF-16LE / UTF-8 / windows-1251.
// Результат — Map слово -> группы в формате файлов dict/local-*.txt.gz.
import * as pako from "pako";

const WORD_RE = /^[а-яё]+(-[а-яё]+)*$/;
const SYN_RE = /^[а-яё]+([ -][а-яё]+){0,2}$/;
const MAX_GLOSSES = 10; // сколько значений (строк-смыслов) брать с одного словаря; длину НЕ режем
const MAX_GROUPS = 6;

export type DslType = "definitions" | "synonyms";

const MAX_DECOMP = 200 * 1024 * 1024; // потолок распаковки .dsl.dz — защита от gzip-бомбы

/** Распаковать gzip с ограничением на размер вывода: без него .dsl.dz на пару КБ мог
 * развернуться в гигабайты и уронить/подвесить главный поток Obsidian. */
function ungzipCapped(bytes: Uint8Array): Uint8Array {
  const inflator = new pako.Inflate();
  const passThrough = inflator.onData.bind(inflator);
  let total = 0;
  inflator.onData = (chunk: pako.Data) => {
    total += (chunk as Uint8Array).length;
    if (total > MAX_DECOMP) throw new Error("DSL too large after decompression");
    passThrough(chunk);
  };
  inflator.push(bytes, true);
  if (inflator.err) throw new Error("bad gzip: " + inflator.msg);
  return inflator.result as Uint8Array;
}

export interface DslConversion {
  name: string;
  entries: Map<string, string[]>;
}

function cleanHeadword(s: string): string {
  return s
    .replace(/\{([^}]*)\}/g, "$1") // {опциональная часть/ударение} — оставить содержимое
    .replace(/\[\/?[^\]]*\]/g, "") // DSL-теги целиком, включая ударение ['] [/']
    .replace(/\\(.)/g, "$1") // снять экранирование
    .replace(/['’´]/g, "")
    .trim()
    .toLowerCase();
}

function cleanBody(s: string): string {
  return s
    .replace(/\{\{[^}]*\}\}/g, "") // {{служебное}}
    .replace(/\{([^}]*)\}/g, "$1") // {ударение/опц} — оставить букву
    .replace(/\[\/?[^\]]*\]/g, "") // все DSL-теги [m1] [i] [c] [p] [ref] ['] …
    .replace(/[[\]]/g, "") // остаточные скобки от вложенных тегов ([тэ] и т.п.)
    .replace(/\\(.)/g, "$1")
    .replace(/~/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function convertDsl(data: ArrayBuffer, type: DslType): DslConversion {
  let bytes = new Uint8Array(data);
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = ungzipCapped(bytes);

  let enc = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) enc = "utf-16le";
  else if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    // эвристика UTF-16LE без BOM: каждый второй байт кириллицы — 0x04 (или 0x00)
    const lim = Math.min(bytes.length, 4000);
    let marks = 0;
    for (let i = 1; i < lim; i += 2) if (bytes[i] === 0x04 || bytes[i] === 0x00) marks++;
    if (marks > lim / 5) enc = "utf-16le";
  }
  let text: string;
  if (enc === "utf-8") {
    // старые Lingvo-словари бывают в windows-1251: кириллица в нём — невалидный
    // UTF-8, поэтому строгий декодер падает и мы переключаемся на 1251
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

  // карточки: заголовки без отступа, тело с отступом
  const entries = new Map<string, string[]>();
  let heads: string[] = [];
  let body: string[] = [];

  const flush = () => {
    if (heads.length && body.length) {
      for (const head of heads) {
        if (!WORD_RE.test(head)) continue; // фразы и латиницу пропускаем

        if (type === "definitions") {
          const glosses: string[] = [];
          for (let g of body) {
            g = g.replace(/[\t|]/g, " ").replace(/;/g, ","); // длину не режем — только структурные разделители
            if (g && !glosses.includes(g)) glosses.push(g);
            if (glosses.length >= MAX_GLOSSES) break;
          }
          if (glosses.length) {
            let arr = entries.get(head);
            if (!arr) entries.set(head, (arr = []));
            if (arr.length < MAX_GROUPS) arr.push(":" + glosses.join(";"));
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

  return { name, entries };
}
