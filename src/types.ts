export interface DumpRequest {
  /** Raw detected phrase from the message, e.g. "B450M MORTAR MAX" */
  candidate: string;
  /** "MSI" | "ASUS" | "GIGABYTE" */
  manufacturer: string;
  /** Discord channel ID to send the completion message to */
  channelId: string;
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
