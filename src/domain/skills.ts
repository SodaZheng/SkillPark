export type EntryKind = "directory" | "link";
export type ScanMode = "active" | "parked";

export interface SkillMetadata {
  name: string;
  description: string;
  search?: {
    keywords: string[];
  };
  valid: boolean;
  warnings: string[];
}

export interface SkillEntry {
  entryName: string;
  path: string;
  kind: EntryKind;
  broken: boolean;
  metadata: SkillMetadata;
}
