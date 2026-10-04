/** fetch the latest Gigabyte BIOS entry */
const CDN_BASE = "https://download.gigabyte.com/FileList/BIOS";
const VERSION_CEILING = 90;
const SUB_LETTERS = ["e", "d", "c", "b", "a"];
const CONCURRENCY = 16;
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://www.gigabyte.com/",
};
/** convert a board name to a lowercase Gigabyte URL slug */
export function toGigabyteSlug(candidate) {
    return candidate
        .replace(/\([^)]*\)/g, "") // complete parentheticals: (Rev. 1.0)
        .replace(/\s*\([^)]*$/, "") // unclosed trailing fragment: (Rev.
        .replace(/\brev\.?\s*[\d.x]+\b/gi, "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}
/** convert the slug to Gigabyte's uppercase page format */
function toPageSlug(slug) {
    return slug.toUpperCase();
}
function stripQuery(url) {
    return url.split("?")[0] ?? url;
}
function entryFromUrl(downloadUrl) {
    const clean = stripQuery(downloadUrl);
    const fileName = clean.split("/").pop() ?? "gigabyte-bios.zip";
    // read the version suffix, such as f2b or f64
    const verMatch = fileName.match(/_([fF]\d+[a-zA-Z]?)\.zip$/i);
    const version = verMatch?.[1]?.toUpperCase() ?? "unknown";
    return { version, downloadUrl: clean, fileName };
}
/** read the newest BIOS zip link from the support page */
function parseBiosFromHtml(html) {
    const links = [
        ...html.matchAll(/https?:\/\/download\.gigabyte\.com\/FileList\/BIOS\/[^\s"'<>]+/gi),
    ].map((m) => stripQuery(m[0]));
    const unique = [...new Set(links)].filter((u) => /\.zip$/i.test(u));
    if (unique.length === 0)
        return null;
    return entryFromUrl(unique[0]);
}
async function fetchSupportPage(slug) {
    const pageSlug = toPageSlug(slug);
    const urls = [
        `https://www.gigabyte.com/Motherboard/${pageSlug}/support`,
        `https://www.gigabyte.com/Motherboard/${pageSlug}-rev-10/support`,
        `https://www.gigabyte.com/Motherboard/${pageSlug}-rev-1x/support`,
    ];
    for (const url of urls) {
        try {
            const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
            if (!res.ok)
                continue;
            const html = await res.text();
            const entry = parseBiosFromHtml(html);
            if (entry)
                return entry;
        }
        catch {
            // try the next support URL
        }
    }
    return null;
}
async function exists(url) {
    try {
        const res = await fetch(url, {
            method: "HEAD",
            headers: HEADERS,
            redirect: "follow",
        });
        return res.status === 200;
    }
    catch {
        return false;
    }
}
/** scan the CDN for older BIOS filename formats */
async function scanSimpleCdn(slug) {
    const candidates = [];
    for (let n = VERSION_CEILING; n >= 1; n--) {
        for (const letter of SUB_LETTERS)
            candidates.push(`f${n}${letter}`);
        candidates.push(`f${n}`);
    }
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
        const batch = candidates.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map(async (ver) => {
            const url = `${CDN_BASE}/mb_bios_${slug}_${ver}.zip`;
            return (await exists(url)) ? { ver, url } : null;
        }));
        const hit = results.find((r) => r !== null);
        if (hit)
            return entryFromUrl(hit.url);
    }
    return null;
}
/** find the latest BIOS for a board */
export async function fetchGigabyteBios(candidate) {
    const slug = toGigabyteSlug(candidate);
    if (!slug) {
        return { ok: false, reason: "Could not derive Gigabyte slug from candidate" };
    }
    // use the support page first for newer filename formats
    const fromPage = await fetchSupportPage(slug);
    if (fromPage)
        return { ok: true, entry: fromPage };
    console.warn(`[Gigabyte] Support page had no BIOS links for "${slug}", falling back to CDN scan...`);
    const fromCdn = await scanSimpleCdn(slug);
    if (fromCdn)
        return { ok: true, entry: fromCdn };
    return {
        ok: false,
        reason: `No BIOS found for Gigabyte slug "${slug}" (support page + CDN scan failed)`,
    };
}
//# sourceMappingURL=gigabyte.js.map