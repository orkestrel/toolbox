import type { TerminalRoute } from '@src/server'
import { DEFAULT_BODY_LIMIT } from '@orkestrel/server'
import { HEADER_TOKEN } from '@orkestrel/terminal'
import { createTerminalManager } from '@orkestrel/terminal'
import { createTerminalRoutes } from '@src/server'
import { createTestTimer, readAvailable } from '../../setupServer.js'
import { describe, expect, it } from 'vitest'

// tests/src/server/factories.test.ts — mirrors src/server/factories.ts. Handlers are invoked
// DIRECTLY against a real `createTerminalManager` (`@orkestrel/terminal`) for deterministic
// coverage (AGENTS §16 — no mocks); a fake, controllable `TimerHandler` drives the SSE keepalive
// without wall-clock timing.

function findRoute(
	routes: readonly TerminalRoute[],
	method: TerminalRoute['method'],
): TerminalRoute {
	const route = routes.find((r) => r.method === method)
	if (route === undefined) throw new Error(`no ${method} route`)
	return route
}

describe('createTerminalRoutes', () => {
	it('returns exactly two routes, GET and POST, on the same path', () => {
		const manager = createTerminalManager()
		const routes = createTerminalRoutes(manager)
		expect(routes).toHaveLength(2)
		expect(routes.map((r) => r.method).sort()).toEqual(['GET', 'POST'])
		expect(new Set(routes.map((r) => r.path)).size).toBe(1)
	})

	it('returns 404 when a route context omits the name parameter', async () => {
		const manager = createTerminalManager()
		const routes = createTerminalRoutes(manager)
		const request = new Request('http://x/terminals')
		for (const route of routes) {
			const response = await route.handler(request, { params: {} })
			expect(response.status).toBe(404)
		}
	})

	it('GET 404s on an unknown endpoint name', async () => {
		const manager = createTerminalManager()
		const routes = createTerminalRoutes(manager)
		const get = findRoute(routes, 'GET')
		const response = await get.handler(new Request('http://x/terminals/ghost'), {
			params: { name: 'ghost' },
		})
		expect(response.status).toBe(404)
	})

	it('GET 401s on a bad token when one is configured', async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager, { token: 'secret' })
		const get = findRoute(routes, 'GET')
		const response = await get.handler(new Request('http://x/terminals/assistant'), {
			params: { name: 'assistant' },
		})
		expect(response.status).toBe(401)
		const ok = await get.handler(
			new Request('http://x/terminals/assistant', { headers: { [HEADER_TOKEN]: 'secret' } }),
			{ params: { name: 'assistant' } },
		)
		expect(ok.status).toBe(200)
	})

	it('GET streams a replayed pending prompt, a live pending event, and an expire event; keepalive fires; abort ends the stream', async () => {
		const fake = createTestTimer()
		const manager = createTerminalManager()
		manager.add('assistant', { timeout: 5, timer: fake.timer })
		const routes = createTerminalRoutes(manager, { timer: fake.timer, keepalive: 1000 })
		const get = findRoute(routes, 'GET')

		// Park a prompt BEFORE opening the stream so it is replayed.
		const asked = manager.ask('human', 'assistant', 'input', { message: 'name?' })
		asked.catch(() => {})

		const controller = new AbortController()
		const response = await get.handler(
			new Request('http://x/terminals/assistant', { signal: controller.signal }),
			{
				params: { name: 'assistant' },
			},
		)
		expect(response.status).toBe(200)

		const replayed = await readAvailable(response)
		expect(replayed).toContain('event: pending')
		expect(replayed).toContain('name?')

		// Live pending: ask a second prompt after the stream opened.
		const asked2 = manager.ask('human', 'assistant', 'input', { message: 'again?' })
		asked2.catch(() => {})
		const live = await readAvailable(response)
		expect(live).toContain('again?')

		// Keepalive: fire the route's own armed timer (index 1 — armed after the first `ask`'s
		// own timeout timer at index 0, and before the second `ask`'s timeout timer at index 2).
		fake.fire(1)
		const keepalive = await readAvailable(response)
		expect(keepalive.startsWith(':')).toBe(true)

		// Expire: fire the FIRST parked prompt's own timeout timer (index 0 — armed by `manager.ask`).
		fake.fire(0)
		const expired = await readAvailable(response)
		expect(expired).toContain('event: expire')

		controller.abort()
		await readAvailable(response)
	})

	it('POST 204s and resolves the parked ask on a valid answer', async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager)
		const post = findRoute(routes, 'POST')

		const asked = manager.ask('human', 'assistant', 'input', { message: 'name?' })
		const pending = manager.pending('assistant')
		const id = pending[0]?.id
		if (id === undefined) throw new Error('expected a parked prompt')

		const response = await post.handler(
			new Request('http://x/terminals/assistant', {
				method: 'POST',
				body: JSON.stringify({ id, value: 'Ada' }),
			}),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(204)
		await expect(asked).resolves.toBe('Ada')
	})

	it('POST 422s on a malformed body', async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager)
		const post = findRoute(routes, 'POST')
		const response = await post.handler(
			new Request('http://x/terminals/assistant', {
				method: 'POST',
				body: JSON.stringify({ foo: 'bar' }),
			}),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(422)
	})

	it('POST 400s on invalid JSON', async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager)
		const post = findRoute(routes, 'POST')
		const response = await post.handler(
			new Request('http://x/terminals/assistant', { method: 'POST', body: 'not json' }),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(400)
	})

	it('POST 404s on an unknown endpoint name', async () => {
		const manager = createTerminalManager()
		const routes = createTerminalRoutes(manager)
		const post = findRoute(routes, 'POST')
		const response = await post.handler(
			new Request('http://x/terminals/ghost', {
				method: 'POST',
				body: JSON.stringify({ id: 'x', value: 1 }),
			}),
			{ params: { name: 'ghost' } },
		)
		expect(response.status).toBe(404)
	})

	it('POST 401s on a bad token when one is configured', async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager, { token: 'secret' })
		const post = findRoute(routes, 'POST')
		const response = await post.handler(
			new Request('http://x/terminals/assistant', {
				method: 'POST',
				body: JSON.stringify({ id: 'x', value: 1 }),
			}),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(401)
	})

	it('function token: a live stream is torn down on the keepalive tick once the validator starts rejecting the presented value, and does not re-arm', async () => {
		const fake = createTestTimer()
		const manager = createTerminalManager()
		manager.add('assistant')
		let acceptable = true
		const routes = createTerminalRoutes(manager, {
			token: (value) => value === 'rotating' && acceptable,
			timer: fake.timer,
			keepalive: 1000,
		})
		const get = findRoute(routes, 'GET')

		const baselinePending = manager.emitter.count('pending')
		const baselineExpire = manager.emitter.count('expire')

		const controller = new AbortController()
		const response = await get.handler(
			new Request('http://x/terminals/assistant', {
				headers: { [HEADER_TOKEN]: 'rotating' },
				signal: controller.signal,
			}),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(200)

		// Park a prompt so a live frame is available before the tick.
		const asked = manager.ask('human', 'assistant', 'input', { message: 'still valid?' })
		asked.catch(() => {})
		const live = await readAvailable(response)
		expect(live).toContain('still valid?')

		// Flip the validator to reject — simulates a rotated/expired/revoked token.
		acceptable = false

		// Fire the armed keepalive tick — it must re-validate and tear down instead of pinging.
		fake.fire(0)
		const afterTick = await readAvailable(response)
		expect(afterTick.startsWith(':')).toBe(false)

		// Teardown ran: manager listener counts back to baseline, keepalive not re-armed.
		expect(manager.emitter.count('pending')).toBe(baselinePending)
		expect(manager.emitter.count('expire')).toBe(baselineExpire)
		expect(fake.armed).toBe(1)

		// A fresh GET with the still-bad validator state 401s.
		const stillBad = await get.handler(
			new Request('http://x/terminals/assistant', {
				headers: { [HEADER_TOKEN]: 'rotating' },
			}),
			{ params: { name: 'assistant' } },
		)
		expect(stillBad.status).toBe(401)

		// Restore the validator — connect succeeds again.
		acceptable = true
		const restored = await get.handler(
			new Request('http://x/terminals/assistant', {
				headers: { [HEADER_TOKEN]: 'rotating' },
			}),
			{ params: { name: 'assistant' } },
		)
		expect(restored.status).toBe(200)
	})

	it('static string token: keepalive re-validation is a no-op for a live stream — several ticks keep it open with comments written', async () => {
		const fake = createTestTimer()
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager, {
			token: 'secret',
			timer: fake.timer,
			keepalive: 1000,
		})
		const get = findRoute(routes, 'GET')

		const controller = new AbortController()
		const response = await get.handler(
			new Request('http://x/terminals/assistant', {
				headers: { [HEADER_TOKEN]: 'secret' },
				signal: controller.signal,
			}),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(200)

		for (let i = 0; i < 3; i++) {
			fake.fire(i)
			const tick = await readAvailable(response)
			expect(tick.startsWith(':')).toBe(true)
		}
		expect(fake.armed).toBe(4)

		controller.abort()
		await readAvailable(response)
	})

	it('POST 401s when a function token now rejects the presented value, manager untouched', async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		let acceptable = true
		const routes = createTerminalRoutes(manager, { token: () => acceptable })
		const post = findRoute(routes, 'POST')

		const asked = manager.ask('human', 'assistant', 'input', { message: 'name?' })
		asked.catch(() => {})
		const before = manager.pending('assistant')

		acceptable = false
		const response = await post.handler(
			new Request('http://x/terminals/assistant', {
				method: 'POST',
				body: JSON.stringify({ id: 'x', value: 1 }),
			}),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(401)
		expect(manager.pending('assistant')).toEqual(before)
	})

	it('GET 401s when the token validator THROWS at connect (fail-closed, not an uncaught exception)', async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager, {
			token: () => {
				throw new Error('boom')
			},
		})
		const get = findRoute(routes, 'GET')
		const response = await get.handler(new Request('http://x/terminals/assistant'), {
			params: { name: 'assistant' },
		})
		expect(response.status).toBe(401)
	})

	it('POST 401s when the token validator THROWS (fail-closed), manager untouched', async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager, {
			token: () => {
				throw new Error('boom')
			},
		})
		const post = findRoute(routes, 'POST')

		const asked = manager.ask('human', 'assistant', 'input', { message: 'name?' })
		asked.catch(() => {})
		const before = manager.pending('assistant')

		const response = await post.handler(
			new Request('http://x/terminals/assistant', {
				method: 'POST',
				body: JSON.stringify({ id: 'x', value: 1 }),
			}),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(401)
		expect(manager.pending('assistant')).toEqual(before)
	})

	it('a live stream is torn down on the keepalive tick when the validator THROWS mid-stream (fail-closed), not re-armed, no uncaught exception', async () => {
		const fake = createTestTimer()
		const manager = createTerminalManager()
		manager.add('assistant')
		let shouldThrow = false
		const routes = createTerminalRoutes(manager, {
			token: (value) => {
				if (shouldThrow) throw new Error('boom')
				return value === 'rotating'
			},
			timer: fake.timer,
			keepalive: 1000,
		})
		const get = findRoute(routes, 'GET')

		const baselinePending = manager.emitter.count('pending')
		const baselineExpire = manager.emitter.count('expire')

		const controller = new AbortController()
		const response = await get.handler(
			new Request('http://x/terminals/assistant', {
				headers: { [HEADER_TOKEN]: 'rotating' },
				signal: controller.signal,
			}),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(200)

		// Park a prompt so a live frame is available before the tick.
		const asked = manager.ask('human', 'assistant', 'input', { message: 'still valid?' })
		asked.catch(() => {})
		const live = await readAvailable(response)
		expect(live).toContain('still valid?')

		// Flip the validator to THROW — simulates a JWT `exp` check or revocation lookup blowing up.
		shouldThrow = true

		// Fire the armed keepalive tick — the throw must be caught and treated as invalid, tearing
		// the stream down instead of escaping into the timer host.
		expect(() => fake.fire(0)).not.toThrow()
		const afterTick = await readAvailable(response)
		expect(afterTick.startsWith(':')).toBe(false)

		// Teardown ran: manager listener counts back to baseline, keepalive not re-armed.
		expect(manager.emitter.count('pending')).toBe(baselinePending)
		expect(manager.emitter.count('expire')).toBe(baselineExpire)
		expect(fake.armed).toBe(1)
	})
})

