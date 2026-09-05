import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const required = ["LICENSE", "NOTICE", "README.md", "SECURITY.md", "package.json", "package-lock.json", "plugins/context-surface-analyzer/LICENSE", "plugins/context-surface-analyzer/NOTICE"];
for (const name of required) {
  const info = await lstat(join(root, name));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`missing or unsafe public file: ${name}`);
}
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (
  packageJson.license !== "Apache-2.0" ||
  packageJson.repository?.url !== "https://github.com/tetracoralla/agent-host-suite.git" ||
  packageJson.repository?.directory !== "packages/context-surface-analyzer"
) {
  throw new Error("Agent Host package metadata is incomplete");
}
async function inventory(directory) {
  const values = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`public source contains a symlink: ${relative(root, path)}`);
    if (entry.isDirectory()) values.push(...await inventory(path));
    else values.push(path);
  }
  return values;
}
const forbidden = ["/Users/" + "openadam", "BEGIN " + "PRIVATE KEY", "figd_" + "UY5", "gho_" + "p"];
const secretPatterns = [
  new RegExp("gh" + "[pousr]_[A-Za-z0-9_]{20,}", "u"),
  new RegExp("AKIA" + "[0-9A-Z]{16}", "u"),
  new RegExp("sk-" + "[A-Za-z0-9]{20,}", "u")
];
for (const path of await inventory(root)) {
  if (!/\.(?:md|mjs|json|yml|yaml|txt)$/u.test(path)) continue;
  const text = await readFile(path, "utf8");
  for (const value of forbidden) if (text.includes(value)) throw new Error(`${relative(root, path)} contains forbidden public material`);
  for (const pattern of secretPatterns) if (pattern.test(text)) throw new Error(`${relative(root, path)} contains credential-shaped public material`);
}
console.log("Agent Host Context Surface package source checks passed");
