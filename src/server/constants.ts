// Server-package constants — UPPER_SNAKE, `Object.freeze`d where structural, every member
// exported.

/**
 * Holds the default `:name`-templated path {@link import('./factories.js').createTerminalRoutes}
 * mounts its GET (SSE) and POST (answer) routes under, `/terminals/:name`.
 */
export const TERMINAL_ROUTES_PATH = '/terminals/:name'

/**
 * Holds the default SSE keepalive interval {@link import('./factories.js').createTerminalRoutes}
 * arms per open connection, `15_000` ms — a `: ` comment ping a conforming SSE parser ignores,
 * keeping intermediary proxies from timing out an otherwise-idle stream.
 */
export const TERMINAL_KEEPALIVE_MS = 15_000
