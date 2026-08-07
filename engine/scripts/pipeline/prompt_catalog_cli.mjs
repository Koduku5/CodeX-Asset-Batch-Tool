import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  compileLegacyDefinition,
  getApiDefaultTemplates,
  getLegacyDefinitionPath,
  loadPromptCatalog,
  makeCatalogFingerprint,
  resolvePromptTemplate,
  serializeLegacyDefinition,
} from "../lib/prompt_catalog.mjs";
import { makeBuiltinCatalogRouteFingerprint } from "../lib/pipeline_runtime.mjs";

const usage = `Usage:
  prompt_catalog_cli.mjs validate [--catalog PATH]
  prompt_catalog_cli.mjs compile-legacy [--catalog PATH] [--check] [--write [PATH]]
  prompt_catalog_cli.mjs resolve-template --style STYLE --asset ASSET [options]
  prompt_catalog_cli.mjs route-fingerprint --style STYLE --asset ASSET [options]
  prompt_catalog_cli.mjs api-defaults [--catalog PATH] [--legacy-names]

resolve-template options:
  --reference-mode none|style|visual-consistency|custom
  --reference-count NUMBER
  --production-notes TEXT

route-fingerprint options:
  --reference-mode none|style|visual-consistency|custom
  --reference-count NUMBER
`;

const parseArgs = (argv) => {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      options._.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const rawKey = argument.slice(2, equals === -1 ? undefined : equals);
    const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (["check", "legacyNames", "help"].includes(key)) {
      options[key] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }
    if (key === "write" && inlineValue === undefined) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        options.write = true;
      } else {
        options.write = next;
        index += 1;
      }
      continue;
    }
    const value = inlineValue === undefined ? argv[++index] : inlineValue;
    if (value === undefined) throw new Error(`参数 --${rawKey} 缺少值`);
    options[key] = value;
  }
  return options;
};

const writeJson = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0];
  if (!command || options.help) {
    process.stdout.write(usage);
    return;
  }
  const loaded = await loadPromptCatalog(options.catalog);
  if (command === "validate") {
    writeJson({
      valid: true,
      version: loaded.catalog.version,
      baseRouteCount: loaded.builtinRoutes.routes.length,
      catalogFingerprint: makeCatalogFingerprint(loaded),
    });
    return;
  }
  if (command === "compile-legacy") {
    const text = serializeLegacyDefinition(compileLegacyDefinition(loaded));
    const legacyPath = getLegacyDefinitionPath(loaded);
    if (options.check) {
      const existing = await readFile(legacyPath, "utf8");
      if (existing !== text) {
        throw new Error(`编译产物与 legacy definition 不一致：${legacyPath}`);
      }
      writeJson({ valid: true, exact: true, legacyPath });
      return;
    }
    if (options.write) {
      const outputPath = options.write === true ? legacyPath : path.resolve(String(options.write));
      await writeFile(outputPath, text, { encoding: "utf8" });
      writeJson({ written: true, outputPath });
      return;
    }
    process.stdout.write(text);
    return;
  }
  if (command === "resolve-template") {
    if (!options.style || !options.asset) {
      throw new Error("resolve-template 必须提供 --style 与 --asset");
    }
    const result = resolvePromptTemplate(loaded, {
      style: options.style,
      asset: options.asset,
      referenceMode: options.referenceMode ?? "none",
      referenceCount: options.referenceCount ?? 0,
      ...(Object.prototype.hasOwnProperty.call(options, "productionNotes")
        ? { productionNotes: options.productionNotes }
        : {}),
    });
    writeJson(result);
    return;
  }
  if (command === "route-fingerprint") {
    if (!options.style || !options.asset) {
      throw new Error("route-fingerprint 必须提供 --style 与 --asset");
    }
    writeJson({
      catalogFingerprint: makeCatalogFingerprint(loaded),
      routeFingerprint: makeBuiltinCatalogRouteFingerprint(
        options.style,
        options.asset,
        options.referenceMode ?? "none",
        options.referenceCount ?? 0,
        loaded,
      ),
    });
    return;
  }
  if (command === "api-defaults") {
    writeJson(getApiDefaultTemplates(loaded, { legacyNames: options.legacyNames }));
    return;
  }
  throw new Error(`未知命令：${command}\n${usage}`);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
