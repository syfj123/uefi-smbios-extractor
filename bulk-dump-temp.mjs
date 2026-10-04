/**
 * TEMP one-shot: queue supported boards from Discord backlog into Autodump.
 * Skips ASRock / Biostar. Delete this file when done.
 *
 * Usage (Autodump must already be running):
 *   node bulk-dump-temp.mjs
 *
 * Optional delay between queues (ms):  DELAY_MS=5000 node bulk-dump-temp.mjs
 */
import "dotenv/config";

const PORT = process.env.AUTODUMP_PORT ?? "4567";
const SECRET = process.env.AUTODUMP_SECRET ?? "";
// Dummy channel — Discord notify may 404; that's fine for bulk backfill
const CHANNEL_ID = process.env.BULK_DUMP_CHANNEL_ID ?? "0";
// Short delay — Autodump now has a serial queue, so overlaps are impossible
const DELAY_MS = Number(process.env.DELAY_MS ?? 500);

/** Deduped MSI / ASUS / GIGABYTE only */
const BOARDS = [
  { candidate: "B850MPOWER", manufacturer: "MSI" },
  { candidate: "MAG B365M MORTAR", manufacturer: "MSI" },
  { candidate: "Z790 UD AC", manufacturer: "GIGABYTE" },
  { candidate: "B450M DS3H WIFI", manufacturer: "GIGABYTE" },
  { candidate: "PRIME H610M-K D4", manufacturer: "ASUS" },
  { candidate: "TUF B360M-PLUS GAMING", manufacturer: "ASUS" },
  { candidate: "Z790 AORUS ELITE AX", manufacturer: "GIGABYTE" },
  { candidate: "B760M DS3H WIFI6E GEN5", manufacturer: "GIGABYTE" },
  { candidate: "Z790 EAGLE AX", manufacturer: "GIGABYTE" },
  { candidate: "PRO Z790-P WIFI", manufacturer: "MSI" },
  { candidate: "B450M DS3H", manufacturer: "GIGABYTE" },
  { candidate: "TUF GAMING X570-PLUS WI-FI", manufacturer: "ASUS" },
  { candidate: "Z790 GAMING PLUS WIFI", manufacturer: "MSI" },
  { candidate: "Z790 GAMING WIFI7", manufacturer: "ASUS" },
  { candidate: "TUF GAMING B850-E WIFI", manufacturer: "ASUS" },
  { candidate: "B550 EAGLE WIFI6", manufacturer: "GIGABYTE" },
  { candidate: "B550 DS3H AC", manufacturer: "GIGABYTE" },
  { candidate: "PRO B550M VC WIFI", manufacturer: "MSI" },
  // Skipped: ASRock B850M Pro RS WiFi, B550 Steel Legend, B860M-C
  // Skipped: Biostar A520MT
  // Skipped vague: "GIGABYTE AORUS PRIME 5" (incomplete model)
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function queueOne(board, index, total) {
  const label = `[${index + 1}/${total}] ${board.manufacturer} ${board.candidate}`;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/dump`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(SECRET ? { "x-autodump-secret": SECRET } : {}),
      },
      body: JSON.stringify({
        candidate: board.candidate,
        manufacturer: board.manufacturer,
        channelId: CHANNEL_ID,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 202) {
      console.log(`✓ queued  ${label}`, body);
    } else {
      console.error(`✗ reject  ${label} HTTP ${res.status}`, body);
    }
  } catch (err) {
    console.error(`✗ fail    ${label}:`, err.message);
    console.error("  Is Autodump running? (npm start in Autodump/)");
  }
}

async function main() {
  console.log(`Bulk dump: ${BOARDS.length} boards → http://127.0.0.1:${PORT}/dump`);
  console.log(`Delay between queues: ${DELAY_MS}ms\n`);

  for (let i = 0; i < BOARDS.length; i++) {
    await queueOne(BOARDS[i], i, BOARDS.length);
    if (i < BOARDS.length - 1) await sleep(DELAY_MS);
  }

  console.log("\nAll requests queued. Watch the Autodump terminal for progress.");
  console.log("Delete this file when finished: Autodump/bulk-dump-temp.mjs");
}

main();
