/** fetch the latest ASUS BIOS entry from its support pages */
const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
};
const ASUS_CDN = "https://dlcdnets.asus.com";
/** asus product folders used in support URLs */
const SERIES_FOLDERS = [
    "TUF-Gaming",
    "ROG-STRIX",
    "ROG",
    "PRIME",
    "ProArt",
    "Workstation",
    "Others",
];
/** convert a board name to an ASUS model slug */
export function toAsusSlug(candidate) {
    return candidate
        .replace(/\(.*?\)/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^A-Za-z0-9\-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}
/** add likely ASUS series prefixes to a board slug */
function slugVariants(candidate) {
    const base = toAsusSlug(candidate);
    if (!base)
        return [];
    const upper = base.toUpperCase();
    const variants = new Set([base]);
    // try TUF when GAMING has no series prefix
    if (/^GAMING-/i.test(upper) && !/^TUF-/i.test(upper)) {
        variants.add(`TUF-${base}`);
    }
    // try ROG when STRIX has no series prefix
    if (/^STRIX-/i.test(upper) && !/^ROG-/i.test(upper)) {
        variants.add(`ROG-${base}`);
    }
    // try common series for bare chipset-style names
    if (/^[ABZHWXQ]\d{3,4}/i.test(upper)) {
        for (const prefix of ["PRIME", "TUF-GAMING", "ROG-STRIX", "PROART"]) {
            variants.add(`${prefix}-${base}`);
        }
    }
    return [...variants];
}
/** choose which product folders to try first */
function seriesFoldersForSlug(slug) {
    const u = slug.toUpperCase();
    const preferred = [];
    if (u.includes("TUF"))
        preferred.push("TUF-Gaming");
    if (u.includes("STRIX") || u.startsWith("ROG-STRIX"))
        preferred.push("ROG-STRIX");
    if (u.includes("MAXIMUS") || u.includes("CROSSHAIR") || u.includes("HERO") || u.includes("APEX")) {
        preferred.push("ROG");
    }
    if (u.includes("PRIME"))
        preferred.push("PRIME");
    if (u.includes("PROART"))
        preferred.push("ProArt");
    // try other folders after the preferred ones
    const rest = SERIES_FOLDERS.filter((f) => !preferred.includes(f));
    return [...preferred, ...rest];
}
function resolveDownloadUrl(raw) {
    const decoded = raw.replace(/\\u002F/g, "/").replace(/\\\//g, "/");
    if (decoded.startsWith("http"))
        return decoded;
    if (decoded.startsWith("/"))
        return `${ASUS_CDN}${decoded}`;
    return `${ASUS_CDN}/${decoded}`;
}
/** parse BIOS version and download URL from the support page */
function parseBiosFromHtml(html) {
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
function buildUrls(slug) {
    const lower = slug.toLowerCase();
    const urls = [
        `https://www.asus.com/supportonly/${encodeURIComponent(lower)}/helpdesk_bios?model2Name=${encodeURIComponent(slug)}`,
        `https://www.asus.com/supportonly/${encodeURIComponent(slug)}/HelpDesk_BIOS/`,
    ];
    for (const series of seriesFoldersForSlug(slug)) {
        urls.push(`https://www.asus.com/Motherboards-Components/Motherboards/${series}/${encodeURIComponent(slug)}/HelpDesk_BIOS/`);
    }
    return urls;
}
/** try ASUS support URLs for this board slug */
async function fetchSupportPage(slug) {
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
        }
        catch (err) {
            lastReason = `ASUS page fetch error: ${err.message}`;
        }
    }
    return { ok: false, reason: lastReason };
}
/** find the latest BIOS for a board */
export async function fetchAsusBios(candidate) {
    const variants = slugVariants(candidate);
    if (variants.length === 0) {
        return { ok: false, reason: "Could not derive ASUS slug from candidate" };
    }
    let lastReason = "All ASUS slug variants failed";
    for (const slug of variants) {
        const page = await fetchSupportPage(slug);
        if (page.ok)
            return parseBiosFromHtml(page.html);
        lastReason = page.reason;
    }
    return { ok: false, reason: lastReason };
}
//# sourceMappingURL=asus.js.map