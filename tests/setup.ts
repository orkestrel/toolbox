import type {
	AgentInterface,
	AgentResult,
	Message,
	ProviderDelta,
	ProviderInterface,
	ProviderResult,
} from '@orkestrel/agent'
import type { DatabaseInterface } from '@orkestrel/database'
import type { DatabaseDefinition } from '@src/core'
import type { JSONRecord } from '@orkestrel/contract'
import type {
	TaskControllerInterface,
	WorkflowSnapshot,
	WorkflowStoreInterface,
} from '@orkestrel/workflow'
import { createAgent, ProviderAbortError } from '@orkestrel/agent'
import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import { createWorkflowRunner } from '@orkestrel/workflow'
import { waitForDelay } from '@orkestrel/test'

/**
 * Create an empty live memory database for core integration tests.
 *
 * @returns A live database backed by the real memory driver
 */
export function createTestDatabase(): DatabaseInterface {
	return createDatabase({
		driver: createMemoryDriver(),
		tables: {},
	})
}

/**
 * Build the ONE full {@link DatabaseDefinition} fixture the definition-store twins both assert
 * against — mixed column forms, a `primary` map, single- and multi-column `indexes`, and a
 * non-integer `version`, so a round-trip proves every field survives rather than only the flat
 * ones (AGENTS §16.1 — one shared data builder, not a per-file hand-roll).
 *
 * @param id - The definition id; defaults to `shop`
 * @returns A complete definition with every optional field populated
 */
export function createTestDefinition(id = 'shop'): DatabaseDefinition {
	return {
		id,
		driver: 'memory',
		tables: {
			items: {
				columns: {
					id: 'string',
					price: { type: 'number', optional: true },
					name: 'string',
				},
			},
		},
		primary: { items: 'id' },
		indexes: { items: [['name'], ['name', 'price']] },
		version: 3.5,
	}
}

/** Options for a live workflow task controller captured mid-run. */
export interface TestTaskControllerOptions {
	readonly signal?: AbortSignal
	readonly input?: JSONRecord
	readonly workflow?: string
	readonly task?: string
}

// The workflow package publishes `TaskControllerInterface` but not the class behind it, so a live
// handle comes from a real run: a one-task workflow whose behavior captures its own controller and
// parks. The run stays open — and the handle stays valid — until `releaseTestTaskControllers`
// settles every parked task, which each suite does after every test.
const releases: Array<() => void> = []

/**
 * Captures a live {@link TaskControllerInterface} from a real one-task workflow run.
 *
 * @remarks
 * The task parks after capture, so the returned handle keeps the non-aborted, owning state a
 * `WorkflowFunction` sees mid-run. `signal` folds into the controller's own signal through the
 * run's cancellation, `input` arrives as the task's metadata bag, and `workflow` / `task` name the
 * lineage `controller.task.phase.workflow.id` and `controller.task.id` report.
 *
 * @param options - Optional signal, input, and lineage identities
 * @returns The live controller of a parked task in a real run
 */
export async function createTestTaskController(
	options?: TestTaskControllerOptions,
): Promise<TaskControllerInterface> {
	const workflowId = options?.workflow ?? 'wf'
	const taskId = options?.task ?? 't'
	const captured = Promise.withResolvers<TaskControllerInterface>()
	const parked = Promise.withResolvers<null>()
	releases.push(() => parked.resolve(null))
	const run = createWorkflowRunner().execute(
		{
			id: workflowId,
			name: workflowId,
			phases: [{ id: 'p', name: 'P', tasks: [{ id: taskId, name: taskId, behavior: 'park' }] }],
		},
		{
			functions: {
				park: (controller) => {
					captured.resolve(controller)
					return parked.promise
				},
			},
			phases: { p: { tasks: { [taskId]: { metadata: options?.input ?? {} } } } },
			...(options?.signal === undefined ? {} : { signal: options.signal }),
		},
	)
	// A cancelled run settles through its result rather than a rejection, and no caller here reads
	// that result; the catch keeps an engine-level rejection from surfacing as an unhandled one.
	run.catch(() => {})
	return captured.promise
}

/** Settles every task parked by {@link createTestTaskController}, closing its run. */
export function releaseTestTaskControllers(): void {
	for (const release of releases) release()
	releases.length = 0
}

