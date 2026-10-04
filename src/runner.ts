/**
 * Runner: download BIOS zip → extract firmware file → spawn JOONY.exe
 *         → print JOONY's JSON result locally
 */

import AdmZip from "adm-zip";
import chalk from "chalk";
import { spawn } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import type { BiosEntry } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// __dirname is Autodump/dist at runtime → Autodump root is one level up
const AUTODUMP_ROOT = path.resolve(__dirname, "..");
const TMP_DIR = path.join(AUTODUMP_ROOT, "tmp");

/** Prefer JOONY.exe next to Autodump; fall back to ../smbiosauto for local Windows layouts. */
function resolveJoonyExe(): string {
  const local = path.join(AUTODUMP_ROOT, "JOONY.exe");
  if (existsSync(local)) return local;
  return path.resolve(AUTODUMP_ROOT, "../smbiosauto/JOONY.exe");
}
const JOONY_EXE = resolveJoonyExe();

/**
 * Whether to wrap JOONY.exe in Wine.
 * Auto-detected: true on any non-Windows host.
 * Override via WINE_EXEC env var (path to wine binary, defaults to "wine").
 * WINEPREFIX defaults to Autodump/.wine-joony (override with WINEPREFIX=).
 */
const IS_WINE = process.platform !== "win32";
const WINE_EXEC = process.env.WINE_EXEC ?? "wine";
const WINE_PREFIX = process.env.WINEPREFIX || path.join(AUTODUMP_ROOT, ".wine-joony");

/**
 * Convert an absolute Linux path to a Wine Z: drive path.
 * Wine maps the host root (/) to Z:\ by default.
 * e.g. /home/user/tmp/bios.ROM → Z:\home\user\tmp\bios.ROM
 */
function toWinePath(linuxPath: string): string {
  return "Z:" + linuxPath.replace(/\//g, "\\");
}

/** File extensions that are valid BIOS firmware images. */
const FIRMWARE_EXTS = new Set([
  "ROM", "CAP", "BIN", "FD", "WPH", "BIO",
]);

function isFirmwareFile(name: string): boolean {
  const ext = path.extname(name).replace(".", "").toUpperCase();
  if (!ext) return false;
  if (["EXE", "PDF", "TXT", "BAT", "CMD", "INF", "XML", "JSON", "ZIP", "7Z"].includes(ext)) return false;
  if (FIRMWARE_EXTS.has(ext)) return true;
  // MSI-style versioned extension: 2-4 uppercase letters/digits (e.g. A90, H60, 190)
  if (/^[A-Z0-9]{2,4}$/.test(ext)) return true;
  return false;
}

function ensureTmpDir(): void {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

function refererForUrl(url: string): string {
  if (url.includes("asus.com") || url.includes("dlcdnets.asus.com") || url.includes("dlcdnet.asus.com")) {
    return "https://www.asus.com/support/";
  }
  if (url.includes("msi.com") || url.includes("download.msi.com")) {
    return "https://www.msi.com/";
  }
  if (url.includes("gigabyte.com")) {
    return "https://www.gigabyte.com/";
  }
  return "https://www.google.com/";
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/zip,application/octet-stream,*/*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: refererForUrl(url),
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "cross-site",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} from ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buffer);
}

interface SpawnResult {
  exitCode: number;
  /** Last line from stdout that parsed as valid JSON, or null if none. */
  jsonResult: Record<string, unknown> | null;
}

function spawnJoony(firmwarePath: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    if (!existsSync(JOONY_EXE)) {
      reject(new Error(`JOONY.exe not found at: ${JOONY_EXE}`));
      return;
    }

    const fileName = path.basename(firmwarePath);

    // On Linux we run: wine /abs/path/JOONY.exe Z:\abs\path\firmware.ROM
    // On Windows we run: /abs/path/JOONY.exe /abs/path/firmware.ROM
    const joonyArg = IS_WINE ? toWinePath(firmwarePath) : firmwarePath;
    const [cmd, args] = IS_WINE
      ? [WINE_EXEC, [JOONY_EXE, joonyArg]]
      : [JOONY_EXE, [joonyArg]];

    console.log(
      chalk.cyan(
        `[Runner] Spawning: ${IS_WINE ? `wine ` : ""}JOONY.exe ${fileName}` +
          (IS_WINE ? ` (prefix: ${WINE_PREFIX})` : "")
      )
    );

    const proc = spawn(cmd, args, {
      cwd: path.dirname(firmwarePath),
      stdio: "pipe",
      env: {
        ...process.env,
        ...(IS_WINE
          ? {
              WINEPREFIX: WINE_PREFIX,
              WINEARCH: process.env.WINEARCH || "win64",
              // Suppress Wine debug noise unless caller explicitly sets WINEDEBUG
              ...(process.env.WINEDEBUG ? {} : { WINEDEBUG: "-all" }),
            }
          : {}),
      },
      // windowsHide is Windows-only; omit on Linux to avoid spawn errors
      ...(IS_WINE ? {} : { windowsHide: true }),
    });

    let lastJsonResult: Record<string, unknown> | null = null;

    proc.stdout.on("data", (d: Buffer) => {
      const text = d.toString();
      process.stdout.write(chalk.gray(`[JOONY] ${text}`));
      // Scan each line for the JSON result payload
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object") {
            lastJsonResult = parsed as Record<string, unknown>;
          }
        } catch {
          // not JSON, ignore
        }
      }
    });

    proc.stderr.on("data", (d: Buffer) =>
      process.stderr.write(chalk.yellow(`[JOONY:err] ${d.toString()}`))
    );

    proc.on("close", (code) => resolve({ exitCode: code ?? 0, jsonResult: lastJsonResult }));
    proc.on("error", reject);
  });
}

