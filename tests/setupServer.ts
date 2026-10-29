import type { TerminalRoute } from '@src/server'
import { createForm } from '@orkestrel/form'
/**
 * Reads every chunk buffered on an SSE response body.
 *
 * @param response - Streaming response to drain until it closes or becomes idle
 * @returns The available decoded text
 */
export async function readAvailable(response: Response): Promise<string> {
	const reader = response.body?.getReader()
	if (reader === undefined) return ''
	const decoder = new TextDecoder()
	const chunks: string[] = []
	const timeout = new Promise<{ done: true; value: undefined }>((resolve) =>
		setTimeout(() => resolve({ done: true, value: undefined }), 20),
	)
	while (true) {
		const result = await Promise.race([reader.read(), timeout])
		if (result.done) break
		chunks.push(decoder.decode(result.value, { stream: true }))
	}
	reader.releaseLock()
	return chunks.join('')
}

export function findTerminalRoute(
	routes: readonly TerminalRoute[],
	method: TerminalRoute['method'],
): TerminalRoute {
	const route = routes.find((r) => r.method === method)
	if (route === undefined) throw new Error(`no ${method} route`)
	return route
}

export function createTerminalTextForm(label: string) {
	return createForm({ fields: [{ control: 'text', name: 'value', label }] })
}

/** Streams a bounded filler body with state owned by its source. */
export class FillerSource implements UnderlyingDefaultSource<Uint8Array> {
	readonly #total: number
	readonly #chunk: number
	#sent = 0
	constructor(total: number, chunk: number) {
		this.#total = total
		this.#chunk = chunk
	}
	pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
		if (this.#sent >= this.#total) {
			controller.close()
			return
		}
		const size = Math.min(this.#chunk, this.#total - this.#sent)
		controller.enqueue(new Uint8Array(size).fill(97))
		this.#sent += size
	}
}
/** Creates the stream used to prove POST byte limits. */
export function createFillerStream(total: number, chunk = 64): ReadableStream<Uint8Array> {
	return new ReadableStream(new FillerSource(total, chunk))
}
