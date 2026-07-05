// Манифест файлов словаря для скачивания плагином (dict/files.json).
// Перечисляет ТОЛЬКО открытые *.txt.gz (без личных local-*) + их размеры.
// Запускать после любой пересборки словаря; затем tools/upload-dict.sh.
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT = join(HERE, "..", "dict");

const files = readdirSync(DICT)
  .filter((n) => n.endsWith(".txt.gz") && !n.startsWith("local-"))
  .map((n) => ({ name: n, size: statSync(join(DICT, n)).size }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));

let version = "";
try {
  version = JSON.parse(readFileSync(join(DICT, "meta.json"), "utf8")).built || "";
} catch {
  /* meta.json не обязателен */
}

const total = files.reduce((s, f) => s + f.size, 0);
writeFileSync(join(DICT, "files.json"), JSON.stringify({ version, total, files }, null, 0));
console.error(`files.json: ${files.length} файлов, ${(total / 1048576).toFixed(1)} МБ`);
