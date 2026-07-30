import type {
	MCPStoreManagerInterface,
	WorkflowOperation,
	WorkflowToolInput,
	WorkflowToolInterface,
	WorkflowToolResult,
} from '../types.js'
import type {
	TaskInterface,
	TaskResult,
	WorkflowInterface,
	WorkflowSnapshot,
} from '@orkestrel/workflow'
import type { WorkflowsManagerInterface } from '@orkestrel/workflow'
import { isRecord } from '@orkestrel/core'
import { WORKFLOW_TOOL_PARAMETERS } from '../constants.js'
import { sanitizeFilename } from '../helpers.js'

/**
 * Standard tool wrapping workflow operations for agent/MCP integration.
 *
 * @remarks
 * Manages declarative workflows via `WorkflowsManagerInterface`. The model
 * sends `{ operation, ...args }` and the tool routes to the correct method.
 *
 * Operations:
 * - `create` — build a workflow from a phase/task definition
 * - `status` — get progress and task statuses for a workflow
 * - `advance` — change a task's status (start, complete, skip, block, etc.)
 * - `snapshot` — serialize a workflow for persistence
 * - `restore` — rebuild a workflow from a saved snapshot
 * - `list` — list all active and saved workflows
 * - `remove` — remove a workflow
 */
export class WorkflowTool implements WorkflowToolInterface {
	readonly #name: string
	readonly #summary: string
	readonly #description: string
	readonly #manager: WorkflowsManagerInterface
	readonly #stores: MCPStoreManagerInterface | undefined
	readonly #onBlocked: ((result: TaskResult, task: TaskInterface) => void) | undefined
	readonly #snapshots: Map<string, WorkflowSnapshot> = new Map()

	constructor(input: WorkflowToolInput) {
		this.#name = input.name
		this.#summary = input.summary
		this.#description = input.description
		this.#manager = input.manager
		this.#stores = input.stores
		this.#onBlocked = input.onBlocked
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

	get parameters(): Record<string, unknown> {
		return WORKFLOW_TOOL_PARAMETERS
	}

	get stores(): MCPStoreManagerInterface | undefined {
		return this.#stores
	}

	async execute(args: Readonly<Record<string, unknown>>): Promise<WorkflowToolResult> {
		const start = performance.now()
		const operation = args['operation']

		if (typeof operation !== 'string') {
			return this.#fail('create', 'Missing or invalid operation', start)
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
				default:
					return this.#fail(operation, `Unknown operation: ${operation}`, start)
			}
		} catch (thrown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown)
			return this.#fail(this.#toOperation(operation), message, start)
		}
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

	// === Operation handlers

	#handleCreate(args: Readonly<Record<string, unknown>>, start: number): WorkflowToolResult {
		const name = typeof args['name'] === 'string' ? args['name'] : ''
		const description = typeof args['description'] === 'string' ? args['description'] : ''

		const workflow = this.#manager.append({
			name,
			description,
		})

		const rawPhases = args['phases']
		if (Array.isArray(rawPhases)) {
			for (const rawPhase of rawPhases) {
				if (!isRecord(rawPhase)) continue

				const phaseName = typeof rawPhase['name'] === 'string' ? rawPhase['name'] : ''
				const phaseDescription =
					typeof rawPhase['description'] === 'string' ? rawPhase['description'] : ''

				const phase = workflow.phases.append({
					name: phaseName,
					description: phaseDescription,
				})

				const rawTasks = rawPhase['tasks']
				if (Array.isArray(rawTasks)) {
					for (const rawTask of rawTasks) {
						if (!isRecord(rawTask)) continue

						const taskName = typeof rawTask['name'] === 'string' ? rawTask['name'] : ''
						const taskDescription =
							typeof rawTask['description'] === 'string' ? rawTask['description'] : ''
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

		this.#subscribeBlocked(workflow)

		return this.#ok(
			'create',
			{
				workflowId: workflow.context.workflowId,
				name: workflow.context.name,
				description: workflow.context.description,
				status: workflow.status,
				phases: workflow.phases.phases().map((p) => ({
					phaseId: p.context.phaseId,
					name: p.context.name,
					tasks: p.tasks.tasks().map((t) => ({
						taskId: t.context.taskId,
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

		// Find the task across all phases
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

		return this.#ok(
			'advance',
			{
				workflowId: workflow.context.workflowId,
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

		return this.#ok(
			'snapshot',
			{
				workflowId: snapshot.workflowId,
				persisted: this.#stores !== undefined,
			},
			start,
		)
	}

	async #handleRestore(
		args: Readonly<Record<string, unknown>>,
		start: number,
	): Promise<WorkflowToolResult> {
		const rawSnapshot = args['snapshot']

		let snapshot: WorkflowSnapshot | undefined

		// String → look up by id from saved snapshots
		if (typeof rawSnapshot === 'string') {
			snapshot = this.#snapshots.get(rawSnapshot)
			if (!snapshot) {
				// Try sanitized filename lookup
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

		this.#subscribeBlocked(workflow)

		return this.#ok(
			'restore',
			{
				workflowId: workflow.context.workflowId,
				name: workflow.context.name,
				status: workflow.status,
				progress: workflow.progress(),
			},
			start,
		)
	}

	#handleList(start: number): WorkflowToolResult {
		const active = this.#manager.workflows().map((wf) => ({
			workflowId: wf.context.workflowId,
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
			{
				active,
				saved,
				count: active.length,
				savedCount: saved.length,
			},
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

		return this.#ok(
			'remove',
			{
				id,
				removed: removed || snapshotRemoved,
			},
			start,
		)
	}

	// === Private helpers

	#requireString(args: Readonly<Record<string, unknown>>, key: string): string {
		const value = args[key]
		if (typeof value !== 'string') {
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

	#findTask(workflow: WorkflowInterface, taskId: string) {
		for (const phase of workflow.phases.phases()) {
			const task = phase.tasks.task(taskId)
			if (task) return task
		}
		return undefined
	}

	// Subscribe all tasks in a workflow to the onBlocked handler
	#subscribeBlocked(workflow: WorkflowInterface): void {
		if (!this.#onBlocked) return
		for (const phase of workflow.phases.phases()) {
			for (const task of phase.tasks.tasks()) {
				task.onBlocked((result) => {
					this.#onBlocked?.(result, task)
				})
			}
		}
	}

	#isWorkflowSnapshot(value: unknown): value is WorkflowSnapshot {
		if (!isRecord(value)) return false
		return (
			typeof value['workflowId'] === 'string' &&
			typeof value['name'] === 'string' &&
			typeof value['status'] === 'string' &&
			Array.isArray(value['phases']) &&
			typeof value['created'] === 'number' &&
			typeof value['updated'] === 'number'
		)
	}

	#ok(operation: WorkflowOperation, output: unknown, start: number): WorkflowToolResult {
		return {
			operation,
			ok: true,
			output,
			error: undefined,
			duration: performance.now() - start,
		}
	}

	#fail(operation: WorkflowOperation | string, message: string, start: number): WorkflowToolResult {
		return {
			operation: this.#toOperation(operation),
			ok: false,
			output: undefined,
			error: message,
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
		}
		return operations[value] ?? 'create'
	}
}