/** A protocol-faithful workflow store that records checkpoints and rejects a controlled prefix. */
export class RecordingWorkflowStore implements WorkflowStoreInterface {
	readonly #snapshots: WorkflowSnapshot[] = []
	readonly #failures: number
	#attempts = 0

	constructor(failures = 0) {
		this.#failures = failures
	}

	get snapshots(): readonly WorkflowSnapshot[] {
		return [...this.#snapshots]
	}

	get attempts(): number {
		return this.#attempts
	}

	async get(id: string): Promise<WorkflowSnapshot | undefined> {
		return this.#snapshots.findLast((snapshot) => snapshot.id === id)
	}

	async set(snapshot: WorkflowSnapshot): Promise<void> {
		this.#attempts += 1
		if (this.#attempts <= this.#failures) throw new Error('checkpoint refused')
		this.#snapshots.push(snapshot)
	}

	async delete(id: string): Promise<void> {
		for (let index = this.#snapshots.length - 1; index >= 0; index -= 1) {
			if (this.#snapshots[index]?.id === id) this.#snapshots.splice(index, 1)
		}
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

/** One recorded `generate` / `stream` call on a {@link ScriptedProvider}. */
export interface ScriptedCall {
	readonly messages: readonly Message[]
}

/**
 * Options for {@link ScriptedProvider} — every field optional.
 *
 * @remarks
 * `delay` pauses (ms) at the start of each call, letting a test observe an abort firing
 * mid-generate; defaults to `0`.
 */
export interface ScriptedProviderOptions {
	readonly delay?: number
	readonly failure?: Error
}

/**
 * A scripted {@link ProviderInterface} plus its `started` call count and recorded `calls` —
 * the minimal {@link ScriptedProvider} fixture exposes.
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
export class ScriptedProvider implements ScriptedProviderInterface {
	readonly id = 'scripted'
	readonly name = 'scripted'
	readonly #turns: readonly ProviderResult[]
	readonly #delay: number
	readonly #failure: Error | undefined
	readonly #calls: ScriptedCall[] = []
	#index = 0
	#started = 0

	constructor(turns: readonly ProviderResult[], options?: ScriptedProviderOptions) {
		this.#turns = turns
		this.#delay = options?.delay ?? 0
		this.#failure = options?.failure
	}

	get started(): number {
		return this.#started
	}

	get calls(): readonly ScriptedCall[] {
		return this.#calls
	}

	async *stream(
		messages: readonly Message[],
		signal: AbortSignal,
	): AsyncGenerator<ProviderDelta, ProviderResult> {
		this.#calls.push({ messages: [...messages] })
		this.#started += 1
		if (signal.aborted) throw new ProviderAbortError({ content: '' })
		if (this.#delay > 0) await waitForDelay(this.#delay)
		if (this.#failure !== undefined) throw this.#failure
		const turn = this.#turns[Math.min(this.#index, this.#turns.length - 1)] ?? { content: '' }
		this.#index += 1
		let streamed = ''
		for (const delta of [turn.content]) {
			if (signal.aborted) throw new ProviderAbortError({ content: streamed })
			streamed += delta
			if (delta.length > 0) yield { channel: 'content', text: delta }
		}
		if (signal.aborted) throw new ProviderAbortError({ content: streamed })
		return turn
	}

	async generate(messages: readonly Message[], signal: AbortSignal): Promise<ProviderResult> {
		const generator = this.stream(messages, signal)
		let step = await generator.next()
		while (!step.done) step = await generator.next()
		return step.value
	}
}

/** A structural agent boundary whose typed result is deliberately malformed at runtime. */
export class MalformedAgent implements AgentInterface {
	readonly #agent = createAgent(new ScriptedProvider([{ content: 'unused' }]))
	readonly id = 'malformed'

	get emitter(): AgentInterface['emitter'] {
		return this.#agent.emitter
	}

	get status(): AgentInterface['status'] {
		return this.#agent.status
	}

	get context(): AgentInterface['context'] {
		return this.#agent.context
	}

	generate(): Promise<AgentResult> {
		const result: AgentResult = { content: 'valid-to-types', partial: false }
		Object.defineProperty(result, 'content', { enumerable: true, value: 7 })
		return Promise.resolve(result)
	}

	stream(options?: Parameters<AgentInterface['stream']>[0]): ReturnType<AgentInterface['stream']> {
		return this.#agent.stream(options)
	}

	abort(reason?: unknown): void {
		this.#agent.abort(reason)
	}
}