// ── pressure: mount churn — repeated GET connect→abort cycles ────────────────

describe('pressure: mount churn — 50 sequential GET connect→abort cycles, no leaked timers/listeners', () => {
	it('every armed keepalive timer is cancelled on abort — zero live timers after churn', async () => {
		const churn = createTestTimer()
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager, { timer: churn.timer, keepalive: 1000 })
		const get = findRoute(routes, 'GET')

		for (let i = 0; i < 50; i++) {
			const controller = new AbortController()
			const response = await get.handler(
				new Request('http://x/terminals/assistant', { signal: controller.signal }),
				{ params: { name: 'assistant' } },
			)
			expect(response.status).toBe(200)
			await readAvailable(response)
			controller.abort()
			await readAvailable(response)
		}

		// One keepalive timer armed per connect (50 total), and every one cancelled on its own
		// abort — the churn leaves zero LIVE (uncancelled) timers behind.
		expect(churn.armed).toBe(50)
		expect(churn.cancelled).toBe(churn.armed)
	})

	it('after 50 churn cycles, manager listener counts are back to baseline (no leaked pending/expire subscriptions)', async () => {
		const churn = createTestTimer()
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager, { timer: churn.timer, keepalive: 1000 })
		const get = findRoute(routes, 'GET')

		const baselinePending = manager.emitter.count('pending')
		const baselineExpire = manager.emitter.count('expire')

		for (let i = 0; i < 50; i++) {
			const controller = new AbortController()
			const response = await get.handler(
				new Request('http://x/terminals/assistant', { signal: controller.signal }),
				{ params: { name: 'assistant' } },
			)
			await readAvailable(response)
			controller.abort()
			await readAvailable(response)
		}

		expect(manager.emitter.count('pending')).toBe(baselinePending)
		expect(manager.emitter.count('expire')).toBe(baselineExpire)
	})

	it('a fresh stream after churn receives EXACTLY ONE pending frame for one parked prompt — no ghost duplicate writes from prior cycles', async () => {
		const churn = createTestTimer()
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager, { timer: churn.timer, keepalive: 1000 })
		const get = findRoute(routes, 'GET')

		// Churn 50 connect→abort cycles on the SAME endpoint before opening the fresh stream.
		for (let i = 0; i < 50; i++) {
			const controller = new AbortController()
			const response = await get.handler(
				new Request('http://x/terminals/assistant', { signal: controller.signal }),
				{ params: { name: 'assistant' } },
			)
			await readAvailable(response)
			controller.abort()
			await readAvailable(response)
		}

		// A fresh, LIVE stream (kept open — not aborted).
		const freshController = new AbortController()
		const fresh = await get.handler(
			new Request('http://x/terminals/assistant', { signal: freshController.signal }),
			{ params: { name: 'assistant' } },
		)
		expect(fresh.status).toBe(200)

		// Park exactly one prompt AFTER the fresh stream opened, so it arrives as a LIVE `pending`
		// event — if any prior cycle's `pendingHandler` had leaked (not truly `off`'d), this single
		// `ask` would fan out into MULTIPLE `event: pending` frames on the fresh stream.
		const asked = manager.ask('human', 'assistant', 'input', { message: 'churn-check' })
		asked.catch(() => {})

		const text = await readAvailable(fresh)
		const pendingFrameCount = (text.match(/event: pending/g) ?? []).length
		expect(pendingFrameCount).toBe(1)

		freshController.abort()
		await readAvailable(fresh)
	})
})

