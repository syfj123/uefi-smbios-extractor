/** fetch the latest MSI BIOS entry */

import { parse as parseHtml } from "node-html-parser";
import type { BiosEntry, FetchResult } from "../types.js";

const MSI_BASE = "https://www.msi.com";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** use a browser user agent because MSI may block automated requests */
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.msi.com/",
};

/** convert a board name to an MSI URL slug */
export function toMsiSlug(candidate: string): string {
  return candidate
    .replace(/^MSI[\s-]+/i, "")
    .replace(/\(.*?\)/g, "") // strip parentheses + content
    .trim()
    .replace(/\s+/g, "-") // spaces → dashes
    .replace(/[^A-Za-z0-9\-]/g, "") // drop anything else
    .replace(/-+/g, "-") // collapse consecutive dashes
    .replace(/^-|-$/g, ""); // trim leading/trailing dashes
}

/** Generate common MSI model-name variants without changing the board family. */
export function msiSlugCandidates(candidate: string): string[] {
  const base = toMsiSlug(candidate);
  if (!base) return [];

  const candidates = new Set([base]);
  const withWifi = (slug: string) => (/-WIFI$/i.test(slug) ? slug : `${slug}-WIFI`);
  const withoutMag = base.replace(/^MAG-/i, "");
  const withMag = withoutMag.startsWith("MAG-") ? withoutMag : `MAG-${withoutMag}`;

  candidates.add(withWifi(base));
  candidates.add(withMag);
  candidates.add(withWifi(withMag));
  return [...candidates];
}

/** read BIOS entries from MSI's support API */
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
    const data: unknown = await res.json();
    if (!isRecord(data)) {
      return { ok: false, reason: "MSI API returned an invalid response" };
    }

    // use the current downloads object when present
    const result = data.result;
    const downloadsObj = isRecord(result) ? result.downloads : undefined;
    let items: Record<string, unknown>[] = [];

    if (isRecord(downloadsObj)) {
      // prefer AMI BIOS, then another non-empty BIOS list
      const preferred =
        downloadsObj["AMI BIOS"] ??
        downloadsObj["BIOS"] ??
        Object.values(downloadsObj).find((value) => Array.isArray(value) && value.length > 0);
      items = Array.isArray(preferred) ? preferred.filter(isRecord) : [];
    } else {
      // support older response formats
      const fallback = data.result ?? data.data ?? data.bios ?? data.files;
      items = Array.isArray(fallback) ? fallback.filter(isRecord) : [];
    }

    if (items.length === 0) {
      return { ok: false, reason: "MSI API returned empty BIOS list" };
    }

    // sort by release date, newest first
    const sorted = [...items].sort((a, b) => {
      const da = a.download_release ?? a.releaseDate ?? a.date ?? "";
      const db = b.download_release ?? b.releaseDate ?? b.date ?? "";
      return String(db).localeCompare(String(da));
    });

    const latest = sorted[0];
    const downloadUrl = [
      latest.download_url,
      latest.downloadUrl,
      latest.url,
      latest.link,
    ].find((value): value is string => typeof value === "string") ?? "";
    const version = String(
      latest.download_version ?? latest.version ?? latest.ver ?? "unknown"
    );

    if (!downloadUrl) return { ok: false, reason: "No download URL in MSI API response" };

    const fileName = downloadUrl.split("/").pop() ?? `${slug}-bios.zip`;

    return { ok: true, entry: { version, downloadUrl, fileName } };
  } catch (err) {
    return { ok: false, reason: `MSI API error: ${(err as Error).message}` };
  }
}

/** scrape the support page if the API has no BIOS entry */
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

/** check that the board support page exists */
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

/** find the latest BIOS for a board */
export async function fetchMsiBios(candidate: string): Promise<FetchResult> {
  const slugs = msiSlugCandidates(candidate);
  if (slugs.length === 0) {
    return { ok: false, reason: "Could not derive MSI slug from candidate" };
  }

  const failures: string[] = [];
  for (const slug of slugs) {
    const exists = await validateMsiBoard(slug);
    if (!exists) {
      failures.push(`Board not found: "${slug}"`);
      continue;
    }

    const apiResult = await fetchViaMsiApi(slug);
    if (apiResult.ok === true) {
      return slug === slugs[0]
        ? apiResult
        : { ...apiResult, entry: { ...apiResult.entry, matchedModel: slug } };
    }

    console.warn(`[MSI] API failed for "${slug}" (${apiResult.reason}), trying HTML scrape...`);
    const scrapeResult = await fetchViaScrape(slug);
    if (scrapeResult.ok === true) {
      return slug === slugs[0]
        ? scrapeResult
        : { ...scrapeResult, entry: { ...scrapeResult.entry, matchedModel: slug } };
    }
    failures.push(`"${slug}": ${scrapeResult.reason}`);
  }

  return {
    ok: false,
    reason: `No official MSI BIOS found for "${candidate}". Tried: ${failures.join("; ")}`,
  };
}
