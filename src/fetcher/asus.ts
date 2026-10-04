/**
 * ASUS BIOS fetcher.
 *
 * ASUS's GetPDBIOS JSON API is unreliable / often returns FAIL for motherboards.
 * The official support page SSR-embeds BIOS entries, including DownloadUrl paths.
 *
 * Strategy:
 *   1. Derive model slug(s) from candidate (keeps series: TUF/ROG/PRIME/PROART)
 *   2. Fetch supportonly HelpDesk_BIOS page, then series product pages
 *   3. Parse Version + DownloadUrl.Global from embedded page data
 *   4. Resolve relative /pub/... paths against dlcdnets.asus.com
 */

import type { BiosEntry, FetchResult } from "../types.js";

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const ASUS_CDN = "https://dlcdnets.asus.com";

/** ASUS product-line folder names used in motherboard support URLs. */
const SERIES_FOLDERS = [
  "TUF-Gaming",
  "ROG-STRIX",
  "ROG",
  "PRIME",
  "ProArt",
  "Workstation",
  "Others",
] as const;

/**
 * Convert a board candidate to an ASUS model slug.
 * e.g. "TUF GAMING B650M-PLUS WIFI" → "TUF-GAMING-B650M-PLUS-WIFI"
 */
export function toAsusSlug(candidate: string): string {
  return candidate
    .replace(/\(.*?\)/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Build slug variants — detector may drop series prefixes ("GAMING B860M..."
 * instead of "TUF GAMING B860M..."), so we expand likely ASUS names.
 */
function slugVariants(candidate: string): string[] {
  const base = toAsusSlug(candidate);
  if (!base) return [];

  const upper = base.toUpperCase();
  const variants = new Set<string>([base]);

  // "GAMING-B860M-..." without TUF → try TUF-GAMING-...
  if (/^GAMING-/i.test(upper) && !/^TUF-/i.test(upper)) {
    variants.add(`TUF-${base}`);
  }

  // "STRIX-..." without ROG → try ROG-STRIX-...
  if (/^STRIX-/i.test(upper) && !/^ROG-/i.test(upper)) {
    variants.add(`ROG-${base}`);
  }

  // "B550M-A-WIFI" bare chipset-style — try common series prefixes
  if (/^[ABZHWXQ]\d{3,4}/i.test(upper)) {
    for (const prefix of ["PRIME", "TUF-GAMING", "ROG-STRIX", "PROART"]) {
      variants.add(`${prefix}-${base}`);
    }
  }

  return [...variants];
}

/** Infer which product-line folders to try for a slug. */
function seriesFoldersForSlug(slug: string): string[] {
  const u = slug.toUpperCase();
  const preferred: string[] = [];

  if (u.includes("TUF")) preferred.push("TUF-Gaming");
  if (u.includes("STRIX") || u.startsWith("ROG-STRIX")) preferred.push("ROG-STRIX");
  if (u.includes("MAXIMUS") || u.includes("CROSSHAIR") || u.includes("HERO") || u.includes("APEX")) {
    preferred.push("ROG");
  }
  if (u.includes("PRIME")) preferred.push("PRIME");
  if (u.includes("PROART")) preferred.push("ProArt");

  // Always fall through remaining folders after preferred ones
  const rest = SERIES_FOLDERS.filter((f) => !preferred.includes(f));
  return [...preferred, ...rest];
}

function resolveDownloadUrl(raw: string): string {
  const decoded = raw.replace(/\\u002F/g, "/").replace(/\\\//g, "/");
  if (decoded.startsWith("http")) return decoded;
  if (decoded.startsWith("/")) return `${ASUS_CDN}${decoded}`;
  return `${ASUS_CDN}/${decoded}`;
}

/**
 * Parse BIOS entries embedded in ASUS HelpDesk_BIOS SSR HTML.
 * Matches patterns like:
 *   Version:"3641"
 *   DownloadUrl:{Global:"\u002Fpub\u002FASUS\u002Fmb\u002FBIOS\u002F....zip"
 */
function parseBiosFromHtml(html: string): FetchResult {
  const versions = [...html.matchAll(/Version:"([^"]+)"/g)].map((m) => m[1]);
  const downloads = [
    ...html.matchAll(/DownloadUrl:\{Global:"([^"]+)"/g),
  ].map((m) => m[1]);

  if (downloads.length === 0) {
    return { ok: false, reason: "No BIOS DownloadUrl found in ASUS support page" };
  }

  const rawUrl = downloads[0];
  const version = versions[0] ?? "unknown";
  const downloadUrl = resolveDownloadUrl(rawUrl);
  const fileName = downloadUrl.split("/").pop() ?? "asus-bios.zip";

  return { ok: true, entry: { version, downloadUrl, fileName } };
}

function buildUrls(slug: string): string[] {
  const lower = slug.toLowerCase();
  const urls = [
    `https://www.asus.com/supportonly/${encodeURIComponent(lower)}/helpdesk_bios?model2Name=${encodeURIComponent(slug)}`,
    `https://www.asus.com/supportonly/${encodeURIComponent(slug)}/HelpDesk_BIOS/`,
  ];

  for (const series of seriesFoldersForSlug(slug)) {
    urls.push(
      `https://www.asus.com/Motherboards-Components/Motherboards/${series}/${encodeURIComponent(slug)}/HelpDesk_BIOS/`
    );
  }

  return urls;
}

/**
 * Fetch the ASUS HelpDesk_BIOS page for a model slug (tries series-aware URLs).
 */
async function fetchSupportPage(
  slug: string
): Promise<{ ok: true; html: string } | { ok: false; reason: string }> {
  let lastReason = "All ASUS support page URLs failed";

  for (const url of buildUrls(slug)) {
    try {
      const res = await fetch(url, {
        headers: BROWSER_HEADERS,
        redirect: "follow",
      });
      if (!res.ok) {
        lastReason = `ASUS page returned ${res.status} for ${url}`;
        continue;
      }
      const html = await res.text();
      if (!html.includes("DownloadUrl") && !/Version:"\d+"/i.test(html)) {
        lastReason = `ASUS page loaded but had no BIOS data (${url})`;
        continue;
      }
      return { ok: true, html };
    } catch (err) {
      lastReason = `ASUS page fetch error: ${(err as Error).message}`;
    }
  }

  return { ok: false, reason: lastReason };
}

/**
 * Main entry point: given a board candidate string, return the latest BIOS entry.
 */
export async function fetchAsusBios(candidate: string): Promise<FetchResult> {
  const variants = slugVariants(candidate);
  if (variants.length === 0) {
    return { ok: false, reason: "Could not derive ASUS slug from candidate" };
  }

  let lastReason = "All ASUS slug variants failed";

  for (const slug of variants) {
    const page = await fetchSupportPage(slug);
    if (page.ok) return parseBiosFromHtml(page.html);
    lastReason = (page as { ok: false; reason: string }).reason;
  }

  return { ok: false, reason: lastReason };
}
