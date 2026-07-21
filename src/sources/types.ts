export type SourceSpec =
  | { kind: "local"; path: string }
  | { kind: "git"; url: string };

export interface SerializedObjectIdentity {
  dev: string;
  ino: string;
}

export interface SourceStageRecovery {
  version: 2;
  id: string;
  tempRoot: string;
  container: string;
  marker: string;
  payload: string;
  isolatedPayload: string;
  tempRootIdentity: SerializedObjectIdentity;
  containerIdentity: SerializedObjectIdentity;
  payloadIdentity: SerializedObjectIdentity;
  markerIdentity: SerializedObjectIdentity;
  source: SourceSpec;
}

export interface StagedSource {
  root: string;
  rootEntryName: string;
  sourceStage: SourceStageRecovery;
  cleanup(): Promise<void>;
}

export interface ProcessRunner {
  run(command: string, args: string[]): Promise<void>;
}
