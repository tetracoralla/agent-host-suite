import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import process from "node:process";

const directories = ["src", "web", "scripts", "test"];
const files = [];
for (const directory of directories) {
  for (const name of await readdir(directory)) {
    if (name.endsWith(".js")) files.push(`${directory}/${name}`);
  }
}

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}
process.stdout.write(`Checked ${files.length} JavaScript files.\n`);
