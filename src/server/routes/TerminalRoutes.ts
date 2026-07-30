import type { TerminalManagerInterface, TimerHandler } from '@orkestrel/terminal'
import type {
	TerminalRoute,
	TerminalRouteContext,
	TerminalRoutesOptions,
	TerminalToken,
} from '../types.js'
import { defaultTimer, HEADER_TOKEN, isAnswerPayload } from '@orkestrel/terminal'
import {
	collectRequestBody,
	ContentTooLargeError,
	DEFAULT_BODY_LIMIT,
	openStream,
} from '@orkestrel/server'
import { TERMINAL_KEEPALIVE_MS, TERMINAL_ROUTES_PATH } from '../constants.js'
import { TerminalConnection } from './TerminalConnection.js'

/**
 * Build and serve the terminal manager's GET stream and POST answer routes.
 *
 * @example
 * ```ts
 * import { TerminalRoutes } from '@orkestrel/tool/server'
 *
 * const routes = new TerminalRoutes(manager).routes()
 * ```
 */
export class TerminalRoutes {
	readonly #manager: TerminalManagerInterface
	readonly #path: string
	readonly #token: TerminalToken | undefined
	readonly #keepalive: number
	readonly #timer: TimerHandler
	readonly #limit: number
	readonly #accepts: (presented: string | undefined) => boolean
	readonly #get: TerminalRoute['handler']
	readonly #post: TerminalRoute['handler']

	/**
	 * Create a terminal route owner.
	 *
	 * @param manager - Terminal manager bridged onto HTTP
	 * @param options - Shared route, authorization, keepalive, timer, and body-limit options
	 */
	constructor(manager: TerminalManagerInterface, options?: TerminalRoutesOptions) {
		this.#manager = manager
		this.#path = options?.path ?? TERMINAL_ROUTES_PATH
		this.#token = options?.token
		this.#keepalive = options?.keepalive ?? TERMINAL_KEEPALIVE_MS
		this.#timer = options?.timer ?? defaultTimer
		const limit = options?.limit
		this.#limit =
			limit === undefined || !Number.isFinite(limit)
				? DEFAULT_BODY_LIMIT
				: Math.max(0, Math.floor(limit))
		this.#accepts = this.#valid.bind(this)
		this.#get = this.#handleGet.bind(this)
		this.#post = this.#handlePost.bind(this)
	}

	/**
	 * Project the bound GET and POST route records.
	 *
	 * @returns The GET stream route followed by the POST answer route
	 */
	routes(): readonly TerminalRoute[] {
		return [
			{ method: 'GET', path: this.#path, handler: this.#get },
			{ method: 'POST', path: this.#path, handler: this.#post },
		]
	}

	#valid(presented: string | undefined): boolean {
		if (this.#token === undefined) return true
		try {
			return typeof this.#token === 'function' ? this.#token(presented) : presented === this.#token
		} catch {
			return false
		}
	}

	#authorized(request: Request): boolean {
		return this.#valid(request.headers.get(HEADER_TOKEN) ?? undefined)
	}

	#handleGet(request: Request, context: TerminalRouteContext): Response {
		if (!this.#authorized(request)) return new Response(null, { status: 401 })
		const name = context.params.name
		if (name === undefined || this.#manager.terminal(name) === undefined) {
			return new Response(null, { status: 404 })
		}
		const connection = new TerminalConnection(
			this.#manager,
			name,
			request,
			openStream(),
			this.#accepts,
			this.#timer,
			this.#keepalive,
		)
		return connection.open()
	}

	async #handlePost(request: Request, context: TerminalRouteContext): Promise<Response> {
		if (!this.#authorized(request)) return new Response(null, { status: 401 })
		const name = context.params.name
		if (name === undefined || this.#manager.terminal(name) === undefined) {
			return new Response(null, { status: 404 })
		}
		let bytes: Uint8Array
		try {
			bytes = await collectRequestBody(request, Math.max(1, this.#limit))
		} catch (error) {
			if (error instanceof ContentTooLargeError) return new Response(null, { status: 413 })
			throw error
		}
		if (bytes.byteLength > 0 && bytes.byteLength > this.#limit) {
			return new Response(null, { status: 413 })
		}

		let body: unknown
		try {
			body = JSON.parse(new TextDecoder().decode(bytes))
		} catch {
			return new Response(null, { status: 400 })
		}
		if (!isAnswerPayload(body)) return new Response(null, { status: 422 })

		const result = this.#manager.answer(name, body.id, body.value)
		if (result.success) return new Response(null, { status: 204 })
		if (result.error === 'terminal') return new Response(result.error, { status: 404 })
		return new Response(result.error, { status: 422 })
	}
}
