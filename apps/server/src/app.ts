import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError, diagnostics } from "./errors";
import { createLogger } from "./lib/logger";
import { createApiRouter, type ApiDeps } from "./routes/api";

const log = createLogger("http");

export interface AppOptions {
  deps: ApiDeps;
  allowedOrigins: string[];
  port: number;
}

/**
 * Defence for a local-only API:
 *  - Host must be a loopback name (blocks DNS-rebinding from a malicious site).
 *  - A browser-supplied Origin must be on the allow-list (blocks cross-site requests).
 *  - Request bodies must be JSON.
 */
function localOnlyGuard(opts: AppOptions): RequestHandler {
  const hosts = new Set([`localhost:${opts.port}`, `127.0.0.1:${opts.port}`, `[::1]:${opts.port}`]);
  return (req, _res, next) => {
    if (!req.headers.host || !hosts.has(req.headers.host)) return next(new AppError("bad_host", "Requests must use a loopback host name", { status: 403 }));
    const origin = req.headers.origin;
    if (origin && !opts.allowedOrigins.includes(origin)) return next(new AppError("bad_origin", `Origin ${origin} is not allowed`, { status: 403 }));
    if (Number(req.headers["content-length"] ?? 0) > 0 && !req.is("application/json")) return next(new AppError("unsupported_media_type", "Send application/json", { status: 415 }));
    next();
  };
}

/** User-readable errors only: details and stacks stay in the logs. */
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    if (err.status >= 500) log.error(`request failed: ${err.userMessage}`, { code: err.code });
    res.status(err.status).json({ error: { code: err.code, message: err.userMessage, hint: err.hint, details: err.status < 500 ? err.details : undefined } });
  } else if (err instanceof ZodError) {
    res.status(400).json({ error: { code: "validation_failed", message: err.issues.map((i) => i.message).join("; ") } });
  } else if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: { code: "invalid_json", message: "Request body is not valid JSON" } });
  } else {
    log.error("unhandled error", diagnostics(err) as never);
    res.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
  }
};

export function createApp(opts: AppOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.use(localOnlyGuard(opts));
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", createApiRouter(opts.deps));
  app.use("/api", (_req, _res, next) => next(new AppError("not_found", "Unknown API route", { status: 404 })));
  app.use(errorHandler);
  return app;
}
