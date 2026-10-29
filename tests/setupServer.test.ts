import { readAvailable } from './setupServer.js'
import { describe, expect, it } from 'vitest'

describe('setupServer', () => {
	it('readAvailable decodes the bytes a real stream has pushed within its idle window', async () => {
		const encoder = new TextEncoder()
		const capture = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('first-chunk'))
				capture.resolve(controller)
			},
		})
		const response = new Response(body)

		const first = await readAvailable(response)
		expect(first).toBe('first-chunk')

		const controller = await capture.promise
		controller.enqueue(encoder.encode('second-chunk'))
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
