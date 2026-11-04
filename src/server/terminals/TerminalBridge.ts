import type { AuditFault, ContractInterface, Infer } from '@orkestrel/contract'
import type { TerminalManagerInterface, TimerHandler } from '@orkestrel/terminal'
import type {
	TerminalRoute,
	TerminalRouteContext,
	TerminalRoutesOptions,
	TerminalToken,
} from '../types.js'
import { defaultTimer, HEADER_TOKEN } from '@orkestrel/terminal'
import { isFieldValue, isFormValues } from '@orkestrel/form'
import {
	createContract,
	isFiniteNumber,
	isFunction,
	isInstance,
	isNonEmptyString,
	parseJSON,
	preview,
} from '@orkestrel/contract'
import {
	collectRequestBody,
	ContentTooLargeError,
	createStream,
	DEFAULT_BODY_LIMIT,
} from '@orkestrel/server'
import { describeFaults } from '@orkestrel/tool'
import { limitRefusal, resolveBound, ToolboxError } from '@src/core'
import { TERMINAL_KEEPALIVE_MS, TERMINAL_ROUTES_PATH } from '../constants.js'
import { terminalAnswerShape } from '../shapers.js'
import { TerminalConnection } from './TerminalConnection.js'

/**
 * Bridges a terminal manager onto the wire — owns the shared route options, the token gate, and
 * the bound GET stream and POST answer handlers.
 *
 * Not exported from the `@orkestrel/toolbox/server` barrel — reach this behaviour through
 * `createTerminalRoutes`.
 */
export class TerminalBridge {
	readonly #manager: TerminalManagerInterface
	readonly #path: string
	readonly #token: TerminalToken
	readonly #keepalive: number
	readonly #timer: TimerHandler
	readonly #limit: number
	readonly #answer: ContractInterface<Infer<typeof terminalAnswerShape>>
	readonly #accepts: (presented: string | undefined) => boolean
	readonly #get: TerminalRoute['handler']
	readonly #post: TerminalRoute['handler']

	/**
	 * Creates a terminal bridge.
	 *
	 * @param manager - Terminal manager bridged onto HTTP
	 * @param options - Required token, plus shared route, keepalive, timer, and body-limit options
	 * @throws {ToolboxError} Thrown with code `TOOL` for a missing or malformed `token`, a `keepalive`
	 *   that is not a positive finite number, or a `limit` that is not a positive safe integer
	 */
	constructor(manager: TerminalManagerInterface, options: TerminalRoutesOptions) {
		// An untyped caller can omit the options, which is the same refusal as omitting the token.
		const token = options?.token
		if (!isNonEmptyString(token) && !isFunction(token)) {
			throw new ToolboxError(
				'TOOL',
				`terminal routes need a token; received ${preview(token)}; pass token: 'SECRET' to compare the ${HEADER_TOKEN} header, a function to decide each value, or token: () => true to leave the routes open`,
			)
		}
		const keepalive = options.keepalive ?? TERMINAL_KEEPALIVE_MS
		if (!isFiniteNumber(keepalive) || keepalive <= 0) {
			throw new ToolboxError(
				'TOOL',
				`terminal keepalive must be a positive finite number of milliseconds; received ${preview(keepalive)}; omit it for the default ${String(TERMINAL_KEEPALIVE_MS)}`,
			)
		}
		this.#manager = manager
		this.#path = options.path ?? TERMINAL_ROUTES_PATH
		this.#token = token
		this.#keepalive = keepalive
		this.#timer = options.timer ?? defaultTimer
		this.#limit = resolveBound(options.limit, DEFAULT_BODY_LIMIT, 'terminal body limit')
		this.#answer = createContract(terminalAnswerShape)
		this.#accepts = this.#valid.bind(this)
		this.#get = this.#handleGet.bind(this)
		this.#post = this.#handlePost.bind(this)
	}

	/**
	 * Projects the bound GET and POST route records.
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
			createStream(),
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
		const bytes = await this.#readBody(request)
		if (bytes instanceof Response) return bytes

		const body = parseJSON(new TextDecoder().decode(bytes))
		if (body === undefined) {
			return new Response(null, { status: 400 })
		}
		if (!this.#answer.is(body)) return this.#refuse(this.#answer.audit(body))
		const { id, values } = body
		if (!isFormValues(values)) {
			return this.#refuse(
				Object.entries(values)
					.filter(([, value]) => !isFieldValue(value))
					.map(([key, value]) => ({
						reason: 'type',
						path: ['values', key],
						expected: 'union',
						received: preview(value),
					})),
			)
		}

		const result = this.#manager.answer(name, id, values)
		if (result.success) return Response.json(result)
		if (result.error.reason === 'target') return Response.json(result, { status: 404 })
		return Response.json(result, { status: 422 })
	}

	// A malformed body answers in the manager's result envelope, so a client reads one body shape.
	#refuse(faults: readonly AuditFault[]): Response {
		const message = limitRefusal(
			`an answer body is { id, values }, where values maps each field name to a string, a finite number, a boolean, or a list of strings; correct each line and send it again:\n${describeFaults(faults, this.#answer.schema)}`,
		)
		return Response.json(
			{ success: false, error: { reason: 'malformed', message, faults } },
			{ status: 422 },
		)
	}

	async #readBody(request: Request): Promise<Uint8Array | Response> {
		try {
			return await collectRequestBody(request, this.#limit)
		} catch (error) {
			if (isInstance(error, ContentTooLargeError)) return new Response(null, { status: 413 })
			throw error
		}
	}
}
