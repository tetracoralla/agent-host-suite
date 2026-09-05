import { LIMITS } from "./constants.js";

export class ContextSurfaceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ContextSurfaceError";
    this.code = code;
    this.details = details;
  }
}

export function errorResult(error) {
  const known = error instanceof ContextSurfaceError;
  return {
    status: "error",
    error: {
      code: known ? error.code : "INTERNAL_ERROR",
      message: known ? error.message : "The operation failed unexpectedly.",
      ...(known && error.details !== undefined ? { details: error.details } : {})
    }
  };
}

export function boundedErrorResult(error, requestedLimit = LIMITS.defaultResultBytes) {
  const limit = Number.isSafeInteger(requestedLimit) &&
    requestedLimit >= LIMITS.minResultBytes &&
    requestedLimit <= LIMITS.hardMaxResultBytes
    ? requestedLimit
    : LIMITS.defaultResultBytes;
  const result = errorResult(error);
  if (Buffer.byteLength(JSON.stringify(result)) <= limit) return result;
  const bounded = errorResult(new ContextSurfaceError(
    "RESULT_BUDGET_EXCEEDED",
    "Serialized error exceeds the output byte limit.",
    { limit }
  ));
  if (Buffer.byteLength(JSON.stringify(bounded)) <= limit) return bounded;
  return {
    status: "error",
    error: { code: "RESULT_BUDGET_EXCEEDED", message: "Output limit is too small." }
  };
}
