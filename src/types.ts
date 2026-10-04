export interface DumpRequest {
  /** Motherboard model to look up, e.g. "B450M MORTAR MAX" */
  board: string;
  /** "MSI" | "ASUS" | "GIGABYTE" */
  manufacturer: string;
}

export interface BiosEntry {
  version: string;
  downloadUrl: string;
  /** Filename inside the zip that JOONY.exe should receive */
  fileName: string;
}

export type FetchResult =
  | { ok: true; entry: BiosEntry }
  | { ok: false; reason: string };
