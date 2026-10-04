import "dotenv/config";
import chalk from "chalk";
import express from "express";
import { fetchAsusBios } from "./fetcher/asus.js";
import { fetchGigabyteBios } from "./fetcher/gigabyte.js";
import { fetchMsiBios } from "./fetcher/msi.js";
import { runDump } from "./runner.js";
const app = express();
app.use(express.json());
const PORT = Number(process.env.AUTODUMP_PORT ?? 4567);
const MANUFACTURERS = new Set(["MSI", "ASUS", "GIGABYTE"]);
/* ── Serial queue ─────────────────────────────────────────────────────────────
 * All dump jobs run one at a time. Incoming requests are accepted immediately
 * (202) and appended to the queue. A single async loop drains them in order.
 */
const dumpQueue = [];
let queueRunning = false;
function enqueue(req) {
    dumpQueue.push(req);
    console.log(chalk.gray(`[Queue] Enqueued "${req.board}" — queue length: ${dumpQueue.length}`));
    if (!queueRunning)
        drainQueue();
}
async function drainQueue() {
    if (queueRunning)
        return;
    queueRunning = true;
    while (dumpQueue.length > 0) {
        const job = dumpQueue.shift();
        try {
            await processDump(job);
        }
        catch (err) {
            console.error(chalk.red("[Queue] Unhandled error in processDump:"), err);
        }
    }
    queueRunning = false;
    console.log(chalk.gray("[Queue] All jobs done."));
}
/* ── /health ── */
app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        uptime: process.uptime(),
        queue: { length: dumpQueue.length, running: queueRunning },
    });
});
/* ── /dump ── */
app.post("/dump", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (!body.board || typeof body.board !== "string") {
        res.status(400).json({ ok: false, reason: "Missing or invalid 'board'" });
        return;
    }
    if (!body.manufacturer || typeof body.manufacturer !== "string") {
        res.status(400).json({ ok: false, reason: "Missing or invalid 'manufacturer'" });
        return;
    }
    const board = body.board.trim();
    const manufacturer = body.manufacturer.toUpperCase().trim();
    if (!board) {
        res.status(400).json({ ok: false, reason: "Missing or invalid 'board'" });
        return;
    }
    if (!MANUFACTURERS.has(manufacturer)) {
        res.status(400).json({
            ok: false,
            reason: "Unsupported manufacturer. Use MSI, ASUS, or GIGABYTE.",
        });
        return;
    }
    const job = {
        board,
        manufacturer,
    };
    enqueue(job);
    res.status(202).json({ ok: true, queued: job.board, position: dumpQueue.length });
});
async function processDump(req) {
    console.log(chalk.blueBright(`\n[Autodump] Starting dump for: "${req.board}" (${req.manufacturer})`));
    // 1. Fetch BIOS entry from manufacturer
    let fetchResult;
    if (req.manufacturer === "MSI") {
        fetchResult = await fetchMsiBios(req.board);
    }
    else if (req.manufacturer === "ASUS") {
        fetchResult = await fetchAsusBios(req.board);
    }
    else if (req.manufacturer === "GIGABYTE") {
        fetchResult = await fetchGigabyteBios(req.board);
    }
    else {
        console.warn(chalk.yellow(`[Autodump] Unsupported manufacturer: ${req.manufacturer}`));
        return;
    }
    if (!fetchResult.ok) {
        console.error(chalk.red(`[Autodump] BIOS fetch failed: ${fetchResult.reason}`));
        return;
    }
    const { entry } = fetchResult;
    console.log(chalk.green(`[Autodump] Found BIOS v${entry.version}: ${entry.downloadUrl}`));
    // 2. Download, extract, run JOONY.exe
    const result = await runDump(req.board, entry);
    if (result.ok) {
        console.log(chalk.greenBright(`[Autodump] Done! Firmware: ${result.firmwareFile} | Exit code: ${result.exitCode}`));
    }
    else {
        console.error(chalk.red(`[Autodump] Run failed: ${result.reason}`));
    }
}
app.listen(PORT, "127.0.0.1", () => {
    console.log(chalk.greenBright(`[Autodump] Listening on http://127.0.0.1:${PORT}`));
    console.log(chalk.gray(`  POST /dump   — trigger a BIOS autodump`));
    console.log(chalk.gray(`  GET  /health — check listener status`));
    const isWine = process.platform !== "win32";
    if (isWine) {
        const wineExec = process.env.WINE_EXEC ?? "wine";
        const winePrefix = process.env.WINEPREFIX || "Autodump/.wine-joony";
        console.log(chalk.yellow(`  [Wine mode]  JOONY.exe via: ${wineExec}`));
        console.log(chalk.gray(`               WINEPREFIX=${winePrefix}`));
        console.log(chalk.gray(`               JOONY.exe expected next to package.json`));
    }
});
//# sourceMappingURL=server.js.map