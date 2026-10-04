/**
 * Manual single-file dump utility.
 *
 * Usage:
 *   node manual-dump.mjs <firmware-file> [candidate-name]
 *
 * Examples:
 *   node manual-dump.mjs E7D98IMS.BI0
 *   node manual-dump.mjs ./tmp/E7D98IMS.BI0 "MSI MAG B550M MORTAR"
 *
 * - <firmware-file>   Path to the firmware file on disk (required).
 * - [candidate-name]  Board name stored in the DB (optional).
 *                     Defaults to the filename without extension.
 *
 * Env vars (from .env or shell):
 *   BACKEND_URL          Where the backend API lives (default: http://localhost:4000)
 *   AUTODUMP_SECRET      Shared secret for x-autodump-secret header
 *   SMBIOS_DUMP_WEBHOOK_URL  Discord webhook to notify on success
 *   WINE_EXEC            Path to wine binary (default: wine)
 *   WINEPREFIX           Wine prefix directory (default: .wine-joony next to this file)
 *   WINEARCH             Wine architecture (default: win64)
 */

import "dotenv/config";
import { spawn } from "child_process";
import { existsSync, mkdirSync, rmSync, cpSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BACKEND_URL = (process.env.BACKEND_URL ?? "http://localhost:4000").replace(/\/$/, "");
const SECRET = process.env.AUTODUMP_SECRET ?? "";
const DUMP_WEBHOOK_URL = process.env.SMBIOS_DUMP_WEBHOOK_URL ?? "";

const IS_WINE = process.platform !== "win32";
const WINE_EXEC = process.env.WINE_EXEC ?? "wine";
const WINE_PREFIX = process.env.WINEPREFIX ?? path.join(__dirname, ".wine-joony");

function resolveJoonyExe() {
  const local = path.join(__dirname, "JOONY.exe");
  if (existsSync(local)) return local;
  return path.resolve(__dirname, "../smbiosauto/JOONY.exe");
}
const JOONY_EXE = resolveJoonyExe();

const TMP_DIR = path.join(__dirname, "tmp");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert an absolute Linux path to a Wine Z: drive path. */
function toWinePath(linuxPath) {
  return "Z:" + linuxPath.replace(/\//g, "\\");
}

function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

/** Copy firmware into tmp so we run JOONY.exe from a clean directory. */
function stageFirmware() {
  ensureTmpDir();
  const dest = path.join(TMP_DIR, fileBasename);
  cpSync(firmwareInput, dest, { force: true });
  return dest;
}

/** Spawn JOONY.exe (via Wine on Linux) and return the JSON result. */
function spawnJoony(firmwarePath) {
  return new Promise((resolve, reject) => {
    if (!existsSync(JOONY_EXE)) {
      reject(new Error(`JOONY.exe not found at: ${JOONY_EXE}`));
      return;
    }

    const joonyArg = IS_WINE ? toWinePath(firmwarePath) : firmwarePath;
    const [cmd, args] = IS_WINE
      ? [WINE_EXEC, [JOONY_EXE, joonyArg]]
      : [JOONY_EXE, [joonyArg]];

    console.log(
      `[manual-dump] Spawning: ${IS_WINE ? "wine " : ""}JOONY.exe ${fileBasename}` +
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

    proc.stdout.on("data", (d) => {
      const text = d.toString();
      process.stdout.write(`[JOONY] ${text}`);
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object") lastJsonResult = parsed;
        } catch {
          // not JSON
        }
      }
    });

    proc.stderr.on("data", (d) => process.stderr.write(`[JOONY:err] ${d.toString()}`));
    proc.on("close", (code) => resolve({ exitCode: code ?? 0, jsonResult: lastJsonResult }));
    proc.on("error", reject);
  });
}

/** POST the template to the backend. Returns true if saved, false if duplicate/failed. */
async function saveToBackend(template) {
  const url = `${BACKEND_URL}/api/smbios/autodump`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(SECRET ? { "x-autodump-secret": SECRET } : {}),
    },
    body: JSON.stringify({ candidate, template }),
  });

  if (res.status === 409) {
    console.log(`[manual-dump] "${candidate}" already exists in DB — not overwriting.`);
    return false;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Backend returned HTTP ${res.status}: ${body}`);
  }
  console.log(`[manual-dump] Template saved to DB for "${candidate}".`);
  return true;
}

/** POST a success notification to the dump Discord webhook. */
async function notifyWebhook() {
  if (!DUMP_WEBHOOK_URL) return;
  const body = {
    embeds: [
      {
        title: "New SMBIOS Dump (manual)",
        color: 0xfa5020,
        fields: [
          { name: "Board", value: `\`${candidate}\``, inline: true },
          { name: "Source", value: `\`${fileBasename}\``, inline: true },
          { name: "Status", value: "Template saved", inline: true },
        ],
        footer: { text: "JOONY | SOFTWARE - SMBIOS Manual Dump" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
  const res = await fetch(DUMP_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.warn(`[manual-dump] Webhook failed (HTTP ${res.status})`);
  } else {
    console.log(`[manual-dump] Dump webhook posted.`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[manual-dump] File:      ${firmwareInput}`);
  console.log(`[manual-dump] Candidate: ${candidate}`);
  console.log(`[manual-dump] Backend:   ${BACKEND_URL}`);
  console.log();

  if (!existsSync(firmwareInput)) {
    console.error(`[manual-dump] File not found: ${firmwareInput}`);
    process.exit(1);
  }

  // Stage firmware into tmp so JOONY.exe has a predictable working directory.
  const stagedPath = stageFirmware();
  console.log(`[manual-dump] Staged to: ${stagedPath}`);

  let exitCode = 1;
  let jsonResult = null;

  try {
    ({ exitCode, jsonResult } = await spawnJoony(stagedPath));
    console.log(`\n[manual-dump] JOONY.exe exited with code ${exitCode}`);
  } finally {
    // Clean up staged copy regardless of outcome.
    try {
      if (existsSync(stagedPath)) rmSync(stagedPath, { force: true });
    } catch {
      // non-fatal
    }
  }

  if (!jsonResult || jsonResult.ok === false) {
    console.error("[manual-dump] JOONY.exe produced no usable JSON output. Nothing was saved.");
    process.exit(exitCode === 0 ? 1 : exitCode);
  }

  try {
    const saved = await saveToBackend(jsonResult);
    if (saved) await notifyWebhook().catch((err) => console.warn(`[manual-dump] Webhook error: ${err.message}`));
  } catch (err) {
    console.error(`[manual-dump] Failed to save to backend: ${err.message}`);
    process.exit(1);
  }

  console.log("\n[manual-dump] Done.");
}

main().catch((err) => {
  console.error("[manual-dump] Fatal:", err.message);
  process.exit(1);
});
