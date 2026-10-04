/**
 * MSI BIOS fetcher.
 *
 * Strategy:
 *   1. Derive a URL slug from the board candidate string.
 *   2. Validate the board exists by hitting the MSI support page.
 *   3. Try the internal JSON API first; fall back to HTML scraping if it fails.
 *   4. Return the latest BIOS zip URL + file name.
 */

import { parse as parseHtml } from "node-html-parser";
import type { BiosEntry, FetchResult } from "../types.js";

const MSI_BASE = "https://www.msi.com";

/** MSI blocks bot-looking UAs with 403 — use a normal browser UA. */
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.msi.com/",
};

/**
 * Convert a board candidate string to an MSI URL slug.
 * e.g. "B450M MORTAR MAX (MS-7B84)" → "B450M-MORTAR-MAX"
 */
export function toMsiSlug(candidate: string): string {
  return candidate
    .replace(/\(.*?\)/g, "") // strip parentheses + content
    .trim()
    .replace(/\s+/g, "-") // spaces → dashes
    .replace(/[^A-Za-z0-9\-]/g, "") // drop anything else
    .replace(/-+/g, "-") // collapse consecutive dashes
    .replace(/^-|-$/g, ""); // trim leading/trailing dashes
}

/**
 * Internal JSON API that MSI support pages use to load BIOS entries.
 * Shape: { result: { downloads: { "AMI BIOS": [{ download_url, download_version, download_release }] } } }
 */
async function fetchViaMsiApi(slug: string): Promise<FetchResult> {
  const apiUrl = `${MSI_BASE}/api/v1/product/support/panel?product=${encodeURIComponent(slug)}&type=bios`;
  try {
    const res = await fetch(apiUrl, {
      headers: {
        ...BROWSER_HEADERS,
        Accept: "application/json, text/plain, */*",
        Referer: `${MSI_BASE}/Motherboard/${slug}/support`,
      },
    });
    if (!res.ok) return { ok: false, reason: `MSI API returned ${res.status}` };
    const data = (await res.json()) as any;

    // Real shape: result.downloads["AMI BIOS"] | result.downloads["BIOS"] | ...
    const downloadsObj = data?.result?.downloads;
    let items: any[] = [];

    if (downloadsObj && typeof downloadsObj === "object" && !Array.isArray(downloadsObj)) {
      // Prefer AMI BIOS, then any other key that looks like BIOS
      const preferred =
        downloadsObj["AMI BIOS"] ??
        downloadsObj["BIOS"] ??
        Object.values(downloadsObj).find((v) => Array.isArray(v) && v.length > 0);
      items = Array.isArray(preferred) ? preferred : [];
    } else {
      // Older/alternate shapes
      items = data?.result ?? data?.data ?? data?.bios ?? data?.files ?? [];
      if (!Array.isArray(items)) items = [];
    }

    if (items.length === 0) {
      return { ok: false, reason: "MSI API returned empty BIOS list" };
    }

    // Sort by release date descending; MSI usually already returns newest first
    const sorted = [...items].sort((a, b) => {
      const da = a.download_release ?? a.releaseDate ?? a.date ?? "";
      const db = b.download_release ?? b.releaseDate ?? b.date ?? "";
      return String(db).localeCompare(String(da));
    });

    const latest = sorted[0];
    const downloadUrl: string =
      latest.download_url ?? latest.downloadUrl ?? latest.url ?? latest.link ?? "";
    const version: string = String(
      latest.download_version ?? latest.version ?? latest.ver ?? "unknown"
    );

    if (!downloadUrl) return { ok: false, reason: "No download URL in MSI API response" };

    const fileName = downloadUrl.split("/").pop() ?? `${slug}-bios.zip`;

    return { ok: true, entry: { version, downloadUrl, fileName } };
  } catch (err) {
    return { ok: false, reason: `MSI API error: ${(err as Error).message}` };
  }
}

/**
 * Fallback: scrape the MSI support page HTML for download.msi.com links ending in .zip.
 * Note: MSI often loads BIOS via JS/API, so this is a last resort.
 */
async function fetchViaScrape(slug: string): Promise<FetchResult> {
  const pageUrl = `${MSI_BASE}/Motherboard/${slug}/support`;
  try {
    const res = await fetch(pageUrl, {
      headers: BROWSER_HEADERS,
    });
    if (!res.ok) return { ok: false, reason: `MSI page returned ${res.status} for slug "${slug}"` };

    const html = await res.text();
    const root = parseHtml(html);

    const zipLinks = root
      .querySelectorAll("a[href]")
      .map((el) => el.getAttribute("href") ?? "")
      .filter(
        (href) =>
          href.includes("download.msi.com") &&
          (href.includes("/msi_files/") || href.includes("/bos_exe/")) &&
          href.endsWith(".zip")
      );

    if (zipLinks.length === 0) {
      return { ok: false, reason: `No BIOS zip links found on MSI page for "${slug}"` };
    }

    const downloadUrl = zipLinks[0].startsWith("http") ? zipLinks[0] : `https:${zipLinks[0]}`;
    const fileName = downloadUrl.split("/").pop() ?? `${slug}-bios.zip`;

    return { ok: true, entry: { version: "unknown", downloadUrl, fileName } };
  } catch (err) {
    return { ok: false, reason: `MSI scrape error: ${(err as Error).message}` };
  }
}

/**
 * Validate that a board exists on MSI's site by GETting the support page.
 * HEAD alone can fail; MSI also 403s non-browser User-Agents.
 */
export async function validateMsiBoard(slug: string): Promise<boolean> {
  try {
    const res = await fetch(`${MSI_BASE}/Motherboard/${slug}/support`, {
      method: "GET",
      redirect: "follow",
      headers: BROWSER_HEADERS,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Main entry point: given a board candidate string, return the latest BIOS entry.
 */
export async function fetchMsiBios(candidate: string): Promise<FetchResult> {
  const slug = toMsiSlug(candidate);
  if (!slug) return { ok: false, reason: "Could not derive MSI slug from candidate" };

  const exists = await validateMsiBoard(slug);
  if (!exists) return { ok: false, reason: `Board not found on MSI site: "${slug}"` };

  const apiResult = await fetchViaMsiApi(slug);
  if (apiResult.ok) return apiResult;

  const failedApi = apiResult as { ok: false; reason: string };
  console.warn(`[MSI] API failed (${failedApi.reason}), trying HTML scrape...`);
  return fetchViaScrape(slug);
}
