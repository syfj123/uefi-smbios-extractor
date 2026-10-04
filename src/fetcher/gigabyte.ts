/**
 * Gigabyte BIOS fetcher.
 *
 * Newer Gigabyte BIOS zips use a product-code midsegment that cannot be
 * guessed:
 *   mb_bios_{slug}_{productCode}_{version}.zip
 *   e.g. mb_bios_x870-aorus-infinity_8agnr018_f2b.zip
 *
 * Older boards still use the simple form:
 *   mb_bios_{slug}_{version}.zip
 *
 * Strategy:
 *   1. Derive a product-page slug from the candidate.
 *   2. Fetch the Motherboard support page (SSR embeds BIOS CDN links).
 *   3. Parse the newest BIOS zip URL from the HTML.
 *   4. Fall back to a simple CDN version scan for older boards that still
 *      use the mb_bios_{slug}_{ver}.zip pattern.
 */

import type { BiosEntry, FetchResult } from "../types.js";

const CDN_BASE = "https://download.gigabyte.com/FileList/BIOS";
const VERSION_CEILING = 90;
const SUB_LETTERS = ["e", "d", "c", "b", "a"];
const CONCURRENCY = 16;

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.gigabyte.com/",
};

/**
 * Convert a board candidate to a Gigabyte slug (lowercase, dash-separated).
 * Examples:
 *   "B450M DS3H"            → "b450m-ds3h"
 *   "X870 AORUS INFINITY"   → "x870-aorus-infinity"
 *   "X570 Gaming X (rev. 1.0)" → "x570-gaming-x"
 */
export function toGigabyteSlug(candidate: string): string {
  return candidate
    .replace(/\([^)]*\)/g, "")        // complete parentheticals: (Rev. 1.0)
    .replace(/\s*\([^)]*$/, "")       // unclosed trailing fragment: (Rev.
    .replace(/\brev\.?\s*[\d.x]+\b/gi, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Product-page slug — Gigabyte URLs use UPPERCASE segments. */
function toPageSlug(slug: string): string {
  return slug.toUpperCase();
}

function stripQuery(url: string): string {
  return url.split("?")[0] ?? url;
}

function entryFromUrl(downloadUrl: string): BiosEntry {
  const clean = stripQuery(downloadUrl);
  const fileName = clean.split("/").pop() ?? "gigabyte-bios.zip";
  // Prefer version token after the last underscore: ..._f2b.zip / ..._f64.zip
  const verMatch = fileName.match(/_([fF]\d+[a-zA-Z]?)\.zip$/i);
  const version = verMatch?.[1]?.toUpperCase() ?? "unknown";
  return { version, downloadUrl: clean, fileName };
}

/**
 * Parse BIOS CDN links from a Gigabyte support page HTML body.
 * Page order is newest-first.
 */
function parseBiosFromHtml(html: string): BiosEntry | null {
  const links = [
    ...html.matchAll(
      /https?:\/\/download\.gigabyte\.com\/FileList\/BIOS\/[^\s"'<>]+/gi
    ),
  ].map((m) => stripQuery(m[0]));

  const unique = [...new Set(links)].filter((u) => /\.zip$/i.test(u));
  if (unique.length === 0) return null;
  return entryFromUrl(unique[0]);
}

async function fetchSupportPage(slug: string): Promise<BiosEntry | null> {
  const pageSlug = toPageSlug(slug);
  const urls = [
    `https://www.gigabyte.com/Motherboard/${pageSlug}/support`,
    `https://www.gigabyte.com/Motherboard/${pageSlug}-rev-10/support`,
    `https://www.gigabyte.com/Motherboard/${pageSlug}-rev-1x/support`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
      if (!res.ok) continue;
      const html = await res.text();
      const entry = parseBiosFromHtml(html);
      if (entry) return entry;
    } catch {
      // try next URL
    }
  }
  return null;
}

async function exists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: HEADERS,
      redirect: "follow",
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Fallback for older boards: mb_bios_{slug}_{ver}.zip */
async function scanSimpleCdn(slug: string): Promise<BiosEntry | null> {
  const candidates: string[] = [];
  for (let n = VERSION_CEILING; n >= 1; n--) {
    for (const letter of SUB_LETTERS) candidates.push(`f${n}${letter}`);
    candidates.push(`f${n}`);
  }

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (ver) => {
        const url = `${CDN_BASE}/mb_bios_${slug}_${ver}.zip`;
        return (await exists(url)) ? { ver, url } : null;
      })
    );
    const hit = results.find((r) => r !== null);
    if (hit) return entryFromUrl(hit.url);
  }
  return null;
}

/**
 * Main entry point: given a board candidate string, return the latest BIOS entry.
 */
export async function fetchGigabyteBios(candidate: string): Promise<FetchResult> {
  const slug = toGigabyteSlug(candidate);
  if (!slug) {
    return { ok: false, reason: "Could not derive Gigabyte slug from candidate" };
  }

  // Prefer support-page scrape (handles product-code midsegment on new boards)
  const fromPage = await fetchSupportPage(slug);
  if (fromPage) return { ok: true, entry: fromPage };

  console.warn(
    `[Gigabyte] Support page had no BIOS links for "${slug}", falling back to CDN scan...`
  );
  const fromCdn = await scanSimpleCdn(slug);
  if (fromCdn) return { ok: true, entry: fromCdn };

  return {
    ok: false,
    reason: `No BIOS found for Gigabyte slug "${slug}" (support page + CDN scan failed)`,
  };
}
