import { createContract } from '@orkestrel/contract'
import {
	columnPrimitiveShape,
	columnSpecShape,
	tableSpecShape,
	primaryShape,
	indexesShape,
	definitionContract,
	isColumnPrimitive,
	isColumnSpec,
	isTableSpec,
	isPrimaryMap,
	isIndexMap,
	isDatabaseDefinition,
} from '@src/core'
import {
	isArray,
	isRecord,
	booleanShape,
	numberShape,
	stringShape,
	rawShape,
} from '@orkestrel/contract'
import type { FieldControl, FormSchema, FormValues } from '@orkestrel/form'
import type { RecorderInterface } from '@orkestrel/test'
import type { RelationManagerInterface } from '@orkestrel/relation'
import { belongsTo, createRelationManager, hasMany, hasThrough } from '@orkestrel/relation'
import { createToolManager, ToolManager } from '@orkestrel/tool'
import { WORKFLOW_TOOL_NAME, DatabaseDefinitionStore, createWorkspaceTool } from '@src/core'
import type {
	AgentInterface,
	AgentResult,
	AuthorityInterface,
	Message,
	ProviderDelta,
	ProviderInterface,
	ProviderResult,
} from '@orkestrel/agent'
import type {
	DatabaseInterface,
	TableInterface,
	DriverInterface,
	Key,
	OperationOptions,
} from '@orkestrel/database'
import type {
	createWorkflowTool,
	DatabaseDefinition,
	DatabaseDefinitionRow,
	DefinitionStoreInterface,
} from '@src/core'
import type { JSONRecord } from '@orkestrel/contract'
import type { TimerHandler, TerminalManagerInterface } from '@orkestrel/terminal'
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '@orkestrel/tool'
import type {
	WorkflowDefinition,
	WorkflowRegistry,
	TaskControllerInterface,
	WorkflowSnapshot,
	WorkflowStoreInterface,
} from '@orkestrel/workflow'
import { createAgent, createAuthority, createScope, ProviderAbortError } from '@orkestrel/agent'
import { createDatabase, createMemoryDriver, MemoryDriver } from '@orkestrel/database'
import { createWorkflowRunner } from '@orkestrel/workflow'
import type {
	FileInterface,
	WorkspaceInterface,
	WorkspaceManagerInterface,
} from '@orkestrel/workspace'
import { createBinaryContent, createFile, createTextContent } from '@orkestrel/workspace'
import { waitForDelay } from '@orkestrel/test'

/**
 * Creates an empty live memory database for core integration tests.
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
 * Builds the ONE full {@link DatabaseDefinition} fixture the definition-store twins both assert
 * against — mixed column forms, a `primary` map, single- and multi-column `indexes`, and a
 * non-integer `version`, so a round-trip proves every field survives rather than only the flat
 * ones (AGENTS' no-mocks rule — one shared data builder, not a per-file hand-roll).
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
					price: { primitive: 'number', optional: true },
					name: 'string',
				},
			},
		},
		primary: { items: 'id' },
		indexes: { items: [['name'], ['name', 'price']] },
		version: 3.5,
	}
}

/** Represents one value the definition guard and its shape must agree on. */
export interface DefinitionCase {
	readonly label: string
	readonly value: unknown
	readonly valid: boolean
}