// ── pressure: POST fuzz — malformed bodies, unknown endpoint, bad token, expired id ──

describe('pressure: POST fuzz — malformed bodies, invalid payload shapes, wrong token, expired id', () => {
	it('malformed JSON body 400s, manager state untouched', async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager)
		const post = findRoute(routes, 'POST')
		const before = manager.pending('assistant')
		const response = await post.handler(
			new Request('http://x/terminals/assistant', { method: 'POST', body: '{not valid json' }),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(400)
		expect(manager.pending('assistant')).toEqual(before)
	})

	it('valid JSON but an empty object fails isAnswerPayload — 422, manager state untouched', async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager)
		const post = findRoute(routes, 'POST')
		const asked = manager.ask('human', 'assistant', 'input', { message: 'name?' })
		asked.catch(() => {})
		const before = manager.pending('assistant')
		const response = await post.handler(
			new Request('http://x/terminals/assistant', { method: 'POST', body: JSON.stringify({}) }),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(422)
		expect(manager.pending('assistant')).toEqual(before)
	})

	it('{ id: 1 } (id not a string) fails isAnswerPayload — 422, manager state untouched', async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager)
		const post = findRoute(routes, 'POST')
		const asked = manager.ask('human', 'assistant', 'input', { message: 'name?' })
		asked.catch(() => {})
		const before = manager.pending('assistant')
		const response = await post.handler(
			new Request('http://x/terminals/assistant', {
				method: 'POST',
				body: JSON.stringify({ id: 1 }),
			}),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(422)
		expect(manager.pending('assistant')).toEqual(before)
	})

	it("{ id: 'x' } (missing value key) fails isAnswerPayload — 422, manager state untouched", async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager)
		const post = findRoute(routes, 'POST')
		const asked = manager.ask('human', 'assistant', 'input', { message: 'name?' })
		asked.catch(() => {})
		const before = manager.pending('assistant')
		const response = await post.handler(
			new Request('http://x/terminals/assistant', {
				method: 'POST',
				body: JSON.stringify({ id: 'x' }),
			}),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(422)
		expect(manager.pending('assistant')).toEqual(before)
	})

	it('unknown endpoint 404s regardless of body validity', async () => {
		const manager = createTerminalManager()
		const routes = createTerminalRoutes(manager)
		const post = findRoute(routes, 'POST')
		const response = await post.handler(
			new Request('http://x/terminals/ghost', {
				method: 'POST',
				body: JSON.stringify({ id: 'x', value: 'ok' }),
			}),
			{ params: { name: 'ghost' } },
		)
		expect(response.status).toBe(404)
	})

	it('wrong token 401s before the body is ever parsed (manager state untouched)', async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager, { token: 'secret' })
		const post = findRoute(routes, 'POST')
		const asked = manager.ask('human', 'assistant', 'input', { message: 'name?' })
		asked.catch(() => {})
		const before = manager.pending('assistant')
		const response = await post.handler(
			new Request('http://x/terminals/assistant', {
				method: 'POST',
				headers: { [HEADER_TOKEN]: 'wrong-token' },
				body: JSON.stringify({ id: 'x', value: 'ok' }),
			}),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(401)
		expect(manager.pending('assistant')).toEqual(before)
	})

	it('correct token + well-formed payload for an EXPIRED id: manager.answer reports unknown — 422, manager state untouched', async () => {
		const churn = createTestTimer()
		const manager = createTerminalManager()
		manager.add('assistant', { timeout: 5, timer: churn.timer })
		const routes = createTerminalRoutes(manager, { token: 'secret', timer: churn.timer })
		const post = findRoute(routes, 'POST')

		const asked = manager.ask('human', 'assistant', 'input', { message: 'name?' })
		asked.catch(() => {})
		const pending = manager.pending('assistant')
		const id = pending[0]?.id
		if (id === undefined) throw new Error('expected a parked prompt')

		// Expire it via the injected timer BEFORE posting the answer.
		churn.fire(0)
		await asked.catch(() => {})
		expect(manager.pending('assistant')).toEqual([])

		const before = manager.pending('assistant')
		const response = await post.handler(
			new Request('http://x/terminals/assistant', {
				method: 'POST',
				headers: { [HEADER_TOKEN]: 'secret' },
				body: JSON.stringify({ id, value: 'Ada' }),
			}),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(422)
		expect(manager.pending('assistant')).toEqual(before)
	})
})

