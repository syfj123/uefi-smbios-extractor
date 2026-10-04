/** downloads BIOS, runs extractor.exe, and prints its JSON result */
import AdmZip from "adm-zip";
import chalk from "chalk";
import { spawn } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// resolve the project root from dist/
const AUTODUMP_ROOT = path.resolve(__dirname, "..");
const TMP_DIR = path.join(AUTODUMP_ROOT, "tmp");
/** find extractor.exe beside the project or in the legacy sibling folder */
function resolveExtractorExe() {
    const local = path.join(AUTODUMP_ROOT, "extractor.exe");
    if (existsSync(local))
        return local;
    return path.resolve(AUTODUMP_ROOT, "../smbiosauto/extractor.exe");
}
const EXTRACTOR_EXE = resolveExtractorExe();
// use Wine off Windows; WINE_EXEC and WINEPREFIX can override its defaults
const IS_WINE = process.platform !== "win32";
const WINE_EXEC = process.env.WINE_EXEC ?? "wine";
const WINE_PREFIX = process.env.WINEPREFIX || path.join(AUTODUMP_ROOT, ".wine-joony");
/** convert an absolute Linux path to Wine's Z: drive path */
function toWinePath(linuxPath) {
    return "Z:" + linuxPath.replace(/\//g, "\\");
}
/** bios firmware extensions */
const FIRMWARE_EXTS = new Set([
    "ROM", "CAP", "BIN", "FD", "WPH", "BIO",
]);
function isFirmwareFile(name) {
    const ext = path.extname(name).replace(".", "").toUpperCase();
    if (!ext)
        return false;
    if (["EXE", "PDF", "TXT", "BAT", "CMD", "INF", "XML", "JSON", "ZIP", "7Z"].includes(ext))
        return false;
    if (FIRMWARE_EXTS.has(ext))
        return true;
    // accept MSI-style version extensions such as A90 and H60
    if (/^[A-Z0-9]{2,4}$/.test(ext))
        return true;
    return false;
}
function ensureTmpDir() {
    if (!existsSync(TMP_DIR))
        mkdirSync(TMP_DIR, { recursive: true });
}
function refererForUrl(url) {
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
async function downloadFile(url, destPath) {
    const res = await fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            Accept: "application/zip,application/octet-stream,*/*",
            "Accept-Language": "en-US,en;q=0.9",
            Referer: refererForUrl(url),
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "cross-site",
        },
        redirect: "follow",
    });
    if (!res.ok)
        throw new Error(`Download failed: HTTP ${res.status} from ${url}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(destPath, buffer);
}
function spawnExtractor(firmwarePath) {
    return new Promise((resolve, reject) => {
        if (!existsSync(EXTRACTOR_EXE)) {
            reject(new Error(`extractor.exe not found at: ${EXTRACTOR_EXE}`));
            return;
        }
        const fileName = path.basename(firmwarePath);
        // wine needs a Z: path; Windows uses the native firmware path
        const extractorArg = IS_WINE ? toWinePath(firmwarePath) : firmwarePath;
        const [cmd, args] = IS_WINE
            ? [WINE_EXEC, [EXTRACTOR_EXE, extractorArg]]
            : [EXTRACTOR_EXE, [extractorArg]];
        console.log(chalk.cyan(`[Runner] Spawning: ${IS_WINE ? `wine ` : ""}extractor.exe ${fileName}` +
            (IS_WINE ? ` (prefix: ${WINE_PREFIX})` : "")));
        const proc = spawn(cmd, args, {
            cwd: path.dirname(firmwarePath),
            stdio: "pipe",
            env: {
                ...process.env,
                ...(IS_WINE
                    ? {
                        WINEPREFIX: WINE_PREFIX,
                        WINEARCH: process.env.WINEARCH || "win64",
                        // suppress Wine logs unless WINEDEBUG is set
                        ...(process.env.WINEDEBUG ? {} : { WINEDEBUG: "-all" }),
                    }
                    : {}),
            },
            // windowsHide is only supported on Windows
            ...(IS_WINE ? {} : { windowsHide: true }),
        });
        let lastJsonResult = null;
        let stdoutBuffer = "";
        const parseJsonLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith("{"))
                return;
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed && typeof parsed === "object") {
                    lastJsonResult = parsed;
                }
            }
            catch {
                // ignore non-JSON output
            }
        };
        proc.stdout.on("data", (d) => {
            const text = d.toString();
            process.stdout.write(chalk.gray(`[extractor] ${text}`));
            const lines = (stdoutBuffer + text).split(/\r?\n/);
            stdoutBuffer = lines.pop() ?? "";
            for (const line of lines)
                parseJsonLine(line);
        });
        proc.stderr.on("data", (d) => process.stderr.write(chalk.yellow(`[extractor:err] ${d.toString()}`)));
        proc.on("close", (code) => {
            parseJsonLine(stdoutBuffer);
            resolve({ exitCode: code ?? 1, jsonResult: lastJsonResult });
        });
        proc.on("error", reject);
    });
}
/** download BIOS, run extractor.exe, print its result, and clean up */
export async function runDump(board, entry) {
    ensureTmpDir();
    const safePrefix = board.replace(/[^A-Za-z0-9\-_]/g, "_").slice(0, 40);
    const zipPath = path.join(TMP_DIR, `${safePrefix}-bios.zip`);
    const extractDir = path.join(TMP_DIR, `${safePrefix}-extracted`);
    try {
        // download the BIOS archive
        console.log(chalk.blue(`[Runner] Downloading BIOS zip: ${entry.downloadUrl}`));
        await downloadFile(entry.downloadUrl, zipPath);
        console.log(chalk.green(`[Runner] Download complete: ${entry.fileName} (v${entry.version})`));
        // extract the archive
        if (!existsSync(extractDir))
            mkdirSync(extractDir, { recursive: true });
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractDir, true);
        // find the firmware image
        const entries = zip.getEntries();
        const firmwareEntry = entries.find((e) => !e.isDirectory && isFirmwareFile(e.name));
        if (!firmwareEntry) {
            const names = entries.map((e) => e.name).join(", ");
            return { ok: false, reason: `No firmware file found in zip. Contents: ${names}` };
        }
        const firmwarePath = path.join(extractDir, firmwareEntry.entryName);
        console.log(chalk.green(`[Runner] Found firmware: ${firmwareEntry.name}`));
        // run extractor.exe and capture its JSON output
        const { exitCode, jsonResult } = await spawnExtractor(firmwarePath);
        console.log(chalk.green(`[Runner] extractor.exe exited with code ${exitCode}`));
        // print the result locally
        if (jsonResult) {
            console.log(chalk.cyan("[Runner] extractor JSON result:"));
            console.log(JSON.stringify(jsonResult, null, 2));
        }
        else if (exitCode === 0) {
            console.warn(chalk.yellow("[Runner] extractor.exe exited 0 but emitted no JSON result."));
        }
        else {
            console.error(chalk.red("[Runner] extractor.exe did not produce a JSON result."));
        }
        return {
            ok: exitCode === 0 && jsonResult?.ok !== false,
            exitCode,
            firmwareFile: firmwareEntry.name,
        };
    }
    catch (err) {
        return { ok: false, reason: err.message };
    }
    finally {
        // remove temporary files
        for (const p of [zipPath, extractDir]) {
            try {
                if (existsSync(p))
                    rmSync(p, { recursive: true, force: true });
            }
            catch {
                // continue if cleanup fails
            }
        }
    }
}
//# sourceMappingURL=runner.js.map