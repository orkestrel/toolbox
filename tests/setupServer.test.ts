import { createTestTimer, readAvailable } from './setupServer.js'
import { describe, expect, it } from 'vitest'

describe('setupServer', () => {
	it('createTestTimer arms deadlines without a real host timer and fires only the requested index', () => {
		const fake = createTestTimer()
		const fired: number[] = []

		fake.timer(() => fired.push(0), 5)
		fake.timer(() => fired.push(1), 5)
		expect(fake.armed).toBe(2)

		fake.fire(1)
		expect(fired).toEqual([1])
		fake.fire(1)
		expect(fired).toEqual([1, 1])
	})

	it('createTestTimer counts a cancelled deadline and never fires it after cancellation', () => {
		const fake = createTestTimer()
		const fired: number[] = []
		const cancel = fake.timer(() => fired.push(0), 5)

		cancel()
		expect(fake.cancelled).toBe(1)
		fake.fire(0)
		expect(fired).toEqual([])
	})

	it('readAvailable decodes the bytes a real stream has pushed within its idle window', async () => {
		const encoder = new TextEncoder()
		let push: ((chunk: Uint8Array) => void) | undefined
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('first-chunk'))
				push = (chunk) => controller.enqueue(chunk)
			},
		})
		const response = new Response(body)

		const first = await readAvailable(response)
		expect(first).toBe('first-chunk')

		if (push === undefined) throw new Error('stream controller was not captured')
		push(encoder.encode('second-chunk'))
		const second = await readAvailable(response)
		expect(second).toBe('second-chunk')
	})

	it('readAvailable returns an empty string once a real stream has closed with nothing pending', async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close()
			},
		})
		const response = new Response(body)

		expect(await readAvailable(response)).toBe('')
	})

	it('readAvailable returns an empty string when a response carries no body', async () => {
		const response = new Response(null)

		expect(await readAvailable(response)).toBe('')
	})
})