/** Holds the values the definition guard and its shape are compared over, each with its verdict. */
export const DEFINITION_CASES: readonly DefinitionCase[] = Object.freeze([
	{ label: 'full', value: createTestDefinition(), valid: true },
	{ label: 'minimal', value: { id: 'a', driver: 'b', tables: {} }, valid: true },
	{
		label: 'null prototype',
		value: Object.assign(Object.create(null), { id: 'a', driver: 'b', tables: {} }),
		valid: true,
	},
	{ label: 'zero version', value: { id: 'a', driver: 'b', tables: {}, version: 0 }, valid: true },
	{
		label: 'negative version',
		value: { id: 'a', driver: 'b', tables: {}, version: -1 },
		valid: true,
	},
	{
		label: 'empty index list',
		value: { id: 'a', driver: 'b', tables: {}, indexes: { t: [] } },
		valid: true,
	},
	{
		label: 'object column',
		value: { id: 'a', driver: 'b', tables: { t: { columns: { c: { primitive: 'number' } } } } },
		valid: true,
	},
	{
		label: 'undeclared key',
		value: { id: 'a', driver: 'b', tables: {}, summary: 'x' },
		valid: false,
	},
	{ label: 'obsolete keys', value: { id: 'a', driver: 'b', tables: {}, keys: {} }, valid: false },
	{
		label: 'own undefined optional',
		value: { id: 'a', driver: 'b', tables: {}, version: undefined },
		valid: false,
	},
	{ label: 'empty id', value: { id: '', driver: 'b', tables: {} }, valid: false },
	{ label: 'empty driver', value: { id: 'a', driver: '', tables: {} }, valid: false },
	{ label: 'missing tables', value: { id: 'a', driver: 'b' }, valid: false },
	{
		label: 'table with no columns',
		value: { id: 'a', driver: 'b', tables: { t: {} } },
		valid: false,
	},
	{
		label: 'table with a stray key',
		value: { id: 'a', driver: 'b', tables: { t: { columns: {}, note: 'x' } } },
		valid: false,
	},
	{
		label: 'unknown primitive',
		value: { id: 'a', driver: 'b', tables: { t: { columns: { c: 'text' } } } },
		valid: false,
	},
	{
		label: 'column with a stray key',
		value: {
			id: 'a',
			driver: 'b',
			tables: { t: { columns: { c: { primitive: 'string', x: 1 } } } },
		},
		valid: false,
	},
	{
		label: 'empty primary',
		value: { id: 'a', driver: 'b', tables: {}, primary: { t: '' } },
		valid: false,
	},
	{
		label: 'empty index group',
		value: { id: 'a', driver: 'b', tables: {}, indexes: { t: [[]] } },
		valid: false,
	},
	{
		label: 'empty index column',
		value: { id: 'a', driver: 'b', tables: {}, indexes: { t: [['']] } },
		valid: false,
	},
	{
		label: 'NaN version',
		value: { id: 'a', driver: 'b', tables: {}, version: Number.NaN },
		valid: false,
	},
	{
		label: 'infinite version',
		value: { id: 'a', driver: 'b', tables: {}, version: Number.POSITIVE_INFINITY },
		valid: false,
	},
	{
		label: 'string version',
		value: { id: 'a', driver: 'b', tables: {}, version: '1' },
		valid: false,
	},
	{ label: 'null', value: null, valid: false },
	{ label: 'array', value: [], valid: false },
	{ label: 'string', value: 'shop', valid: false },
	{ label: 'date', value: new Date(0), valid: false },
])

/**
 * Creates the execution context an uncancelled direct `ToolInterface.execute` call receives.
 *
 * @remarks
 * `@orkestrel/tool` requires a `ToolContext` on every `execute` call, and a test that drives a tool
 * directly owns no cancellation to forward. Each call returns a fresh real `AbortController`
 * signal that nothing aborts, which is the state a handler reads while its caller is still waiting.
 * A test about cancellation builds its own context from the controller it aborts.
 *
 * @returns A context whose `signal` is a real, never-aborted abort signal
 */
export function createTestToolContext(): ToolContext {
	return { signal: new AbortController().signal }
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

/** Records checkpoints and rejects a controlled prefix, acting as a protocol-faithful workflow store. */
export class RecordingWorkflowStore implements WorkflowStoreInterface {
	#snapshots: WorkflowSnapshot[] = []
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
		this.#snapshots = this.#snapshots.filter((snapshot) => snapshot.id !== id)
	}
}

// ── Scripted ProviderInterface (Ollama-free agent fixture) ───────────────────
//
// AGENTS' no-mocks rule: the ONE general scripted `ProviderInterface` the agent-touching tests in
// this package drive (createAgentFunction / createAgentTool). Trimmed from
// `@orkestrel/agent`'s own test fixture to the minimum this package's tests need — a real
// provider (NOT a mock of the agent): `stream` returns each turn's whole content as one
// delta and RETURNS the result, honouring `signal` so an abort mid-stream throws a
// `ProviderAbortError` carrying the accumulated partial (a genuine cancel-fold proof).

/**
 * Represents one recorded `generate` or `stream` call on a {@link ScriptedProvider}: its messages
 * and the names of the tool definitions it carried, empty when it carried none.
 */
