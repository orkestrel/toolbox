import type {
	EmitterInterface,
	JsonSchemaObject,
	MCPStoreManagerInterface,
	PhaseInterface,
	TaskInterface,
	TaskResult,
	WorkflowErrorCategory,
	WorkflowInterface,
	WorkflowManagerInterface,
	WorkflowOperation,
	WorkflowSnapshot,
	WorkflowToolEventMap,
	WorkflowToolInput,
	WorkflowToolInterface,
	WorkflowToolResult,
} from '../../types.js'
import {
	isRecord,
	isString,
	parseString,
	parseStringField,
	sanitizeFilename,
	WORKFLOW_TOOL_PARAMETERS,
} from '../../index.js'
import { Emitter } from '../../signals/Emitter.js'

/**
 * Standard tool wrapping workflow operations for agent/MCP integration.
 *
 * @remarks
 * Manages declarative workflows via `WorkflowManagerInterface`. The model
 * sends `{ operation, ...args }` and the tool routes to the correct method.
 */
export class WorkflowTool implements WorkflowToolInterface {
	readonly #emitter: Emitter<WorkflowToolEventMap>
	readonly #name: string
	readonly #summary: string
	readonly #description: string
	readonly #manager: WorkflowManagerInterface
	readonly #stores: MCPStoreManagerInterface | undefined
	readonly #snapshots: Map<string, WorkflowSnapshot> = new Map()

	constructor(input: WorkflowToolInput) {
		this.#emitter = new Emitter({ on: input.on })
		this.#name = input.name
		this.#summary = input.summary
		this.#description = input.description
		this.#manager = input.manager
		this.#stores = input.stores
	}

	get emitter(): EmitterInterface<WorkflowToolEventMap> {
		return this.#emitter
	}

	get name(): string {
		return this.#name
	}

	get summary(): string {
		return this.#summary
	}

	get description(): string {
		return this.#description
	}

	get parameters(): JsonSchemaObject {
		return WORKFLOW_TOOL_PARAMETERS
	}

	get stores(): MCPStoreManagerInterface | undefined {
		return this.#stores
	}