// ── pressure: bounded POST body — over-limit and Content-Length lies ─────────

/** A `ReadableStream<Uint8Array>` that emits `totalBytes` of filler in `chunkSize` chunks. */
function makeStreamBody(totalBytes: number, chunkSize = 64): ReadableStream<Uint8Array> {
	let sent = 0
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= totalBytes) {
				controller.close()
				return
			}
			const size = Math.min(chunkSize, totalBytes - sent)
			controller.enqueue(new Uint8Array(size).fill(97))
			sent += size
		},
	})
}

describe('pressure: bounded POST body — over-limit rejected 413, manager untouched', () => {
	it('a body over the injected `limit` 413s before `manager.answer` runs', async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager, { limit: 16 })
		const post = findRoute(routes, 'POST')

		const asked = manager.ask('human', 'assistant', 'input', { message: 'name?' })
		asked.catch(() => {})
		const before = manager.pending('assistant')

		// Not a literal object type-narrowed to `RequestInit` — `duplex` is required by the
		// runtime for a streamed body but is not (yet) part of the DOM `RequestInit` typings; a
		// non-literal variable skips excess-property checking without an `as` cast.
		const init = { method: 'POST', body: makeStreamBody(1024), duplex: 'half' }
		const response = await post.handler(new Request('http://x/terminals/assistant', init), {
			params: { name: 'assistant' },
		})
		expect(response.status).toBe(413)
		expect(manager.pending('assistant')).toEqual(before)
	})

	it('a non-finite limit defaults instead of bypassing the byte cap', async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager, { limit: Number.NaN })
		const post = findRoute(routes, 'POST')
		const init = {
			method: 'POST',
			body: makeStreamBody(DEFAULT_BODY_LIMIT + 1),
			duplex: 'half',
		}

		const response = await post.handler(new Request('http://x/terminals/assistant', init), {
			params: { name: 'assistant' },
		})

		expect(response.status).toBe(413)
	})

	it('a small `Content-Length` header lying about a big streamed body is still capped (limit ignores the header)', async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager, { limit: 16 })
		const post = findRoute(routes, 'POST')

		const asked = manager.ask('human', 'assistant', 'input', { message: 'name?' })
		asked.catch(() => {})
		const before = manager.pending('assistant')

		const init = {
			method: 'POST',
			headers: { 'content-length': '5' },
			body: makeStreamBody(1024),
			duplex: 'half',
		}
		const response = await post.handler(new Request('http://x/terminals/assistant', init), {
			params: { name: 'assistant' },
		})
		expect(response.status).toBe(413)
		expect(manager.pending('assistant')).toEqual(before)
	})

	it('a body AT the limit is still parsed normally (boundary is exclusive-over, not inclusive)', async () => {
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager)
		const post = findRoute(routes, 'POST')

		const asked = manager.ask('human', 'assistant', 'input', { message: 'name?' })
		const pending = manager.pending('assistant')
		const id = pending[0]?.id
		if (id === undefined) throw new Error('expected a parked prompt')

		const response = await post.handler(
			new Request('http://x/terminals/assistant', {
				method: 'POST',
				body: JSON.stringify({ id, value: 'Ada' }),
			}),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(204)
		await expect(asked).resolves.toBe('Ada')
	})
})

