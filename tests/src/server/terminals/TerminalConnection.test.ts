import { createStream } from '@orkestrel/server'
import { createTerminalManager } from '@orkestrel/terminal'
// `TerminalConnection` is internal: it is not exported from the `@orkestrel/toolbox/server`
// barrel, so the test reaches it by its real path.
import { TerminalConnection } from '../../../../src/server/terminals/TerminalConnection.js'
import { createTestTimer, readAvailable } from '../../../setupServer.js'
import { describe, expect, it } from 'vitest'

describe('TerminalConnection', () => {
	it('opens once without duplicating listeners or keepalive timers', async () => {
		const timer = createTestTimer()
		const manager = createTerminalManager()
		manager.add('assistant')
		const pending = manager.emitter.count('pending')
		const expire = manager.emitter.count('expire')
		const controller = new AbortController()
		const request = new Request('http://x/terminals/assistant', {
			signal: controller.signal,
		})
		const connection = new TerminalConnection(
			manager,
			'assistant',
			request,
			createStream(),
			() => true,
			timer.timer,
			1000,
		)

		const first = connection.open()
		const second = connection.open()

		expect(second).toBe(first)
		expect(manager.emitter.count('pending')).toBe(pending + 1)
		expect(manager.emitter.count('expire')).toBe(expire + 1)
		expect(timer.armed).toBe(1)

		controller.abort()
		await readAvailable(first)
		expect(manager.emitter.count('pending')).toBe(pending)
		expect(manager.emitter.count('expire')).toBe(expire)
		expect(timer.cancelled).toBe(1)
	})

	it('closes immediately when the request is already aborted', async () => {
		const timer = createTestTimer()
		const manager = createTerminalManager()
		manager.add('assistant')
		const pending = manager.emitter.count('pending')
		const expire = manager.emitter.count('expire')
		const controller = new AbortController()
		controller.abort()
		const connection = new TerminalConnection(
			manager,
			'assistant',
			new Request('http://x/terminals/assistant', { signal: controller.signal }),
			createStream(),
			() => true,
			timer.timer,
			1000,
		)

		const response = connection.open()
		await readAvailable(response)

		expect(manager.emitter.count('pending')).toBe(pending)
		expect(manager.emitter.count('expire')).toBe(expire)
		expect(timer.armed).toBe(0)
	})

	it('fails closed when a direct token validator throws', async () => {
		const timer = createTestTimer()
		const manager = createTerminalManager()
		manager.add('assistant')
		const pending = manager.emitter.count('pending')
		const connection = new TerminalConnection(
			manager,
			'assistant',
			new Request('http://x/terminals/assistant'),
			createStream(),
			() => {
				throw new Error('invalid token')
			},
			timer.timer,
			1000,
		)

		const response = connection.open()
		expect(() => timer.fire(0)).not.toThrow()
		await readAvailable(response)

		expect(manager.emitter.count('pending')).toBe(pending)
		expect(timer.armed).toBe(1)
		expect(timer.cancelled).toBe(1)
	})
})
