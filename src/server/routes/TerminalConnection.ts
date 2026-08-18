import type {
	PendingForm,
	TerminalManagerInterface,
	TimerCancel,
	TimerHandler,
	WireEvent,
} from '@orkestrel/terminal'
import type { StreamInterface } from '@orkestrel/server'
import { HEADER_TOKEN, serializeExpire, serializePending } from '@orkestrel/terminal'

/**
 * Own one terminal SSE connection's replay, subscriptions, keepalive, and teardown.
 *
 * Internal to this module: `TerminalRoutes` builds the `accepts` predicate from its own token
 * option and opens the stream, so no consumer can construct one. Reach this behaviour through
 * `createTerminalRoutes`.
 */
export class TerminalConnection {
	readonly #manager: TerminalManagerInterface
	readonly #name: string
	readonly #request: Request
	readonly #stream: StreamInterface
	readonly #accepts: (presented: string | undefined) => boolean
	readonly #timer: TimerHandler
	readonly #keepalive: number
	readonly #presented: string | undefined
	#cancel: TimerCancel | undefined
	readonly #destroyHandler: () => void
	readonly #pendingHandler: (form: PendingForm) => void
	readonly #expireHandler: (to: string, id: string) => void
	readonly #tickHandler: () => void

	/**
	 * Create a terminal stream connection.
	 *
	 * @param manager - Terminal manager supplying pending forms and lifecycle events
	 * @param name - Terminal endpoint streamed by this connection
	 * @param request - Request whose abort signal owns the connection lifetime
	 * @param stream - Open SSE stream
	 * @param accepts - Presented-token validator
	 * @param timer - Keepalive timer implementation
	 * @param keepalive - Keepalive interval in milliseconds
	 */
	constructor(
		manager: TerminalManagerInterface,
		name: string,
		request: Request,
		stream: StreamInterface,
		accepts: (presented: string | undefined) => boolean,
		timer: TimerHandler,
		keepalive: number,
	) {
		this.#manager = manager
		this.#name = name
		this.#request = request
		this.#stream = stream
		this.#accepts = accepts
		this.#timer = timer
		this.#keepalive = keepalive
		this.#presented = request.headers.get(HEADER_TOKEN) ?? undefined
		this.#destroyHandler = this.#destroy.bind(this)
		this.#pendingHandler = this.#pending.bind(this)
		this.#expireHandler = this.#expire.bind(this)
		this.#tickHandler = this.#tick.bind(this)
	}

	/**
	 * Open the connection by replaying pending forms, subscribing, and arming keepalive handling.
	 *
	 * @returns The SSE response
	 */
	open(): Response {
		if (this.#stream.closed || this.#request.signal.aborted) {
			this.#destroy()
			return this.#stream.response
		}
		if (this.#cancel !== undefined) return this.#stream.response
		for (const form of this.#manager.pending(this.#name)) {
			this.#write(serializePending(form))
		}
		this.#manager.emitter.on('pending', this.#pendingHandler)
		this.#manager.emitter.on('expire', this.#expireHandler)
		this.#cancel = this.#timer(this.#tickHandler, this.#keepalive)
		this.#request.signal.addEventListener('abort', this.#destroyHandler)
		return this.#stream.response
	}

	#write(wire: WireEvent): void {
		this.#stream.write({
			event: wire.event,
			data: wire.data,
			...(wire.id === undefined ? {} : { id: wire.id }),
		})
	}

	#pending(form: PendingForm): void {
		if (form.to !== this.#name) return
		if (this.#stream.closed) {
			this.#destroy()
			return
		}
		this.#write(serializePending(form))
	}

	#expire(to: string, id: string): void {
		if (to !== this.#name) return
		if (this.#stream.closed) {
			this.#destroy()
			return
		}
		this.#write(serializeExpire(id))
	}

	#tick(): void {
		if (this.#stream.closed || !this.#accepted()) {
			this.#destroy()
			return
		}
		this.#stream.comment('')
		this.#cancel = this.#timer(this.#tickHandler, this.#keepalive)
	}

	#accepted(): boolean {
		try {
			return this.#accepts(this.#presented)
		} catch {
			return false
		}
	}

	#destroy(): void {
		const cancel = this.#cancel
		this.#cancel = undefined
		cancel?.()
		this.#manager.emitter.off('pending', this.#pendingHandler)
		this.#manager.emitter.off('expire', this.#expireHandler)
		this.#request.signal.removeEventListener('abort', this.#destroyHandler)
		this.#stream.end()
	}
}
