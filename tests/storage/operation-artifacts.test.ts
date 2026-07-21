import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  operationArtifactPaths,
  type OperationArtifactRole,
} from "../../src/storage/operation-artifacts.js";
import type { TransactionItem } from "../../src/storage/types.js";

const item: TransactionItem = {
  id: "item/with/path-separators",
  agent: "claude",
  entryName: "pdf",
  entryKind: "directory",
  operation: "move",
  source: "/home/user/active/../active/pdf",
  destination: "/home/user/parked/pdf",
};

describe("operation artifact identity", () => {
  it("derives stable opaque role containers from normalized absolute item paths", () => {
    const roles: OperationArtifactRole[] = [
      "destination-temp",
      "source-quarantine",
      "destination-quarantine",
    ];
    const first = roles.map((role) => operationArtifactPaths(item, role));
    const second = roles.map((role) => operationArtifactPaths(item, role));

    expect(first).toEqual(second);
    expect(new Set(first.map(({ container }) => container)).size).toBe(3);
    for (const [index, paths] of first.entries()) {
      const role = roles[index];
      const anchor =
        role === "source-quarantine" ? item.source : item.destination;
      expect(dirname(paths.container)).toBe(dirname(resolve(anchor)));
      expect(paths.container).toMatch(
        new RegExp(`\\.skillpark-operation-[a-f0-9]{64}-${role}$`),
      );
      expect(paths.container).not.toContain(item.id);
      expect(paths.marker).toBe(join(paths.container, "owner.json"));
      expect(paths.payload).toBe(join(paths.container, "payload"));
    }
  });
});
