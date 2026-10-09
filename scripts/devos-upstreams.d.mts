export interface UpstreamPin {
  id: string;
  repository: string;
  tag: string;
  commit: string;
  license: string;
  fileCount: number;
  snapshotSha256: string;
  keyFiles?: Record<string, string>;
}
export interface Snapshot {
  fileCount: number;
  snapshotSha256: string;
  hashes: Record<string, string>;
}
export declare function snapshot(root: string): Promise<Snapshot>;
export declare function verifySource(source: UpstreamPin, root: string):
  Promise<{ id: string; commit: string; fileCount: number; snapshotSha256: string }>;
export declare function syncSource(source: UpstreamPin, root: string):
  Promise<{ id: string; commit: string; fileCount: number; snapshotSha256: string }>;
