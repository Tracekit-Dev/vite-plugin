import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import type { Plugin, ResolvedConfig } from "vite";

/**
 * Configuration options for the TraceKit Vite plugin.
 * Matches @tracekit/webpack-plugin option shape for developer familiarity.
 */
export interface TracekitVitePluginOptions {
  /** Auth token for TraceKit API. Falls back to TRACEKIT_AUTH_TOKEN env var. */
  authToken?: string;
  /** TraceKit server URL. Default: "https://app.tracekit.dev" */
  url?: string;
  /** Release version. Auto-detected from package.json if not specified. */
  release?: string;
  /** Fail the build on upload error. Default: false */
  strict?: boolean;
  /** Disable the plugin entirely. Default: false */
  disabled?: boolean;
  /** Suppress console output. Default: false */
  silent?: boolean;
}

/**
 * Injects a debug ID comment into a JavaScript file.
 * Idempotent: skips injection if a debugId comment already exists.
 */
async function injectDebugID(
  filePath: string,
  debugID: string
): Promise<void> {
  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.split("\n");

  // Idempotent: skip if already injected
  if (lines.some((line) => line.includes("//# debugId="))) {
    return;
  }

  const debugIdLine = `//# debugId=${debugID}`;

  // Insert before //# sourceMappingURL= if it exists, otherwise append
  const sourceMappingIndex = lines.findIndex((line) =>
    line.startsWith("//# sourceMappingURL=")
  );

  if (sourceMappingIndex !== -1) {
    lines.splice(sourceMappingIndex, 0, debugIdLine);
  } else {
    lines.push(debugIdLine);
  }

  await fs.writeFile(filePath, lines.join("\n"), "utf-8");
}

/**
 * Injects a debug ID field into a source map JSON file.
 */
async function injectDebugIDIntoMap(
  filePath: string,
  debugID: string
): Promise<void> {
  const content = await fs.readFile(filePath, "utf-8");
  const sourceMap = JSON.parse(content);
  sourceMap.debugId = debugID;
  await fs.writeFile(
    filePath,
    JSON.stringify(sourceMap, null, 2),
    "utf-8"
  );
}

/**
 * Uploads a source map to the TraceKit server via multipart POST.
 */
async function uploadSourceMap(
  url: string,
  authToken: string,
  debugID: string,
  release: string | undefined,
  filename: string,
  data: Buffer
): Promise<void> {
  const formData = new FormData();
  formData.append("debug_id", debugID);
  if (release) {
    formData.append("release", release);
  }
  formData.append(
    "sourcemap",
    new Blob([data.toString("utf-8")], { type: "application/json" }),
    filename
  );

  const response = await fetch(`${url}/api/sourcemaps`, {
    method: "POST",
    headers: {
      "X-API-Key": authToken,
    },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "unknown error");
    throw new Error(
      `Source map upload failed (${response.status}): ${body}`
    );
  }
}

/**
 * Attempts to auto-detect the release version from the nearest package.json.
 */
async function autoDetectRelease(
  rootPath: string
): Promise<string | undefined> {
  try {
    const pkgPath = path.join(rootPath, "package.json");
    const content = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(content);
    return pkg.version || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Recursively finds all files matching an extension in a directory.
 */
async function findFiles(
  dir: string,
  extension: string
): Promise<string[]> {
  const results: string[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await findFiles(fullPath, extension);
        results.push(...nested);
      } else if (entry.name.endsWith(extension)) {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory may not exist or be inaccessible
  }

  return results;
}

/**
 * Creates a Vite plugin that auto-injects debug IDs into build output
 * and uploads source maps to TraceKit during CI builds.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import tracekitVitePlugin from '@tracekit/vite-plugin';
 *
 * export default defineConfig({
 *   build: { sourcemap: true },
 *   plugins: [
 *     tracekitVitePlugin({
 *       // authToken read from TRACEKIT_AUTH_TOKEN env var by default
 *       // url defaults to https://app.tracekit.dev
 *       // release auto-detected from package.json
 *     }),
 *   ],
 * });
 * ```
 */
function tracekitVitePlugin(
  options: TracekitVitePluginOptions = {}
): Plugin {
  let config: ResolvedConfig;

  return {
    name: "tracekit-sourcemaps",
    enforce: "post",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    async writeBundle() {
      // Skip if disabled
      if (options.disabled) {
        return;
      }

      // Skip local builds -- only run in CI
      if (process.env.CI !== "true") {
        return;
      }

      // Resolve auth token
      const authToken =
        process.env.TRACEKIT_AUTH_TOKEN || options.authToken;
      if (!authToken) {
        if (!options.silent) {
          console.warn(
            "[tracekit] No auth token found. Set TRACEKIT_AUTH_TOKEN env var or pass authToken option."
          );
        }
        return;
      }

      // Resolve server URL
      const serverUrl = options.url || "https://app.tracekit.dev";

      // Auto-detect release
      const release =
        options.release || (await autoDetectRelease(config.root));

      // Determine output directory
      const outDir = path.resolve(
        config.root,
        config.build.outDir
      );

      // Find all .js.map files
      const mapFiles = await findFiles(outDir, ".js.map");

      if (mapFiles.length === 0) {
        if (!options.silent) {
          console.log(
            "[tracekit] No source map files found in output."
          );
        }
        return;
      }

      let uploadedCount = 0;

      for (const mapFilePath of mapFiles) {
        // Check that a corresponding .js file exists
        const jsFilePath = mapFilePath.replace(/\.map$/, "");
        try {
          await fs.access(jsFilePath);
        } catch {
          // No corresponding .js file -- skip
          continue;
        }

        try {
          // Generate debug ID
          const debugID = crypto.randomUUID();

          // Inject debug ID into .js and .map files
          await injectDebugID(jsFilePath, debugID);
          await injectDebugIDIntoMap(mapFilePath, debugID);

          // Read modified .map file for upload
          const mapData = await fs.readFile(mapFilePath);
          const filename = path.basename(mapFilePath);
          const fileSizeKB = (mapData.length / 1024).toFixed(1);

          // Upload source map
          await uploadSourceMap(
            serverUrl,
            authToken,
            debugID,
            release,
            filename,
            mapData
          );

          uploadedCount++;

          if (!options.silent) {
            console.log(
              `[tracekit] Uploaded ${filename} (${fileSizeKB} KB)`
            );
          }
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : String(error);

          if (options.strict) {
            throw new Error(`[tracekit] ${message}`);
          } else {
            console.warn(`[tracekit] ${message}`);
          }
        }
      }

      if (!options.silent && uploadedCount > 0) {
        console.log(
          `[tracekit] Uploaded ${uploadedCount} source map${uploadedCount === 1 ? "" : "s"}`
        );
      }
    },
  };
}

export default tracekitVitePlugin;
export { tracekitVitePlugin };
