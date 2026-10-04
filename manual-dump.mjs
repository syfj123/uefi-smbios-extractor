/*
 * run extractor.exe on a local firmware file
 *
 * usage:
 *   node manual-dump.mjs <firmware-file> [candidate-name]
 *
 * examples:
 *   node manual-dump.mjs E7D98IMS.BI0
 *   node manual-dump.mjs ./tmp/E7D98IMS.BI0 "MSI MAG B550M MORTAR"
 *
 * - <firmware-file>: firmware file path
 * - [candidate-name]: optional board name; defaults to the filename
 *
 * environment variables:
 *   WINE_EXEC            path to wine binary
 *   WINEPREFIX           wine prefix directory
 *   WINEARCH             wine architecture
 */

import "dotenv/config";
import { spawn } from "child_process";
import { existsSync, mkdirSync, rmSync, cpSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_WINE = process.platform !== "win32";
const WINE_EXEC = process.env.WINE_EXEC ?? "wine";
const WINE_PREFIX = process.env.WINEPREFIX ?? path.join(__dirname, ".wine-joony");

function resolveExtractorExe() {
  const local = path.join(__dirname, "extractor.exe");
  if (existsSync(local)) return local;
  return path.resolve(__dirname, "../smbiosauto/extractor.exe");
}
const EXTRACTOR_EXE = resolveExtractorExe();

const TMP_DIR = path.join(__dirname, "tmp");

const [, , rawFilePath, rawCandidate] = process.argv;

if (!rawFilePath) {
  console.error("Usage: node manual-dump.mjs <firmware-file> [candidate-name]");
  console.error("  e.g. node manual-dump.mjs E7D98IMS.BI0");
  console.error("  e.g. node manual-dump.mjs ./E7D98IMS.BI0 \"MSI MAG B550M MORTAR\"");
  process.exit(1);
}

const firmwareInput = path.resolve(rawFilePath);
const fileBasename = path.basename(firmwareInput);
const candidate = (rawCandidate ?? path.parse(fileBasename).name).trim();

/** convert an absolute Linux path to Wine's Z: drive path */
function toWinePath(linuxPath) {
  return "Z:" + linuxPath.replace(/\//g, "\\");
}

function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

/** stage the firmware in tmp */
function stageFirmware() {
  ensureTmpDir();
  const dest = path.join(TMP_DIR, fileBasename);
  cpSync(firmwareInput, dest, { force: true });
  return dest;
}

/** run extractor.exe and return its JSON result */
function spawnExtractor(firmwarePath) {
  return new Promise((resolve, reject) => {
    if (!existsSync(EXTRACTOR_EXE)) {
      reject(new Error(`extractor.exe not found at: ${EXTRACTOR_EXE}`));
      return;
    }

    const extractorArg = IS_WINE ? toWinePath(firmwarePath) : firmwarePath;
    const [cmd, args] = IS_WINE
      ? [WINE_EXEC, [EXTRACTOR_EXE, extractorArg]]
      : [EXTRACTOR_EXE, [extractorArg]];

    console.log(
      `[manual-dump] Spawning: ${IS_WINE ? "wine " : ""}extractor.exe ${fileBasename}` +
        (IS_WINE ? ` (prefix: ${WINE_PREFIX})` : ""),
    );

    const proc = spawn(cmd, args, {
      cwd: path.dirname(firmwarePath),
      stdio: "pipe",
      env: {
        ...process.env,
        ...(IS_WINE
          ? {
              WINEPREFIX: WINE_PREFIX,
              WINEARCH: process.env.WINEARCH ?? "win64",
              ...(process.env.WINEDEBUG ? {} : { WINEDEBUG: "-all" }),
            }
          : {}),
      },
      ...(IS_WINE ? {} : { windowsHide: true }),
    });

    let lastJsonResult = null;
    let stdoutBuffer = "";

    const parseJsonLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") lastJsonResult = parsed;
      } catch {
        // ignore non-JSON output
      }
    };

    proc.stdout.on("data", (d) => {
      const text = d.toString();
      process.stdout.write(`[extractor] ${text}`);
      const lines = (stdoutBuffer + text).split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) parseJsonLine(line);
    });

    proc.stderr.on("data", (d) => process.stderr.write(`[extractor:err] ${d.toString()}`));
    proc.on("close", (code) => {
      parseJsonLine(stdoutBuffer);
      resolve({ exitCode: code ?? 1, jsonResult: lastJsonResult });
    });
    proc.on("error", reject);
  });
}

async function main() {
  console.log(`[manual-dump] File:      ${firmwareInput}`);
  console.log(`[manual-dump] Candidate: ${candidate}`);
  console.log();

  if (!existsSync(firmwareInput)) {
    console.error(`[manual-dump] File not found: ${firmwareInput}`);
    process.exit(1);
  }

  // run extractor.exe from a clean working directory
  const stagedPath = stageFirmware();
  console.log(`[manual-dump] Staged to: ${stagedPath}`);

  let exitCode = 1;
  let jsonResult = null;

  try {
    ({ exitCode, jsonResult } = await spawnExtractor(stagedPath));
    console.log(`\n[manual-dump] extractor.exe exited with code ${exitCode}`);
  } finally {
    // remove the staged copy
    try {
      if (existsSync(stagedPath)) rmSync(stagedPath, { force: true });
    } catch {
      // continue if cleanup fails
    }
  }

  if (!jsonResult || jsonResult.ok === false) {
    console.error("[manual-dump] extractor.exe produced no usable JSON output.");
    process.exit(exitCode === 0 ? 1 : exitCode);
  }

  console.log("[manual-dump] extractor JSON result:");
  console.log(JSON.stringify(jsonResult, null, 2));
  console.log("\n[manual-dump] Done.");
}

main().catch((err) => {
  console.error("[manual-dump] Fatal:", err.message);
  process.exit(1);
});
