import type {
	MessageInterface,
	ProviderDelta,
	ProviderInterface,
	ProviderResult,
} from '@orkestrel/agent'
import type { DatabaseInterface } from '@orkestrel/database'
import { ProviderAbortError } from '@orkestrel/agent'
import { createDatabase, createMemoryDriver, generateUUID } from '@orkestrel/database'

/**
 * Create an empty live memory database for core integration tests.
 *
 * @returns A live database backed by the real memory driver
 */
export function createTestDatabase(): DatabaseInterface {
	return createDatabase({
		driver: createMemoryDriver(),
		tables: {},
		key: generateUUID,
	})
}

/**
 * Resolve after `ms` milliseconds — the single shared delay helper (AGENTS §16.1),
 * for letting a real short timer elapse instead of inlining a `setTimeout` promise
 * per test.
 *
 * @param ms - Milliseconds to wait; defaults to `0` (a macrotask turn)
 * @returns A promise that resolves once the delay elapses
 */
export function waitForDelay(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Round-trip a value through `JSON.parse(JSON.stringify(...))`, returning the structurally
 * identical clone — the one shared form of the "driver-swap parity" check the store / snapshot
 * tests repeat (AGENTS §16.1). A JSON-backed store persists a snapshot AS JSON, so a
 * structurally-faithful, pure-JSON payload must survive the round-trip byte-for-byte; a test
 * asserts `roundTripJSON(snapshot)` deep-equals the original.
 *
 * @typeParam T - The value's type, preserved across the clone
 * @param value - The (JSON-serializable) value to round-trip
 * @returns A structurally identical deep clone of `value`
 */
export function roundTripJSON<T>(value: T): T {
	return JSON.parse(JSON.stringify(value))
}

/** A manually-settled promise — the `resolve` / `reject` lifted out of its executor. */
export interface TestGateInterface<T> {
	readonly promise: Promise<T>
	readonly resolve: (value: T) => void
	readonly reject: (error: unknown) => void
}

/**
 * Create a {@link TestGateInterface} — a deferred whose `promise` settles only when
 * the test calls `resolve` / `reject`. Lets a test gate a real handler on a signal it
 * controls, to prove ordering / concurrency / pause behaviour without racing wall-clock
 * timers (AGENTS §16.1).
 *
 * @typeParam T - The value the gate's `promise` resolves with
 * @returns A gate exposing its `promise` and its `resolve` / `reject`
 */
export function createGate<T = void>(): TestGateInterface<T> {
	let resolve: (value: T) => void = () => {}
	let reject: (error: unknown) => void = () => {}
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

/**
 * Drain an `AsyncIterable<T>` into an array — the assertion-friendly counterpart to a
 * streaming read (AGENTS §16.1).
 *
 * @typeParam T - The element type yielded by the iterable
 * @param iterable - The async source to consume to completion
 * @returns Every yielded value, in iteration order
 */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = []
	for await (const value of iterable) values.push(value)
	return values
}

// ── Call recorder (a real callback, not a mock) ──────────────────────────────
//
// AGENTS §16.1: when a test only needs to count calls or inspect arguments, use a
// recorder — a real listener that records every invocation — rather than a test-
// framework spy. `handler` is a genuine callback; `calls` is each invocation's
// argument tuple, in order.

/** A real call-recording callback over an argument tuple (AGENTS §16.1). */
export interface TestRecorderInterface<TArgs extends readonly unknown[]> {
	readonly calls: readonly TArgs[]
	readonly count: number
	readonly handler: (...args: TArgs) => void
	clear(): void
}

/**
 * Create a {@link TestRecorderInterface} — a real callback that records each
 * invocation's arguments, for asserting what fired and with what (AGENTS §16.1).
 *
 * @typeParam TArgs - The argument tuple the recorded handler receives
 * @returns A recorder whose `handler` records into `calls`
 */
export function createRecorder<TArgs extends readonly unknown[]>(): TestRecorderInterface<TArgs> {
	const calls: TArgs[] = []
	return {
		get calls() {
			return calls
		},
		get count() {
			return calls.length
		},
		handler(...args: TArgs) {
			calls.push(args)
		},
		clear() {
			calls.length = 0
		},
	}
}

// ── Scripted ProviderInterface (Ollama-free agent fixture) ───────────────────
//
// AGENTS §16.1: the ONE general scripted `ProviderInterface` the agent-touching tests in
// this package drive (createAgentFunction / createAgentTool). Trimmed from
// `@orkestrel/agent`'s own test fixture to the minimum this package's tests need — a real
// provider (NOT a mock of the agent): `stream` returns each turn's whole content as one
// delta and RETURNS the result, honouring `signal` so an abort mid-stream throws a
// `ProviderAbortError` carrying the accumulated partial (a genuine cancel-fold proof).

/** One recorded `generate` / `stream` call on a {@link createScriptedProvider}. */
export interface ScriptedCall {
	readonly messages: readonly MessageInterface[]
}

/**
 * Options for {@link createScriptedProvider} — every field optional.
 *
 * @remarks
 * `delay` pauses (ms) at the start of each call, letting a test observe an abort firing
 * mid-generate; defaults to `0`.
 */
export interface ScriptedProviderOptions {
	readonly delay?: number
}

/**
 * A scripted {@link ProviderInterface} plus its `started` call count and recorded `calls` —
 * the minimal fixture {@link createScriptedProvider} returns.
 */
export interface ScriptedProviderInterface extends ProviderInterface {
	/** How many `stream` calls have started in total. */
	readonly started: number
	/** Each call's `messages`, in order. */
	readonly calls: readonly ScriptedCall[]
}

/**
 * Create a trimmed scripted {@link ProviderInterface} for deterministic, Ollama-free agent
 * tests — each `generate` / `stream` call consumes the next `ProviderResult` (the last
 * repeats once the list is exhausted), streaming its whole content as ONE delta and
 * RETURNING the result. Honours `signal`: an already-aborted (or mid-stream aborted) signal
 * throws a `ProviderAbortError` carrying the accumulated partial, so a cancel threaded into
 * the agent commits a genuine partial (AGENTS §16.1 — one shared fixture, not a per-test
 * hand-roll).
 *
 * @param turns - The `ProviderResult`s to replay in order (the last repeats)
 * @param options - The {@link ScriptedProviderOptions} (all optional)
 * @returns A {@link ScriptedProviderInterface} (the provider + its recorders)
 */
export function createScriptedProvider(
	turns: readonly ProviderResult[],
	options?: ScriptedProviderOptions,
): ScriptedProviderInterface {
	const delay = options?.delay ?? 0
	const calls: ScriptedCall[] = []
	let index = 0
	let started = 0
	async function* stream(
		messages: readonly MessageInterface[],
		signal: AbortSignal,
	): AsyncGenerator<ProviderDelta, ProviderResult> {
		calls.push({ messages: [...messages] })
		started += 1
		if (signal.aborted) throw new ProviderAbortError({ content: '' })
		if (delay > 0) await waitForDelay(delay)
		const turn = turns[Math.min(index, turns.length - 1)] ?? { content: '' }
		index += 1
		let streamed = ''
		for (const delta of [turn.content]) {
			if (signal.aborted) throw new ProviderAbortError({ content: streamed })
			streamed += delta
			if (delta.length > 0) yield { type: 'content', text: delta }
		}
		if (signal.aborted) throw new ProviderAbortError({ content: streamed })
		return turn
	}
	return {
		id: 'scripted',
		name: 'scripted',
		get started() {
			return started
		},
		get calls() {
			return calls
		},
		stream,
		async generate(messages, signal) {
			const generator = stream(messages, signal)
			let step = await generator.next()
			while (!step.done) step = await generator.next()
			return step.value
		},
	}
}

/** Whether a repository-relative Vue SFC path belongs to the private browser application. */
export function isBrowserVuePath(path: string): boolean {
	const normalized = path.replaceAll('\\', '/')
	return normalized.startsWith('app/browser/')
}
