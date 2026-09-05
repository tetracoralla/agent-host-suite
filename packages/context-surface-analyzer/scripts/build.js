import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const pluginRoot = "plugins/context-surface-analyzer";
const pluginManifest = JSON.parse(await readFile(`${pluginRoot}/.codex-plugin/plugin.json`, "utf8"));
if (pluginManifest.version.split("+")[0] !== packageJson.version) {
  throw new Error("Plugin base version and package version must match before build.");
}

const runtimeFiles = [
  "canonical.js",
  "constants.js",
  "contract.js",
  "core.js",
  "errors.js",
  "mcp-server.js"
];
await rm(`${pluginRoot}/src`, { recursive: true, force: true });
await mkdir(`${pluginRoot}/src`, { recursive: true });
for (const file of runtimeFiles) await cp(`src/${file}`, `${pluginRoot}/src/${file}`);
await writeFile(
  `${pluginRoot}/package.json`,
  `${JSON.stringify({
    name: "@openadam/context-surface-analyzer-plugin-runtime",
    version: packageJson.version,
    private: true,
    type: "module",
    engines: packageJson.engines
  }, null, 2)}\n`,
  "utf8"
);
for (const file of ["LICENSE", "NOTICE"]) await cp(file, `${pluginRoot}/${file}`);

const target = "dist";
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const directory of ["src", "web", "docs", "examples", "scripts", "test", "plugins", ".agents"]) {
  await cp(directory, `${target}/${directory}`, { recursive: true });
}
for (const file of ["README.md", "AGENTS.md", "LICENSE", "NOTICE", "SECURITY.md", "package.json", "package-lock.json", ".gitignore"]) {
  await cp(file, `${target}/${file}`);
}
const builtPackageJson = JSON.parse(await readFile(`${target}/package.json`, "utf8"));
builtPackageJson.private = true;
await writeFile(`${target}/package.json`, `${JSON.stringify(builtPackageJson, null, 2)}\n`, "utf8");
process.stdout.write("Built source distribution and synchronized the portable Codex plugin runtime.\n");