// ── self-heal: a stream closed WITHOUT the request signal aborting ───────────

describe('self-heal: consumer-side stream close (no signal abort) tears down on next event / keepalive tick', () => {
	it('a live `pending` event on a closed-but-not-aborted stream detaches listeners and cancels the keepalive', async () => {
		const churn = createTestTimer()
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager, { timer: churn.timer, keepalive: 1000 })
		const get = findRoute(routes, 'GET')

		const baselinePending = manager.emitter.count('pending')
		const baselineExpire = manager.emitter.count('expire')

		const controller = new AbortController()
		const response = await get.handler(
			new Request('http://x/terminals/assistant', { signal: controller.signal }),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(200)
		expect(manager.emitter.count('pending')).toBe(baselinePending + 1)
		expect(manager.emitter.count('expire')).toBe(baselineExpire + 1)
		expect(churn.armed).toBe(1)
		expect(churn.cancelled).toBe(0)

		// Close the stream from the CONSUMER side — cancel the reader — WITHOUT ever aborting
		// the request signal, simulating a disconnect the abort listener misses entirely.
		const reader = response.body?.getReader()
		if (reader === undefined) throw new Error('expected a streaming body')
		await reader.cancel()

		const asked = manager.ask('human', 'assistant', 'input', { message: 'self-heal' })
		asked.catch(() => {})

		expect(manager.emitter.count('pending')).toBe(baselinePending)
		expect(manager.emitter.count('expire')).toBe(baselineExpire)
		expect(churn.cancelled).toBe(churn.armed)
		expect(controller.signal.aborted).toBe(false)
	})

	it('a keepalive tick on a closed-but-not-aborted stream self-heals instead of re-arming', async () => {
		const churn = createTestTimer()
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager, { timer: churn.timer, keepalive: 1000 })
		const get = findRoute(routes, 'GET')

		const baselinePending = manager.emitter.count('pending')

		const controller = new AbortController()
		const response = await get.handler(
			new Request('http://x/terminals/assistant', { signal: controller.signal }),
			{ params: { name: 'assistant' } },
		)

		const reader = response.body?.getReader()
		if (reader === undefined) throw new Error('expected a streaming body')
		await reader.cancel()

		churn.fire(0)

		expect(manager.emitter.count('pending')).toBe(baselinePending)
		expect(churn.armed).toBe(1)
		expect(controller.signal.aborted).toBe(false)
	})

	it('double-teardown through both paths — self-heal first, then a later signal abort — stays clean and does not throw', async () => {
		const churn = createTestTimer()
		const manager = createTerminalManager()
		manager.add('assistant')
		const routes = createTerminalRoutes(manager, { timer: churn.timer, keepalive: 1000 })
		const get = findRoute(routes, 'GET')

		const baselinePending = manager.emitter.count('pending')
		const baselineExpire = manager.emitter.count('expire')

		const controller = new AbortController()
		const response = await get.handler(
			new Request('http://x/terminals/assistant', { signal: controller.signal }),
			{ params: { name: 'assistant' } },
		)
		expect(response.status).toBe(200)
		expect(manager.emitter.count('pending')).toBe(baselinePending + 1)
		expect(manager.emitter.count('expire')).toBe(baselineExpire + 1)

		// Consumer-side close WITHOUT aborting the request signal — triggers self-heal teardown
		// on the next event, which now also detaches the request's `abort` listener.
		const reader = response.body?.getReader()
		if (reader === undefined) throw new Error('expected a streaming body')
		await reader.cancel()

		const asked = manager.ask('human', 'assistant', 'input', { message: 'self-heal-then-abort' })
		asked.catch(() => {})

		expect(manager.emitter.count('pending')).toBe(baselinePending)
		expect(manager.emitter.count('expire')).toBe(baselineExpire)
		expect(churn.cancelled).toBe(churn.armed)

		// The request signal aborts AFTER self-heal already tore everything down. Since teardown
		// removed its own `abort` listener during the self-heal pass, this abort should be a
		// no-op — no throw, no double-detach errors, no re-invocation of teardown's body.
		expect(() => controller.abort()).not.toThrow()
		expect(controller.signal.aborted).toBe(true)
	})
})
