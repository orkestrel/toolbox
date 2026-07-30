import type { TerminalManagerInterface } from '@orkestrel/terminal'
import type { TerminalRoute, TerminalRoutesOptions } from './types.js'
import { TerminalRoutes } from './routes/TerminalRoutes.js'

/**
 * Build the GET SSE stream and POST answer routes that bridge a terminal manager onto the wire.
 *
 * @remarks
 * Both routes share the configured `:name` path and optional token gate. The GET route replays
 * pending prompts, forwards live pending/expire events, and owns abort/keepalive teardown. The
 * POST route bounds the request body before parsing and maps answer outcomes to HTTP statuses.
 *
 * @param manager - The terminal manager whose endpoints are bridged
 * @param options - Route path, token, keepalive, timer, and body-limit options
 * @returns The GET route followed by the POST route
 *
 * @example
 * ```ts
 * import { createTerminalRoutes } from '@src/server'
 * import { createTerminalManager } from '@orkestrel/terminal'
 *
 * const manager = createTerminalManager()
 * manager.add('assistant')
 * const routes = createTerminalRoutes(manager, { token: 'secret' })
 * ```
 */
export function createTerminalRoutes(
	manager: TerminalManagerInterface,
	options?: TerminalRoutesOptions,
): readonly TerminalRoute[] {
	return new TerminalRoutes(manager, options).routes()
}
