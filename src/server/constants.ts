// Server-package constants — UPPER_SNAKE, `Object.freeze`d where structural, every member
// exported.

/**
 * Holds the default `:name`-templated path {@link import('./factories.js').createTerminalRoutes}
 * mounts its GET (SSE) + POST (answer) routes under.
 */
export const TERMINAL_ROUTES_PATH = '/terminals/:name'

/**
 * Holds the default SSE keepalive interval (in milliseconds)
 * {@link import('./factories.js').createTerminalRoutes} arms per open connection — a `: `
 * comment ping a conforming SSE parser ignores, keeping intermediary proxies from timing out an
 * otherwise-idle stream.
 */
export const TERMINAL_KEEPALIVE_MS = 15_000
