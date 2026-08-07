import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

export const loadArtifactTool = async () => {
  const moduleRoots = [
    process.env.CODEX_NODE_MODULES,
    ...(process.env.NODE_PATH?.split(path.delimiter) ?? []),
    path.join(
      os.homedir(),
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "node",
      "node_modules",
    ),
  ].filter(Boolean);

  const candidates = [undefined, ...moduleRoots];
  const failures = [];
  for (const moduleRoot of candidates) {
    let entry;
    try {
      entry = moduleRoot
        ? require.resolve("@oai/artifact-tool", { paths: [moduleRoot] })
        : require.resolve("@oai/artifact-tool");
    } catch (error) {
      if (error?.code === "MODULE_NOT_FOUND") continue;
      throw error;
    }
    try {
      return await import(pathToFileURL(entry).href);
    } catch (error) {
      failures.push(`${entry}: ${error?.message ?? error}`);
    }
  }

  throw new Error(
    failures.length
      ? `找到但无法加载 @oai/artifact-tool：${failures.join(" | ")}`
      : "找不到 @oai/artifact-tool。请使用 Codex 工作区运行时，或通过 CODEX_NODE_MODULES 指定 node_modules。",
  );
};