	async init(): Promise<void> {
		if (!this.#stores) return

		await this.#stores.load()

		for (const entry of this.#stores.entries()) {
			const data = entry.data
			if (this.#isWorkflowSnapshot(data)) {
				this.#snapshots.set(entry.id, data)
			}
		}
	}

	workflow(id: string): WorkflowInterface | undefined {
		return this.#manager.workflow(id)
	}

	workflows(): readonly WorkflowInterface[] {
		return this.#manager.workflows()
	}

	snapshots(): readonly string[] {
		return [...this.#snapshots.keys()]
	}

	forget(): void
	forget(id: string): boolean
	forget(idOrUndefined?: string): void | boolean {
		if (idOrUndefined === undefined) {
			this.#snapshots.clear()
			if (this.#stores) {
				for (const store of this.#stores.stores()) {
					if (store.writable) {
						for (const entry of this.#stores.entries()) {
							store.remove(entry.id)
						}
					}
				}
			}
			return
		}
		const found = this.#snapshots.delete(idOrUndefined)
		if (this.#stores) {
			const filename = sanitizeFilename(idOrUndefined)
			for (const store of this.#stores.stores()) {
				if (store.writable) {
					store.remove(filename)
				}
			}
		}
		return found
	}

	async execute(args: Readonly<Record<string, unknown>>): Promise<WorkflowToolResult> {
		const start = performance.now()

		// Batch support — if steps array is provided, execute sequentially
		const rawSteps = args['steps']
		if (Array.isArray(rawSteps)) {
			return this.#executeBatch(rawSteps, start)
		}

		const operation = parseString(args['operation'])

		if (operation === undefined) {
			return this.#fail('create', 'Missing or invalid operation', start, 'validation')
		}

		try {
			switch (operation) {
				case 'create':
					return this.#handleCreate(args, start)
				case 'status':
					return this.#handleStatus(args, start)
				case 'advance':
					return this.#handleAdvance(args, start)
				case 'snapshot':
					return await this.#handleSnapshot(args, start)
				case 'restore':
					return await this.#handleRestore(args, start)
				case 'list':
					return this.#handleList(start)
				case 'remove':
					return this.#handleRemove(args, start)
				case 'addPhase':
					return this.#handleAddPhase(args, start)
				case 'addTask':
					return this.#handleAddTask(args, start)
				default:
					return this.#fail(operation, `Unknown operation: ${operation}`, start, 'state')
			}
		} catch (thrown: unknown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown)
			const category = this.#categorizeError(thrown)
			return this.#fail(this.#toOperation(operation), message, start, category)
		}
	}

	#handleCreate(args: Readonly<Record<string, unknown>>, start: number): WorkflowToolResult {
		const name = parseStringField(args, 'name') ?? ''
		const description = parseStringField(args, 'description') ?? ''

		const workflow = this.#manager.append({ name, description })

		const rawPhases = args['phases']
		if (Array.isArray(rawPhases)) {
			for (const rawPhase of rawPhases) {
				if (!isRecord(rawPhase)) continue

				const phaseName = parseStringField(rawPhase, 'name') ?? ''
				const phaseDescription = parseStringField(rawPhase, 'description') ?? ''

				const phase = workflow.phases.append({ name: phaseName, description: phaseDescription })

				const rawTasks = rawPhase['tasks']
				if (Array.isArray(rawTasks)) {
					for (const rawTask of rawTasks) {
						if (!isRecord(rawTask)) continue
						const taskName = parseStringField(rawTask, 'name') ?? ''
						const taskDescription = parseStringField(rawTask, 'description') ?? ''
						const metadata: Record<string, unknown> = {}
						const rawMeta = rawTask['metadata']
						if (isRecord(rawMeta)) {
							for (const [key, value] of Object.entries(rawMeta)) {
								metadata[key] = value
							}
						}
						phase.tasks.append({
							name: taskName,
							description: taskDescription,
							metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
						})
					}
				}
			}
		}

		this.#trackWorkflow(workflow)
		this.#emitter.emit('create', workflow)

		return this.#ok(
			'create',
			{
				workflowId: workflow.context.id,
				name: workflow.context.name,
				description: workflow.context.description,
				status: workflow.status,
				phases: workflow.phases.phases().map((p) => ({
					phaseId: p.context.id,
					name: p.context.name,
					tasks: p.tasks.tasks().map((t) => ({
						taskId: t.context.id,
						name: t.context.name,
						status: t.status,
					})),
				})),
			},
			start,
		)
	}

	#handleStatus(args: Readonly<Record<string, unknown>>, start: number): WorkflowToolResult {
		const workflow = this.#requireWorkflow(args)
		const progress = workflow.progress()
		const snapshot = workflow.snapshot()

		return this.#ok(
			'status',
			{
				workflowId: snapshot.workflowId,
				name: snapshot.name,
				status: snapshot.status,
				progress,
				phases: snapshot.phases.map((p) => ({
					phaseId: p.phaseId,
					name: p.name,
					status: p.status,
					tasks: p.tasks.map((t) => ({
						taskId: t.taskId,
						name: t.name,
						status: t.status,
						result: t.result,
						metadata: t.metadata,
					})),
				})),
			},
			start,
		)
	}

	#handleAdvance(args: Readonly<Record<string, unknown>>, start: number): WorkflowToolResult {
		const workflow = this.#requireWorkflow(args)
		const taskId = this.#requireString(args, 'taskId')
		const action = this.#requireString(args, 'action')

		const task = this.#findTask(workflow, taskId)
		if (!task) {
			throw new Error(`Task not found: ${taskId}`)
		}

		switch (action) {
			case 'start':
				task.start()
				break
			case 'complete': {
				const value = args['value']
				task.complete(value)
				break
			}
			case 'skip':
				task.skip()
				break
			case 'block': {
				const error = this.#requireString(args, 'error')
				task.block(error)
				break
			}
			case 'unblock':
				task.unblock()
				break
			case 'fail': {
				const error = this.#requireString(args, 'error')
				task.fail(error)
				break
			}
			case 'pause':
				task.pause()
				break
			case 'resume':
				task.resume()
				break
			default:
				throw new Error(`Unknown action: ${action}`)
		}

		this.#emitter.emit('advance', task, action)

		return this.#ok(
			'advance',
			{
				workflowId: workflow.context.id,
				taskId,
				action,
				status: task.status,
				result: task.result,
			},
			start,
		)
	}

	async #handleSnapshot(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<WorkflowToolResult> {
		const workflow = this.#requireWorkflow(args)
		const snapshot = workflow.snapshot()

		this.#snapshots.set(snapshot.workflowId, snapshot)

		if (this.#stores) {
			const filename = sanitizeFilename(snapshot.workflowId)
			await this.#stores.write({
				id: filename,
				data: snapshot as unknown as Record<string, unknown>,
			})
		}

		this.#emitter.emit('snapshot', snapshot)

		return this.#ok(
			'snapshot',
			{ workflowId: snapshot.workflowId, persisted: this.#stores !== undefined },
			start,
		)
	}

	async #handleRestore(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<WorkflowToolResult> {
		const rawSnapshot = args['snapshot']
		let snapshot: WorkflowSnapshot | undefined

		if (typeof rawSnapshot === 'string') {
			snapshot = this.#snapshots.get(rawSnapshot)
			if (!snapshot) {
				for (const [key, value] of this.#snapshots) {
					if (sanitizeFilename(key) === rawSnapshot) {
						snapshot = value
						break
					}
				}
			}
			if (!snapshot) {
				throw new Error(`Snapshot not found: ${rawSnapshot}`)
			}
		} else if (isRecord(rawSnapshot) && this.#isWorkflowSnapshot(rawSnapshot)) {
			snapshot = rawSnapshot
		} else {
			throw new Error(
				'Missing or invalid snapshot — provide a snapshot id string or a full snapshot object',
			)
		}

		const workflow = this.#manager.restore(snapshot)
		this.#trackWorkflow(workflow)
		this.#emitter.emit('restore', workflow)

		return this.#ok(
			'restore',
			{
				workflowId: workflow.context.id,
				name: workflow.context.name,
				status: workflow.status,
				progress: workflow.progress(),
			},
			start,
		)
	}

	#handleList(start: number): WorkflowToolResult {
		const active = this.#manager.workflows().map((wf) => ({
			workflowId: wf.context.id,
			name: wf.context.name,
			status: wf.status,
			progress: wf.progress(),
		}))

		const saved = [...this.#snapshots.entries()].map(([id, snap]) => ({
			id,
			workflowId: snap.workflowId,
			name: snap.name,
			status: snap.status,
			created: snap.created,
			updated: snap.updated,
		}))

		return this.#ok(
			'list',
			{ active, saved, count: active.length, savedCount: saved.length },
			start,
		)
	}

	#handleRemove(args: Readonly<Record<string, unknown>>, start: number): WorkflowToolResult {
		const id = this.#requireString(args, 'id')

		const removed = this.#manager.remove(id)
		const snapshotRemoved = this.#snapshots.delete(id)

		if (this.#stores && snapshotRemoved) {
			const filename = sanitizeFilename(id)
			for (const store of this.#stores.stores()) {
				if (store.writable) {
					store.remove(filename)
				}
			}
		}

		if (!removed && !snapshotRemoved) {
			throw new Error(`Workflow not found: ${id}`)
		}

		this.#emitter.emit('remove', id)

		return this.#ok('remove', { id, removed: removed || snapshotRemoved }, start)
	}

	#handleAddPhase(args: Readonly<Record<string, unknown>>, start: number): WorkflowToolResult {
		const workflow = this.#requireWorkflow(args)
		const name = parseStringField(args, 'name') ?? ''
		const description = parseStringField(args, 'description') ?? ''

		const phase = workflow.phases.append({ name, description })

		// Tasks in the new phase are auto-tracked via the phase manager's add event
		// which was set up in #trackWorkflow

		const rawTasks = args['tasks']
		if (Array.isArray(rawTasks)) {
			for (const rawTask of rawTasks) {
				if (!isRecord(rawTask)) continue
				const metadata: Record<string, unknown> = {}
				const rawMeta = rawTask['metadata']
				if (isRecord(rawMeta)) {
					for (const [key, value] of Object.entries(rawMeta)) {
						metadata[key] = value
					}
				}
				phase.tasks.append({
					name: parseStringField(rawTask, 'name') ?? '',
					description: parseStringField(rawTask, 'description') ?? '',
					metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
				})
			}
		}

		return this.#ok(
			'addPhase',
			{
				workflowId: workflow.context.id,
				phaseId: phase.context.id,
				name: phase.context.name,
				tasks: phase.tasks.tasks().map((t) => ({
					taskId: t.context.id,
					name: t.context.name,
					status: t.status,
				})),
			},
			start,
		)
	}

	#handleAddTask(args: Readonly<Record<string, unknown>>, start: number): WorkflowToolResult {
		const workflow = this.#requireWorkflow(args)
		const phaseId = this.#requireString(args, 'phaseId')
		const phase = workflow.phases.phase(phaseId)
		if (!phase) {
			throw new Error(`Phase not found: ${phaseId}`)
		}

		const name = parseStringField(args, 'name') ?? ''
		const description = parseStringField(args, 'description') ?? ''
		const metadata: Record<string, unknown> = {}
		const rawMeta = args['metadata']
		if (isRecord(rawMeta)) {
			for (const [key, value] of Object.entries(rawMeta)) {
				metadata[key] = value
			}
		}

		const task = phase.tasks.append({
			name,
			description,
			metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
		})

		// Task is auto-tracked via the task manager's add event

		return this.#ok(
			'addTask',
			{
				workflowId: workflow.context.id,
				phaseId,
				taskId: task.context.id,
				name: task.context.name,
				status: task.status,
			},
			start,
		)
	}

	async #executeBatch(steps: readonly unknown[], start: number): Promise<WorkflowToolResult> {
		const results: WorkflowToolResult[] = []
		const total = steps.length

		for (let i = 0; i < total; i++) {
			const step = steps[i]
			if (!isRecord(step)) {
				results.push(this.#fail('batch', `Invalid step at index ${i}`, start, 'validation'))
				break
			}
			try {
				const result = await this.execute(step)
				results.push(result)
				if (!result.ok) break
			} catch (thrown: unknown) {
				results.push(this.#fail('batch', String(thrown), start, 'unknown'))
				break
			}
		}

		return this.#ok(
			'batch',
			{ results, completed: results.filter((r) => r.ok).length, total },
			start,
		)
	}

	// === Dynamic Task Subscription

	#trackWorkflow(workflow: WorkflowInterface): void {
		// Subscribe to existing phases
		for (const phase of workflow.phases.phases()) {
			this.#trackPhase(phase)
		}
		// Subscribe to future phases
		workflow.phases.emitter.on('add', (phase: PhaseInterface) => {
			this.#trackPhase(phase)
		})
	}

	#trackPhase(phase: PhaseInterface): void {
		// Subscribe to existing tasks
		for (const task of phase.tasks.tasks()) {
			this.#trackTask(task)
		}
		// Subscribe to future tasks
		phase.tasks.emitter.on('add', (task: TaskInterface) => {
			this.#trackTask(task)
		})
	}

	#trackTask(task: TaskInterface): void {
		task.emitter.on('block', (result: TaskResult) => {
			this.#emitter.emit('block', result, task)
		})
	}

	// === Private Helpers

	#requireString(args: Readonly<Record<string, unknown>>, key: string): string {
		const value = parseStringField(args, key)
		if (value === undefined) {
			throw new Error(`Missing or invalid '${key}' argument — expected string`)
		}
		return value
	}

	#requireWorkflow(args: Readonly<Record<string, unknown>>): WorkflowInterface {
		const id = this.#requireString(args, 'id')
		const workflow = this.#manager.workflow(id)
		if (!workflow) {
			throw new Error(`Workflow not found: ${id}`)
		}
		return workflow
	}

	#findTask(workflow: WorkflowInterface, taskId: string): TaskInterface | undefined {
		for (const phase of workflow.phases.phases()) {
			const task = phase.tasks.task(taskId)
			if (task) return task
		}
		return undefined
	}

	#isWorkflowSnapshot(value: unknown): value is WorkflowSnapshot {
		if (!isRecord(value)) return false
		return (
			isString(value['workflowId']) &&
			isString(value['name']) &&
			isString(value['status']) &&
			Array.isArray(value['phases']) &&
			typeof value['created'] === 'number' &&
			typeof value['updated'] === 'number'
		)
	}

	#categorizeError(error: unknown): WorkflowErrorCategory {
		if (!(error instanceof Error)) return 'unknown'
		const message = error.message.toLowerCase()
		if (message.includes('not found')) return 'not_found'
		if (message.includes('missing') || message.includes('invalid')) return 'validation'
		if (message.includes('unknown action') || message.includes('unknown operation')) return 'state'
		return 'unknown'
	}

	#ok(operation: WorkflowOperation, output: unknown, start: number): WorkflowToolResult {
		return {
			operation,
			ok: true,
			output,
			error: undefined,
			category: undefined,
			duration: performance.now() - start,
		}
	}

	#fail(
		operation: WorkflowOperation | string,
		message: string,
		start: number,
		category: WorkflowErrorCategory = 'unknown',
	): WorkflowToolResult {
		return {
			operation: this.#toOperation(operation),
			ok: false,
			output: undefined,
			error: message,
			category,
			duration: performance.now() - start,
		}
	}

	#toOperation(value: string): WorkflowOperation {
		const operations: Record<string, WorkflowOperation> = {
			create: 'create',
			status: 'status',
			advance: 'advance',
			snapshot: 'snapshot',
			restore: 'restore',
			list: 'list',
			remove: 'remove',
			addPhase: 'addPhase',
			addTask: 'addTask',
			batch: 'batch',
		}
		return operations[value] ?? 'create'
	}
}
