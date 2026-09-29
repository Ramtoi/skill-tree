// The visual harness is plain ESM (visual/*.mjs) imported by
// src/test/visualProof.test.ts. It has no types on purpose; these scoped
// declarations keep `tsc` happy without a build step for a test-only import.
declare module "*/visual/capture.mjs";
declare module "*/visual/config.mjs";
declare module "*/visual/proof-lib.mjs";