export interface ScriptedCall {
	readonly messages: readonly Message[]
	readonly tools: readonly string[]
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
 * Represents the minimal shape a {@link ScriptedProvider} fixture exposes — a scripted
 * {@link ProviderInterface} plus its `started` call count and recorded `calls`.
 */
export interface ScriptedProviderInterface extends ProviderInterface {
	/** How many `stream` calls have started in total. */
	readonly started: number
	/** Each call's `messages` and tool names, in order. */
	readonly calls: readonly ScriptedCall[]
}

/**
 * Creates a trimmed scripted {@link ProviderInterface} for deterministic, Ollama-free agent
 * tests — each `generate` / `stream` call consumes the next `ProviderResult` (the last
 * repeats once the list is exhausted), streaming its whole content as ONE delta and
 * RETURNING the result. Honours `signal`: an already-aborted (or mid-stream aborted) signal
 * throws a `ProviderAbortError` carrying the accumulated partial, so a cancel threaded into
 * the agent commits a genuine partial (AGENTS' no-mocks rule — one shared fixture, not a per-test
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
		tools?: readonly ToolDefinition[],
	): AsyncGenerator<ProviderDelta, ProviderResult> {
		this.#calls.push({
			messages: [...messages],
			tools: (tools ?? []).map((definition) => definition.name),
		})
		this.#started += 1
		if (signal.aborted) throw new ProviderAbortError({ content: '' })
		if (this.#delay > 0) await waitForDelay(this.#delay)
		if (this.#failure !== undefined) throw this.#failure
		const turn = this.#turns[Math.min(this.#index, this.#turns.length - 1)] ?? { content: '' }
		this.#index += 1
		const content = turn.content
		if (signal.aborted) throw new ProviderAbortError({ content: '' })
		if (content.length > 0) yield { channel: 'content', text: content }
		if (signal.aborted) throw new ProviderAbortError({ content })
		return turn
	}

	async generate(
		messages: readonly Message[],
		signal: AbortSignal,
		tools?: readonly ToolDefinition[],
	): Promise<ProviderResult> {
		const generator = this.stream(messages, signal, tools)
		while (true) {
			const step = await generator.next()
			if (step.done) return step.value
		}
	}
}

/**
 * Creates the authority a test agent that runs its bound tools needs, allowing every call.
 *
 * @returns An authority whose fallback allows each call
 */
export function createOpenAuthority(): AuthorityInterface {
	return createAuthority({ fallback: { zone: 'default', verdict: 'allow' } })
}

/** Implements a structural agent boundary whose typed result is deliberately malformed at runtime. */
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

/** Represents a controllable timer fixture with observable arm and cancellation counts. */
export interface TestTimerInterface {
	readonly timer: TimerHandler
	readonly armed: number
	readonly cancelled: number
	fire(index: number): void
}

/**
 * Creates a controllable timer fixture for an injected timer seam.
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
/** Owns a value changed by callbacks within one fixture's lifetime. */
export class ToolboxValue<T> {
	#value: T
	constructor(value: T) {
		this.#value = value
	}
	get value(): T {
		return this.#value
	}
	set value(value: T) {
		this.#value = value
	}
}

export function createNestedWorkflow(id = 'nested'): WorkflowDefinition {
	return {
		id,
		name: id,
		phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T' }] }],
	}
}

export function readToolboxSummary(
	value: unknown,
): { readonly status: string; readonly count: number } | undefined {
	if (!isRecord(value) || typeof value.status !== 'string' || typeof value.count !== 'number') {
		return undefined
	}
	return { status: value.status, count: value.count }
}

export function buildFormSchema(control: FieldControl, label: string): FormSchema {
	if (control === 'confirm') {
		return { fields: [{ control: 'confirm', name: 'value', label }] }
	}
	if (control === 'select' || control === 'checkbox') {
		return {
			fields: [
				{
					control,
					name: 'value',
					label,
					choices: [
						{ label: 'X', value: 'x' },
						{ label: 'Y', value: 'y' },
					],
				},
			],
		}
	}
	if (control === 'text') return { fields: [{ control: 'text', name: 'value', label }] }
	throw new Error(`unsupported test form control '${control}'`)
}

export function createAskCall(
	to: string,
	control: FieldControl,
	label: string,
): Readonly<Record<string, unknown>> {
	return { to, schema: buildFormSchema(control, label) }
}

export function buildWorkflowLineageFixture(depth: number): readonly string[] {
	return [
		'workflow:w0',
		...Array.from({ length: depth }, (_, index) => [
			`agent:a${index + 1}`,
			`workflow:w${index + 1}`,
		]).flat(),
	]
}

export function buildToolLineageFixture(depth: number): readonly string[] {
	if (depth === 0) return []
	return [
		'workflow:w0',
		...Array.from({ length: depth }, (_, index) =>
			index + 1 < depth
				? [`agent:a${index + 1}`, `workflow:w${index + 1}`]
				: [`agent:a${index + 1}`],
		).flat(),
	]
}

export function createWorkflowProviderCall(id: string, behavior: string): ProviderResult {
	return {
		content: '',
		tools: [
			{
				id: `call-${id}`,
				name: WORKFLOW_TOOL_NAME,
				arguments: {
					id,
					name: id,
					bail: true,
					phases: [
						{
							id: 'p',
							name: 'P',
							tasks: [{ id: 't', name: 'T', behavior }],
						},
					],
				},
			},
		],
	}
}

export async function readToolboxRejection(promise: Promise<unknown> | unknown): Promise<unknown> {
	try {
		await promise
		return undefined
	} catch (error) {
		return error
	}
}

export function executeThroughManager(
	tool: ReturnType<typeof createWorkflowTool>,
	args: Readonly<Record<string, unknown>> = { ...createNestedWorkflow('via-mgr') },
): Promise<ToolResult> {
	const manager = createToolManager()
	manager.add(tool)
	return manager.execute({ id: 'call-1', name: tool.name, arguments: args })
}

export function createItemTables(): Readonly<Record<string, unknown>> {
	return {
		items: {
			columns: {
				id: 'string',
				name: 'string',
				price: { primitive: 'number', optional: true },
				active: 'boolean',
			},
		},
	}
}

export function createItemRow(
	id: string,
	overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
	return { id, name: `item-${id}`, price: 10, active: true, ...overrides }
}

export function buildItemsHandle(): DatabaseInterface {
	return createDatabase({
		driver: createMemoryDriver(),
		tables: {
			items: {
				id: stringShape(),
				name: stringShape(),
				price: numberShape(),
				active: booleanShape(),
			},
		},
	})
}

/** Injects a fault on the second junction deletion while retaining real memory storage. */
export class JunctionFaultDriver extends MemoryDriver {
	readonly #fault: Error
	#removals = 0

