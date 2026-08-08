import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveBaseRoute } from "./resolver.mjs";

export const compileLegacyDefinition = (loaded) => {
  const { catalog } = loaded;
  const sheetOrder = catalog.enums.assets.map((asset) => catalog.legacyNames.assets[asset]);
  const styleOrder = catalog.enums.styles.map((style) => catalog.legacyNames.styles[style]);
  const styles = {};
  for (const style of catalog.enums.styles) {
    const styleName = catalog.legacyNames.styles[style];
    const bySheet = {};
    for (const asset of catalog.enums.assets) {
      const assetName = catalog.legacyNames.assets[asset];
      const base = resolveBaseRoute(loaded, style, asset);
      bySheet[assetName] = {
        status: base.status,
        referencePolicy: base.referencePolicy,
        message: base.message,
        promptFields: base.promptFields,
      };
    }
    styles[styleName] = { displayName: styleName, bySheet };
  }
  return {
    version: catalog.legacy.definitionVersion,
    sheetOrder,
    styleOrder,
    fieldOrder: [...catalog.fieldSchemas.withInputImages],
    styles,
  };
};

export const serializeLegacyDefinition = (definition) => {
  const quote = (value) => JSON.stringify(value);
  const lines = [
    "{",
    `  \"version\": ${definition.version},`,
    `  \"sheetOrder\": [${definition.sheetOrder.map(quote).join(", ")}],`,
    `  \"styleOrder\": [${definition.styleOrder.map(quote).join(", ")}],`,
    "  \"fieldOrder\": [",
    ...definition.fieldOrder.map(
      (field, index) => `    ${quote(field)}${index + 1 < definition.fieldOrder.length ? "," : ""}`,
    ),
    "  ],",
    "  \"styles\": {",
  ];
  definition.styleOrder.forEach((styleName, styleIndex) => {
    const style = definition.styles[styleName];
    lines.push(`    ${quote(styleName)}: {`);
    lines.push(`      \"displayName\": ${quote(style.displayName)},`);
    lines.push("      \"bySheet\": {");
    definition.sheetOrder.forEach((sheetName, sheetIndex) => {
      const route = style.bySheet[sheetName];
      lines.push(`        ${quote(sheetName)}: {`);
      lines.push(`          \"status\": ${quote(route.status)},`);
      lines.push(`          \"referencePolicy\": ${quote(route.referencePolicy)},`);
      lines.push(`          \"message\": ${quote(route.message)},`);
      lines.push("          \"promptFields\": [");
      route.promptFields.forEach((field, fieldIndex) => {
        lines.push(
          `            { \"label\": ${quote(field.label)}, \"value\": ${quote(field.value)} }${
            fieldIndex + 1 < route.promptFields.length ? "," : ""
          }`,
        );
      });
      lines.push("          ]");
      lines.push(`        }${sheetIndex + 1 < definition.sheetOrder.length ? "," : ""}`);
    });
    lines.push("      }");
    lines.push(`    }${styleIndex + 1 < definition.styleOrder.length ? "," : ""}`);
  });
  lines.push("  }");
  lines.push("}");
  return `${lines.join("\n")}\n`;
};

export const getApiDefaultTemplates = (loaded, { legacyNames = false } = {}) => {
  const templates = loaded.apiDefaults.templates;
  if (!legacyNames) return { ...templates };
  return Object.fromEntries(
    loaded.catalog.enums.assets.map((asset) => [loaded.catalog.legacyNames.assets[asset], templates[asset]]),
  );
};

export const getLegacyDefinitionPath = (loaded) =>
  path.resolve(loaded.rootDir, loaded.catalog.legacy.definitionPath);

export const getCatalogUrl = (loaded) => pathToFileURL(loaded.catalogPath);
