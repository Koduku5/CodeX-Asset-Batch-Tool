import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, cleanText, isPlainObject } from "./core.mjs";
import { validatePromptCatalog } from "./validation.mjs";

const DEFAULT_CATALOG_URL = new URL(
  "../../../assets/%E5%9B%BE%E7%89%87%E7%94%9F%E6%88%90/prompts/catalog.json",
  import.meta.url,
);

const asCatalogPath = (value) => {
  if (!value) return fileURLToPath(DEFAULT_CATALOG_URL);
  if (value instanceof URL) return fileURLToPath(value);
  const text = String(value);
  return text.startsWith("file:") ? fileURLToPath(new URL(text)) : path.resolve(text);
};

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));
const readJsonSync = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));

const configuredPaths = (catalog) => [
  catalog.paths.commonFragment,
  ...catalog.paths.styleFragments,
  ...catalog.paths.assetFragments,
  ...catalog.paths.referenceFragments,
  catalog.paths.builtinRoutes,
  catalog.paths.referenceModifiers,
  catalog.paths.conditionModules,
  catalog.paths.apiDefaults,
];

const collectConfiguredFiles = async (catalogPath, catalog) => {
  const rootDir = path.dirname(catalogPath);
  const records = new Map([["catalog.json", catalog]]);
  for (const relativePath of configuredPaths(catalog)) {
    assert(typeof relativePath === "string" && relativePath, "catalog paths 中存在空路径");
    assert(!records.has(relativePath), `catalog paths 重复注册：${relativePath}`);
    records.set(relativePath, await readJson(path.resolve(rootDir, relativePath)));
  }
  return { rootDir, records };
};

const collectConfiguredFilesSync = (catalogPath, catalog) => {
  const rootDir = path.dirname(catalogPath);
  const records = new Map([["catalog.json", catalog]]);
  for (const relativePath of configuredPaths(catalog)) {
    assert(typeof relativePath === "string" && relativePath, "catalog paths 中存在空路径");
    assert(!records.has(relativePath), `catalog paths 重复注册：${relativePath}`);
    records.set(relativePath, readJsonSync(path.resolve(rootDir, relativePath)));
  }
  return { rootDir, records };
};

const assembleLoadedCatalog = (catalogPath, catalog, rootDir, records) => {
  const fragments = new Map();
  const fragmentPaths = [
    catalog.paths.commonFragment,
    ...catalog.paths.styleFragments,
    ...catalog.paths.assetFragments,
    ...catalog.paths.referenceFragments,
  ];
  for (const relativePath of fragmentPaths) {
    const fragment = records.get(relativePath);
    assert(isPlainObject(fragment) && cleanText(fragment.id), `片段缺少 id：${relativePath}`);
    assert(!fragments.has(fragment.id), `片段 id 重复：${fragment.id}`);
    fragments.set(fragment.id, { ...fragment, sourcePath: relativePath });
  }
  const loaded = {
    catalogPath,
    rootDir,
    catalog,
    records,
    fragments,
    builtinRoutes: records.get(catalog.paths.builtinRoutes),
    referenceModifiers: records.get(catalog.paths.referenceModifiers),
    conditionModules: records.get(catalog.paths.conditionModules),
    apiDefaults: records.get(catalog.paths.apiDefaults),
  };
  validatePromptCatalog(loaded);
  return loaded;
};

export const loadPromptCatalog = async (catalogLocation = DEFAULT_CATALOG_URL) => {
  const catalogPath = asCatalogPath(catalogLocation);
  const catalog = await readJson(catalogPath);
  const { rootDir, records } = await collectConfiguredFiles(catalogPath, catalog);
  return assembleLoadedCatalog(catalogPath, catalog, rootDir, records);
};

export const loadPromptCatalogSync = (catalogLocation = DEFAULT_CATALOG_URL) => {
  const catalogPath = asCatalogPath(catalogLocation);
  const catalog = readJsonSync(catalogPath);
  const { rootDir, records } = collectConfiguredFilesSync(catalogPath, catalog);
  return assembleLoadedCatalog(catalogPath, catalog, rootDir, records);
};
