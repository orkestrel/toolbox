import type { TimerHandler } from '@orkestrel/terminal'

// Server-package types — the structural route contract this barrel returns, kept LOCAL (never
// imports `@orkestrel/router`) so a consumer mounts the two returned routes against ANY router
// that accepts this shape (AGENTS §5: types are the source of truth).

/** The HTTP method literal a {@link TerminalRoute} declares — the exact 7-literal union `@orkestrel/router`'s `Method` accepts. */
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

/**
 * The minimal route-dispatch context a {@link TerminalRoute} handler reads — exactly the frozen,
 * URL-decoded `:name` path param slice a router hands a matched handler.
 */
export interface TerminalRouteContext {
	readonly params: Readonly<Record<string, string>>
}

/**
 * One structural route record {@link import('./factories.js').createTerminalRoutes} returns — a
 * plain `{ method, path, handler }` shape carrying NO dependency on `@orkestrel/router`'s own
 * `Route` type, so a consumer mounts it against any router that accepts a two-arg
 * `(request, context) => Response | Promise<Response>` handler keyed by `method` + `path`.
 */
export interface TerminalRoute {
	readonly method: Method
	readonly path: string
	readonly handler: (
		request: Request,
		context: TerminalRouteContext,
	) => Response | Promise<Response>
}

/**
 * The `token` gate a {@link TerminalRoutesOptions} may configure — a plain string compared for
 * equality against the `x-orkestrel-token` header, OR a validator function the consumer fully
 * controls, enabling expiry/rotation (a JWT `exp` check, a revocation-list lookup, anything
 * time-varying) that a fixed string cannot express. `undefined` disables the auth check entirely.
 */
export type TerminalToken = string | ((value: string | undefined) => boolean)

/**
 * Options for {@link import('./factories.js').createTerminalRoutes}.
 *
 * @remarks
 * - `path` — the shared `:name`-templated path both the GET (SSE) and POST (answer) routes
 *   mount under; defaults to {@link import('./constants.js').TERMINAL_ROUTES_PATH}.
 * - `token` — a {@link TerminalToken}: a string is compared for equality against the
 *   `x-orkestrel-token` header; a function receives the header's value (`undefined` when absent)
 *   and returns whether it validates, letting the consumer roll/expire tokens out-of-band.
 *   Validated at GET connect, on EVERY POST, and RE-VALIDATED on every keepalive tick of a live
 *   SSE stream — a stream whose presented token stops validating (rotated, expired, revoked) is
 *   torn down (the abort/self-heal teardown path, no `shutdown` frame) rather than left open
 *   forever; the client reconnects and re-authenticates. Omitted ⇒ no auth check. Because
 *   re-validation only happens on the keepalive tick, the revocation window equals the keepalive
 *   interval — a token rejected/expired between ticks keeps streaming until the next one. A
 *   validator function that THROWS is treated as rejection (fail-closed) at every call site.
 * - `keepalive` — the SSE comment-ping interval in milliseconds; defaults to
 *   {@link import('./constants.js').TERMINAL_KEEPALIVE_MS}.
 * - `timer` — the injected {@link TimerHandler} driving the keepalive interval (default the host
 *   `setTimeout`/`clearTimeout`), so a test drives the keepalive deterministically.
 * - `limit` — the maximum POST answer body size in bytes, streamed and enforced BEFORE JSON
 *   parsing (ignoring any `Content-Length` header, so a lying header can never bypass the cap);
 *   a body exceeding it is rejected `413` and `manager.answer` is never called. Defaults to
 *   `@orkestrel/server`'s own `DEFAULT_BODY_LIMIT` (1 MiB).
 */
export interface TerminalRoutesOptions {
	readonly path?: string
	readonly token?: TerminalToken
	readonly keepalive?: number
	readonly timer?: TimerHandler
	readonly limit?: number
}
