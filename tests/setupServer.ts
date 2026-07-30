import type { TimerHandler } from '@orkestrel/terminal'

/** A controllable timer fixture with observable arm and cancellation counts. */
export interface TestTimerInterface {
	readonly timer: TimerHandler
	readonly armed: number
	readonly cancelled: number
	fire(index: number): void
}

/**
 * Create a controllable timer fixture for injected server lifecycles.
 *
 * @returns A timer and its observable arm/cancellation record
 */
export function createTestTimer(): TestTimerInterface {
	const entries: Array<{ callback: () => void; cancelled: boolean }> = []
	return {
		timer(callback, _delay) {
			const entry = { callback, cancelled: false }
			entries.push(entry)
			return () => {
				entry.cancelled = true
			}
		},
		get armed() {
			return entries.length
		},
		get cancelled() {
			return entries.filter((entry) => entry.cancelled).length
		},
		fire(index: number): void {
			const entry = entries[index]
			if (entry !== undefined && !entry.cancelled) entry.callback()
		},
	}
}

/**
 * Read every chunk currently buffered on an SSE response body.
 *
 * @param response - Streaming response to drain until it closes or becomes idle
 * @returns The currently available decoded text
 */
export async function readAvailable(response: Response): Promise<string> {
	const reader = response.body?.getReader()
	if (reader === undefined) return ''
	const decoder = new TextDecoder()
	let text = ''
	const timeout = new Promise<{ done: true; value: undefined }>((resolve) =>
		setTimeout(() => resolve({ done: true, value: undefined }), 20),
	)
	while (true) {
		const result = await Promise.race([reader.read(), timeout])
		if (result.done) break
		text += decoder.decode(result.value, { stream: true })
	}
	reader.releaseLock()
	return text
}
