export class ObserverError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ObserverError";
    this.code = code;
    this.details = details;
  }
}

export function stableErrorCode(error, fallback = "PROVIDER_READ_FAILED") {
  if (error instanceof ObserverError && typeof error.code === "string") {
    return error.code;
  }
  if (typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)) {
    return `IO_${error.code}`;
  }
  return fallback;
}
