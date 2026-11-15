// G-C2: no src/*.ts above 600 lines; files already above have a per-file cap in ci/size-ratchet.json (may only go down).
import { readdirSync, readFileSync } from "node:fs";
const caps: Record<string, number> = JSON.parse(readFileSync("ci/size-ratchet.json", "utf8"));
const fails: string[] = [];
for (const name of readdirSync("src").filter((f) => f.endsWith(".ts"))) {
  const path = `src/${name}`;
  const n = readFileSync(path, "utf8").split("\n").length - 1;
  const cap = caps[path] ?? 600;
  if (n > cap) fails.push(`${path}: ${n} lines > cap ${cap}`);
  else if (caps[path] !== undefined && n < cap) fails.push(`${path}: ${n} lines < cap ${cap} — lower ci/size-ratchet.json`);
}
if (fails.length) { console.error("size ratchet FAIL\n" + fails.join("\n")); process.exit(1); }
console.log("size ratchet ok");
