import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { PRODUCT_VERSION } from "../src/constants.js";

const root = process.cwd();
const pluginRoot = resolve(root, "plugins/context-surface-analyzer");
const skillRoot = resolve(pluginRoot, "skills/analyze-context-surface");
const failures = [];

for (const file of ["LICENSE", "NOTICE"]) {
  try {
    const [source, packaged] = await Promise.all([
      readFile(resolve(root, file), "utf8"),
      readFile(resolve(pluginRoot, file), "utf8")
    ]);
    if (source !== packaged) failures.push(`plugin legal file is stale: ${file}`);
  } catch (error) {
    failures.push(`plugin legal file is missing: ${file}: ${error instanceof Error ? error.message : error}`);
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    failures.push(`${label} is missing or invalid JSON: ${error instanceof Error ? error.message : error}`);
    return {};
  }
}

const packageJson = await readJson(resolve(root, "package.json"), "package manifest");
const manifest = await readJson(resolve(pluginRoot, ".codex-plugin/plugin.json"), "plugin manifest");
const mcp = await readJson(resolve(pluginRoot, ".mcp.json"), "plugin MCP configuration");
const pluginPackage = await readJson(resolve(pluginRoot, "package.json"), "plugin runtime package");
const marketplace = await readJson(resolve(root, ".agents/plugins/marketplace.json"), "repository marketplace");
const marketplaceEntry = marketplace.plugins?.find((plugin) => plugin.name === manifest.name);

if (packageJson.version !== PRODUCT_VERSION) failures.push("package and runtime product versions differ");
if (manifest.name !== basename(pluginRoot)) failures.push("plugin folder and manifest names differ");
if (manifest.version.split("+")[0] !== packageJson.version || pluginPackage.version !== packageJson.version) {
  failures.push("package and plugin base versions must match");
}
if (manifest.skills !== "./skills/") failures.push("plugin Skill path must be ./skills/");
if (manifest.mcpServers !== "./.mcp.json") failures.push("plugin MCP path must be ./.mcp.json");
if (!Array.isArray(manifest.interface?.defaultPrompt) || manifest.interface.defaultPrompt.length === 0) {
  failures.push("plugin manifest must provide starter prompts");
} else if (manifest.interface.defaultPrompt.length > 3) {
  failures.push("plugin manifest supports at most three starter prompts");
}
if (marketplace.name !== manifest.name) failures.push("marketplace and plugin names differ");
if (marketplace.interface?.displayName !== manifest.interface?.displayName) {
  failures.push("marketplace and plugin display names differ");
}
if (marketplaceEntry?.source?.source !== "local" || marketplaceEntry?.source?.path !== "./plugins/context-surface-analyzer") {
  failures.push("marketplace must point at the repository-local plugin");
}
if (marketplaceEntry?.policy?.installation !== "AVAILABLE" || marketplaceEntry?.policy?.authentication !== "ON_INSTALL") {
  failures.push("marketplace installation policy is invalid");
}
if (marketplaceEntry?.category !== manifest.interface?.category) failures.push("marketplace category differs from plugin category");

const server = mcp.mcpServers?.context_surface;
if (server?.command !== "node" || server?.cwd !== "." || server?.args?.[0] !== "./src/mcp-server.js") {
  failures.push("plugin MCP server must run the packaged source entry from the plugin root");
}
if (pluginPackage.type !== "module") failures.push("plugin runtime package must enable ECMAScript modules");

for (const file of ["canonical.js", "constants.js", "contract.js", "core.js", "errors.js", "mcp-server.js"]) {
  try {
    const [source, packaged] = await Promise.all([
      readFile(resolve(root, "src", file), "utf8"),
      readFile(resolve(pluginRoot, "src", file), "utf8")
    ]);
    if (source !== packaged) failures.push(`packaged runtime is stale: ${file}`);
  } catch (error) {
    failures.push(`packaged runtime file is missing: ${file}: ${error instanceof Error ? error.message : error}`);
  }
}

let skill = "";
let skillMetadata = "";
try {
  skill = await readFile(resolve(skillRoot, "SKILL.md"), "utf8");
  skillMetadata = await readFile(resolve(skillRoot, "agents/openai.yaml"), "utf8");
  skill = skill.replace(/\r\n?/g, "\n");
  skillMetadata = skillMetadata.replace(/\r\n?/g, "\n");
} catch (error) {
  failures.push(`plugin Skill is incomplete: ${error instanceof Error ? error.message : error}`);
}
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
const frontmatterKeys = [...frontmatter.matchAll(/^([A-Za-z0-9_-]+):/gm)].map((match) => match[1]);
if (frontmatterKeys.join(",") !== "name,description") failures.push("Skill frontmatter must contain only name and description");
if (!/^name: analyze-context-surface$/m.test(frontmatter)) failures.push("Skill name is invalid");
if (!/^description: .+/m.test(frontmatter) || skill.includes("[TODO:")) failures.push("Skill contains unfinished metadata");
for (const field of ["display_name", "short_description", "default_prompt"]) {
  if (!new RegExp(`^  ${field}: ".+"$`, "m").test(skillMetadata)) failures.push(`Skill UI metadata is missing ${field}`);
}
if (!skillMetadata.includes("$analyze-context-surface")) failures.push("Skill default prompt must mention its invocation name");

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`plugin check failure: ${failure}\n`);
  process.exit(1);
}
process.stdout.write("Portable plugin, packaged runtime, marketplace, and Skill checks passed.\n");
