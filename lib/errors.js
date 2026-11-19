// Shared error type. Every endpoint answers failures the same way:
// { "error": { "code", "message" } } with an honest, platform-named message.

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    // UNSUPPORTED -> 400, NOT_FOUND -> 404, BLOCKED / UPSTREAM_ERROR -> 502
    this.status = code === "UNSUPPORTED" ? 400 : code === "NOT_FOUND" ? 404 : 502;
  }
}

export const unsupported = (message) => new ApiError("UNSUPPORTED", message);
export const notFound = (message) => new ApiError("NOT_FOUND", message);
export const blocked = (message) => new ApiError("BLOCKED", message);
export const upstream = (message) => new ApiError("UPSTREAM_ERROR", message);
