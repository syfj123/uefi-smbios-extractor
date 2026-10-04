export interface DumpRequest {
  /** motherboard model, e.g. "B450M MORTAR MAX" */
  board: string;
  /** supported manufacturer */
  manufacturer: string;
}

export interface BiosEntry {
  version: string;
  downloadUrl: string;
  /** firmware filename inside the zip */
  fileName: string;
}

export type FetchResult =
  | { ok: true; entry: BiosEntry }
  | { ok: false; reason: string };