	constructor(fault: Error) {
		super()
		this.#fault = fault
	}

	override delete(table: string, key: Key, options?: OperationOptions): Promise<boolean> {
		if (table === 'accountReps') {
			this.#removals += 1
			if (this.#removals === 2) throw this.#fault
		}
		return super.delete(table, key, options)
	}
}

export function buildRelationDatabase(
	name?: string,
	driver: DriverInterface = createMemoryDriver(),
): DatabaseInterface {
	return createDatabase({
		driver,
		...(name === undefined ? {} : { name }),
		tables: {
			accounts: { id: stringShape(), name: stringShape() },
			contacts: { id: stringShape(), name: stringShape(), accountId: stringShape() },
			reps: { id: stringShape(), name: stringShape() },
			accountReps: { id: stringShape(), accountId: stringShape(), repId: stringShape() },
		},
	})
}

export function buildRelationManager(
	database: DatabaseInterface = buildRelationDatabase(),
): RelationManagerInterface {
	return createRelationManager({
		storage: database,
		relations: {
			accounts: {
				contacts: hasMany('accountId'),
				reps: hasThrough('accountReps', 'accountId', 'repId', 'reps'),
			},
			contacts: { account: belongsTo('accountId', 'accounts') },
			reps: { accounts: hasThrough('accountReps', 'repId', 'accountId', 'accounts') },
		},
	})
}

export async function seedAccount(
	manager: RelationManagerInterface,
	id: string,
	name = `account-${id}`,
): Promise<void> {
	await manager.model('accounts').table.set({ id, name })
}

export async function seedContact(
	manager: RelationManagerInterface,
	id: string,
	accountId: string,
	name = `contact-${id}`,
): Promise<void> {
	await manager.model('contacts').table.set({ id, name, accountId })
}

export async function seedRep(
	manager: RelationManagerInterface,
	id: string,
	name = `rep-${id}`,
): Promise<void> {
	await manager.model('reps').table.set({ id, name })
}

export const revokedWorkflowArguments = Proxy.revocable<Record<string, unknown>>({}, {})
revokedWorkflowArguments.revoke()

export const throwingOwnKeysWorkflowArguments = new Proxy<Record<string, unknown>>(
	{},
	{
		ownKeys() {
			throw new Error('hostile ownKeys')
		},
	},
)

export const throwingGetWorkflowArguments = new Proxy<Record<string, unknown>>(
	{ steps: undefined },
	{
		get() {
			throw new Error('hostile get')
		},
	},
)

/** Creates the mutable registry whose construction snapshot the workflow tests inspect. */
export function createOpaqueLeafRegistry(): WorkflowRegistry {
	return { leaf: () => 'leaf' }
}
/** Keeps a shared real driver available to separately minted database handles. */
export function createSharedMemoryDrivers(
	driver: DriverInterface,
): Readonly<Record<string, () => DriverInterface>> {
	return { memory: () => driver }
}
/** Creates the reusable endpoint declaration used by strict and lenient parsing cases. */
export function createLookupEndpointDefinition() {
	return {
		name: 'lookupUser',
		description: 'Look up a user by id.',
		samples: [{ id: '1', name: 'Ada' }],
		execute: (args: Readonly<Record<string, unknown>>) => args,
	}
}
/** Reads the rejection of an operation, including a synchronous throw at invocation. */
export async function captureToolboxFailure(action: () => unknown): Promise<unknown> {
	try {
		await action()
		return undefined
	} catch (error) {
		return error
	}
}

export const TOOLBOX_TERMINALS = Array.from({ length: 10 }, (_, i) => `t${i}`)

/** Registers the terminal population used by the interleaved prompt proofs. */
export function buildTerminals(manager: TerminalManagerInterface): void {
	for (const name of TOOLBOX_TERMINALS) manager.add(name)
}

export type ToolboxAsk = {
	readonly from: string
	readonly to: string
	readonly control: FieldControl
	readonly values: FormValues
}

export function buildDatabaseStoreWithTable(): {
	readonly store: DefinitionStoreInterface
	readonly table: TableInterface<DatabaseDefinitionRow>
} {
	const columns = { id: stringShape(), definition: rawShape({}) }
	const database = createDatabase({
		driver: createMemoryDriver(),
		tables: { definitions: columns },
	})
	const table: TableInterface<DatabaseDefinitionRow> = database.table('definitions')
	return { store: new DatabaseDefinitionStore(table), table }
}

/**
 * Holds the operations the workspace tool's contract declares, in declaration order: the
 * `expected` list its refusal of an undeclared operation carries.
 */
export const WORKSPACE_TOOL_OPERATIONS: readonly string[] = Object.freeze([
	'read',
	'list',
	'has',
	'search',
	'replace',
	'write',
	'splice',
	'prepend',
	'append',
	'move',
	'remove',
])

/** Seeds a workspace with one text file and one binary PNG file for the `list` projection proofs. */
export function buildWorkspaceSeed(): readonly FileInterface[] {
	return [
		createFile({
			path: 'notes/orchard.md',
			content: createTextContent('# Orchard log\nApples picked: 40', 'markdown'),
		}),
		createFile({
			path: 'images/orchard.png',
			content: createBinaryContent('iVBORw0KGgo=', 'image/png'),
			state: 'modified',
		}),
	]
}

/** Builds structural guard implication cases. */
export function buildToolboxContractCases() {
	return [
		{
			name: 'column primitive',
			wire: createContract(columnPrimitiveShape),
			guard: isColumnPrimitive,
			positive: 'string',
			negative: 'date',
		},
		{
			name: 'column spec',
			wire: createContract(columnSpecShape),
			guard: isColumnSpec,
			positive: { primitive: 'integer', optional: true },
			negative: { primitive: 'date' },
		},
		{
			name: 'table spec',
			wire: createContract(tableSpecShape),
			guard: isTableSpec,
			positive: { users: { columns: { id: 'integer' } } },
			negative: { users: {} },
		},
		{
			name: 'primary',
			wire: createContract(primaryShape),
			guard: isPrimaryMap,
			positive: { users: 'id' },
			negative: { users: '' },
		},
		{
			name: 'indexes',
			wire: createContract(indexesShape),
			guard: isIndexMap,
			positive: { users: [['id']] },
			negative: { users: [[]] },
		},
		{
			name: 'definition',
			wire: definitionContract,
			guard: isDatabaseDefinition,
			positive: { id: 'shop', driver: 'memory', tables: {} },
			negative: { id: '', driver: 'memory', tables: {} },
		},
	].map((row) => ({
		...row,
		direction: (value: unknown) => !row.wire.is(value) || row.guard(value),
	}))
}

// ── Workspace desk: the workspace tool under an Agent caller ─────────────────

/** Holds the text each desk file carries, named for the proof that reads it. */
export const DESK_TEXT = Object.freeze({
	orders: 'Order 42 is paid.',
	returns: 'Return 7 is open.',
	ledger: 'Status: open.',
	drop: 'Drop me.',
	secret: 'Refund held. The vault code is 7731.',
	notes: 'Refund noted.',
	note: 'Refund approved.',
	closed: 'Status: closed.',
	written: 'Written by B.',
	code: '7731',
})

/** Holds the files the desk's `orders` workspace starts with, in insertion order. */
export const ORDERS_SEED: Readonly<Record<string, string>> = Object.freeze({
	'orders.txt': DESK_TEXT.orders,
	'ledger.txt': DESK_TEXT.ledger,
	'drop.txt': DESK_TEXT.drop,
})

/** Holds the files the desk's `returns` workspace starts with, in insertion order. */
export const RETURNS_SEED: Readonly<Record<string, string>> = Object.freeze({
	'returns.txt': DESK_TEXT.returns,
	'ledger.txt': DESK_TEXT.ledger,
	'drop.txt': DESK_TEXT.drop,
})

/** Holds a hidden file before a listed one, each holding `Refund`, for the files-list proofs. */
export const SECRET_SEED: Readonly<Record<string, string>> = Object.freeze({
	'secret.md': DESK_TEXT.secret,
	'notes.md': DESK_TEXT.notes,
})

/** Represents the desk: a registry holding `orders`, active, and `returns`. */
export interface WorkspaceDesk {
	readonly manager: WorkspaceManagerInterface
	readonly orders: WorkspaceInterface
	readonly returns: WorkspaceInterface
}

/** Represents the files each desk workspace starts with; each defaults to its desk seed. */
export interface WorkspaceDeskSeeds {
	readonly orders?: Readonly<Record<string, string>>
	readonly returns?: Readonly<Record<string, string>>
}

/**
 * Adds the desk to `manager`: `orders` first, so it is active, then `returns`, each written with
 * its seed in insertion order.
 *
 * @param manager - The registry the desk is added to, empty
 * @param seeds - The files each workspace starts with. Default: {@link ORDERS_SEED} and {@link RETURNS_SEED}
 * @returns The registry and its two workspaces
 */
export function seedWorkspaceDesk(
	manager: WorkspaceManagerInterface,
	seeds?: WorkspaceDeskSeeds,
): WorkspaceDesk {
	const orders = manager.add({ id: 'orders' })
	for (const [path, text] of Object.entries(seeds?.orders ?? ORDERS_SEED)) orders.write(path, text)
	const returns = manager.add({ id: 'returns' })
	for (const [path, text] of Object.entries(seeds?.returns ?? RETURNS_SEED)) {
		returns.write(path, text)
	}
	return { manager, orders, returns }
}

/** Collects each file of a workspace as its path mapped to its text, `null` for a binary file. */
export function collectWorkspaceText(
	workspace: WorkspaceInterface,
): Readonly<Record<string, string | null>> {
	return Object.fromEntries(
		workspace.files().map((file) => [file.path, workspace.read(file.path) ?? null]),
	)
}

/** Checks whether two file lists hold the same file values by identity, in order. */
export function matchesFileIdentity(
	left: readonly FileInterface[],
	right: readonly FileInterface[],
): boolean {
	return left.length === right.length && left.every((file, index) => file === right[index])
}

/**
 * Creates the context a direct workspace tool call receives from a caller: a never-aborted signal
 * and `caller`, which is always an own key, `undefined` included.
 *
 * @param caller - The value the context carries as `caller`
 * @returns The context
 */
export function createCallerToolContext(caller: unknown): ToolContext {
	return { signal: new AbortController().signal, caller }
}

/** Represents one workspace tool call on the desk's `returns`, its result, and the files after it. */
export interface DeskOperationCase {
	readonly args: Readonly<Record<string, unknown>>
	readonly result: unknown
	readonly files: Readonly<Record<string, string | null>>
}

/** Holds one call for each workspace tool operation on the desk's `returns`, in declaration order. */
export const DESK_OPERATIONS: readonly DeskOperationCase[] = Object.freeze([
	{
		args: { operation: 'read', path: 'returns.txt' },
		result: DESK_TEXT.returns,
		files: RETURNS_SEED,
	},
	{
		args: { operation: 'list' },
		result: [
			{ path: 'returns.txt', state: 'created', size: 17, lines: 1, kind: 'text' },
			{ path: 'ledger.txt', state: 'created', size: 13, lines: 1, kind: 'text' },
			{ path: 'drop.txt', state: 'created', size: 8, lines: 1, kind: 'text' },
		],
		files: RETURNS_SEED,
	},
	{ args: { operation: 'has', path: 'returns.txt' }, result: true, files: RETURNS_SEED },
	{
		args: { operation: 'search', query: 'Return 7' },
		result: [{ path: 'returns.txt', line: 1, column: 1, length: 8, content: DESK_TEXT.returns }],
		files: RETURNS_SEED,
	},
	{
		args: { operation: 'replace', query: 'open', replacement: 'closed' },
		result: { occurrences: 2, files: 2 },
		files: {
			'returns.txt': 'Return 7 is closed.',
			'ledger.txt': DESK_TEXT.closed,
			'drop.txt': DESK_TEXT.drop,
		},
	},
	{
		args: { operation: 'write', path: 'note.txt', content: DESK_TEXT.note },
		result: { path: 'note.txt', state: 'created' },
		files: { ...RETURNS_SEED, 'note.txt': DESK_TEXT.note },
	},
	{
		args: {
			operation: 'splice',
			path: 'returns.txt',
			content: '8',
			fromLine: 1,
			fromColumn: 8,
			toLine: 1,
			toColumn: 9,
		},
		result: { path: 'returns.txt', state: 'modified' },
		files: { ...RETURNS_SEED, 'returns.txt': 'Return 8 is open.' },
	},
	{
		args: { operation: 'prepend', path: 'returns.txt', content: '> ' },
		result: { path: 'returns.txt', state: 'modified' },
		files: { ...RETURNS_SEED, 'returns.txt': `> ${DESK_TEXT.returns}` },
	},
	{
		args: { operation: 'append', path: 'returns.txt', content: ' Refund held.' },
		result: { path: 'returns.txt', state: 'modified' },
		files: { ...RETURNS_SEED, 'returns.txt': `${DESK_TEXT.returns} Refund held.` },
	},
	{
		args: { operation: 'move', from: 'returns.txt', to: 'archive.txt' },
		result: { from: 'returns.txt', to: 'archive.txt', moved: true },
		files: {
			'ledger.txt': DESK_TEXT.ledger,
			'drop.txt': DESK_TEXT.drop,
			'archive.txt': DESK_TEXT.returns,
		},
	},
	{
		args: { operation: 'remove', path: 'drop.txt' },
		result: { path: 'drop.txt', removed: true },
		files: { 'returns.txt': DESK_TEXT.returns, 'ledger.txt': DESK_TEXT.ledger },
	},
])

/** Holds each path-named workspace tool call, its `path` the placeholder `PATH` a proof replaces. */
export const PATH_CALLS: ReadonlyArray<Readonly<Record<string, unknown>>> = Object.freeze([
	{ operation: 'read', path: 'PATH' },
	{ operation: 'has', path: 'PATH' },
	{ operation: 'write', path: 'PATH', content: DESK_TEXT.note },
	{
		operation: 'splice',
		path: 'PATH',
		content: 'x',
		fromLine: 1,
		fromColumn: 1,
		toLine: 1,
		toColumn: 1,
	},
	{ operation: 'prepend', path: 'PATH', content: '> ' },
	{ operation: 'append', path: 'PATH', content: '!' },
	{ operation: 'remove', path: 'PATH' },
])

/** Records the context each `execute` call carries, then runs the call on the real registry. */
export class RecordingToolManager extends ToolManager {
	readonly #contexts: Array<ToolContext | undefined> = []