export interface RunResult {
  ok: boolean;
  reason?: string;
  exitCode?: number;
  firmwareFile?: string;
}

/**
 * POST the AMIDE template to the backend API to save it in smbios_amide_templates.
 */
/**
 * Full pipeline: download zip → extract firmware → run JOONY.exe →
 *                print the result locally → cleanup.
 */
export async function runDump(
  board: string,
  entry: BiosEntry
): Promise<RunResult> {
  ensureTmpDir();

  const safePrefix = board.replace(/[^A-Za-z0-9\-_]/g, "_").slice(0, 40);
  const zipPath = path.join(TMP_DIR, `${safePrefix}-bios.zip`);
  const extractDir = path.join(TMP_DIR, `${safePrefix}-extracted`);

  try {
    // 1. Download
    console.log(chalk.blue(`[Runner] Downloading BIOS zip: ${entry.downloadUrl}`));
    await downloadFile(entry.downloadUrl, zipPath);
    console.log(chalk.green(`[Runner] Download complete: ${entry.fileName} (v${entry.version})`));

    // 2. Extract
    if (!existsSync(extractDir)) mkdirSync(extractDir, { recursive: true });
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);

    // 3. Find firmware file
    const entries = zip.getEntries();
    const firmwareEntry = entries.find((e) => !e.isDirectory && isFirmwareFile(e.name));

    if (!firmwareEntry) {
      const names = entries.map((e) => e.name).join(", ");
      return { ok: false, reason: `No firmware file found in zip. Contents: ${names}` };
    }

    const firmwarePath = path.join(extractDir, firmwareEntry.entryName);
    console.log(chalk.green(`[Runner] Found firmware: ${firmwareEntry.name}`));

    // 4. Spawn JOONY.exe, capture JSON result
    const { exitCode, jsonResult } = await spawnJoony(firmwarePath);
    console.log(chalk.green(`[Runner] JOONY.exe exited with code ${exitCode}`));

    // 5. Show JOONY's output in the local demo console instead of persisting it remotely.
    if (jsonResult) {
      console.log(chalk.cyan("[Runner] JOONY JSON result:"));
      console.log(JSON.stringify(jsonResult, null, 2));
    } else if (exitCode === 0) {
      console.warn(chalk.yellow("[Runner] JOONY.exe exited 0 but emitted no JSON result."));
    } else {
      console.error(chalk.red("[Runner] JOONY.exe did not produce a JSON result."));
    }

    return {
      ok: exitCode === 0 && jsonResult?.ok !== false,
      exitCode,
      firmwareFile: firmwareEntry.name,
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    // 6. Cleanup tmp files regardless of outcome
    for (const p of [zipPath, extractDir]) {
      try {
        if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      } catch {
        // non-fatal
      }
    }
  }
}
