export const SNAPSHOT_FORMAT = "context-surface.snapshot.v0.1";
export const ANALYSIS_FORMAT = "context-surface.analysis.v0.1";
export const DIFF_FORMAT = "context-surface.diff.v0.1";
export const PRODUCT_VERSION = "0.1.2";

export const LIMITS = Object.freeze({
  maxSnapshotBytes: 512 * 1024,
  maxTools: 128,
  maxMeasurements: 16,
  maxSchemaBytes: 64 * 1024,
  maxSchemaDepth: 32,
  maxSchemaNodes: 20_000,
  maxStringBytes: 64 * 1024,
  minResultBytes: 256,
  defaultResultBytes: 128 * 1024,
  hardMaxResultBytes: 128 * 1024,
  maxHttpBodyBytes: 2200 * 1024,
  maxMcpRequestBytes: 2200 * 1024,
  maxMcpResponseBytes: (128 * 1024) + 1024,
  maxJsonRpcIdBytes: 256,
  maxJsonRpcMethodBytes: 256
});