	/** Each `execute` call's context, in call order. */
	get contexts(): ReadonlyArray<ToolContext | undefined> {
		return [...this.#contexts]
	}

	override execute(call: ToolCall, context?: ToolContext): Promise<ToolResult>
	override execute(
		calls: readonly ToolCall[],
		context?: ToolContext,
	): Promise<readonly ToolResult[]>
	override execute(
		input: ToolCall | readonly ToolCall[],
		context?: ToolContext,
	): Promise<ToolResult> | Promise<readonly ToolResult[]> {
		this.#contexts.push(context)
		return isArray<ToolCall>(input) ? super.execute(input, context) : super.execute(input, context)
	}
}

/** Represents a real agent over the desk, its scripted provider, and its recording tool registry. */
export interface AgentDesk extends WorkspaceDesk {
	readonly agent: AgentInterface
	readonly provider: ScriptedProvider
	readonly tools: RecordingToolManager
}

/**
 * Represents the options of {@link buildAgentDesk}.
 *
 * @remarks
 * `workspaces` and `files` are the scope's lists; `workspaces` defaults to both desk workspaces,
 * and an omitted `files` states no list. `seeds` defaults to the desk seeds.
 */
export interface AgentDeskOptions {
	readonly workspaces?: readonly string[]
	readonly files?: readonly string[]
	readonly seeds?: WorkspaceDeskSeeds
}

/**
 * Builds a real agent over the desk with the built-in `switch`, an open authority, and the real
 * workspace tool registered over the agent's own workspace registry.
 *
 * @param turns - The scripted provider's turns
 * @param options - The scope's lists and the desk seeds
 * @returns The agent, its provider and tool registry, and the desk
 */
export function buildAgentDesk(
	turns: readonly ProviderResult[],
	options?: AgentDeskOptions,
): AgentDesk {
	const provider = new ScriptedProvider(turns)
	const tools = new RecordingToolManager()
	const agent = createAgent(provider, {
		tools,
		builtins: ['switch'],
		authority: createOpenAuthority(),
		scope: createScope({
			name: 'desk',
			workspaces: options?.workspaces ?? ['orders', 'returns'],
			...(options?.files === undefined ? {} : { files: options.files }),
		}),
	})
	const desk = seedWorkspaceDesk(agent.context.workspaces, options?.seeds)
	tools.add(createWorkspaceTool({ manager: desk.manager }))
	return { ...desk, agent, provider, tools }
}

/** Renders a recorded provider call's message texts as one text, one message per line. */
export function renderRequestText(call: ScriptedCall | undefined): string {
	return (call?.messages ?? [])
		.map((message) => (typeof message.content === 'string' ? message.content : ''))
		.join('\n')
}

/** Creates a scripted provider turn that calls each named tool with its arguments, in order. */
export function createDeskTurn(
	...calls: ReadonlyArray<readonly [name: string, args: Readonly<Record<string, unknown>>]>
): ProviderResult {
	return {
		content: '',
		tools: calls.map(([name, args], index) => ({ id: `${name}-${index}`, name, arguments: args })),
	}
}

/** Collects every string reachable from a value through its own keys, key names included, to a depth. */
export function collectOwnStrings(value: unknown, depth: number): readonly string[] {
	if (typeof value === 'string') return [value]
	if (depth === 0 || value === null || typeof value !== 'object') return []
	return Reflect.ownKeys(value).flatMap((key) => [
		...(typeof key === 'string' ? [key] : []),
		...collectOwnStrings(Reflect.get(value, key), depth - 1),
	])
}

/**
 * Builds an Agent caller whose `files` getter records each read on `reads` and returns a list on the
 * first read and text on every later one.
 */
export function buildShiftingCaller(reads: RecorderInterface<readonly []>): object {
	return {
		workspace: undefined,
		get files() {
			reads.handler()
			return reads.calls.length === 1 ? ['notes.md'] : 'notes.md'
		},
	}
}

/**
 * Builds objects whose `workspace` key cannot be ruled out or whose keys or members cannot be read: a
 * throwing `files` getter, a throwing `ownKeys` trap, a throwing own-property trap over a target that
 * holds `workspace`, a throwing `has` trap, and a revoked `Proxy`.
 */
export function buildUnreadableCallers(workspace: WorkspaceInterface): readonly object[] {
	const revoked = Proxy.revocable({}, {})
	revoked.revoke()
	return [
		{
			workspace,
			get files() {
				throw new Error('unreadable')
			},
		},
		new Proxy(
			{ workspace, files: undefined },
			{
				ownKeys() {
					throw new Error('unreadable')
				},
			},
		),
		new Proxy(
			{ workspace, files: undefined },
			{
				getOwnPropertyDescriptor() {
					throw new Error('unreadable')
				},
			},
		),
		new Proxy(
			{},
			{
				has() {
					throw new Error('unreadable')
				},
			},
		),
		revoked.proxy,
	]
}

/**
 * Holds paths that resemble the listed `notes.md` and are other paths: a leading `./` and `../`, a
 * trailing slash, a leading space, a fullwidth letter, a combining accent, a longer path it
 * prefixes, other letter cases, and a path that walks back to it.
 */
export const LOOKALIKE_PATHS: readonly string[] = Object.freeze([
	'./notes.md',
	'../notes.md',
	'sub/../notes.md',
	'notes.md/',
	' notes.md',
	'ｎotes.md',
	'nótes.md',
	'notes.md.bak',
	'NOTES.md',
	'Notes.md',
])

/** Holds the listed `notes.md`, a hidden `secret.md`, and a file at each of {@link LOOKALIKE_PATHS}. */
export const LOOKALIKE_SEED: Readonly<Record<string, string>> = Object.freeze({
	...SECRET_SEED,
	...Object.fromEntries(LOOKALIKE_PATHS.map((path) => [path, `Lookalike at ${path}.`])),
})

/** Holds an Agent caller's members as own fields of a class instance, which `isRecord` refuses. */
export class CallerInstance {
	readonly workspace: WorkspaceInterface | undefined
	readonly files: readonly string[] | undefined

	constructor(workspace: WorkspaceInterface | undefined, files: readonly string[] | undefined) {
		this.workspace = workspace
		this.files = files
	}
}

/**
 * Builds callers that hold `workspace` and `files` only through their prototype: inherited data
 * members, and getters on the prototype.
 */
export function buildInheritedCallers(workspace: WorkspaceInterface): readonly object[] {
	return [
		Object.create({ workspace, files: ['returns.txt'] }),
		Object.create({
			get workspace() {
				return workspace
			},
			get files() {
				return undefined
			},
		}),
	]
}
