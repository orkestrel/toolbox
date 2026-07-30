import { describe, it, expect, beforeEach } from 'vitest'
import { createWorkflowTool } from '@orkestrel/mcp'
import type { WorkflowToolInterface, WorkflowToolResult } from '@orkestrel/mcp'
import { createWorkflowsManager } from '@orkestrel/workflow'
import type { WorkflowsManagerInterface } from '@orkestrel/workflow'
import { validateSchema } from '../../setupServer.js'

let tool: WorkflowToolInterface
let manager: WorkflowsManagerInterface

beforeEach(() => {
	manager = createWorkflowsManager()
	tool = createWorkflowTool({
		name: 'workflow',
		summary: 'Test workflow',
		description: 'Test workflow tool',
		manager,
	})
})

function output(result: WorkflowToolResult): Record<string, unknown> {
	return result.output as Record<string, unknown>
}

describe('WorkflowTool', () => {
	// === Construction

	describe('construction', () => {
		it('creates with name and description', () => {
			expect(tool.name).toBe('workflow')
			expect(tool.summary).toBe('Test workflow')
			expect(tool.description).toBe('Test workflow tool')
		})

		it('exposes valid JSON Schema parameters', () => {
			const errors = validateSchema(tool.parameters)
			expect(errors).toEqual([])
		})

		it('stores is undefined when not provided', () => {
			expect(tool.stores).toBeUndefined()
		})
	})

	// === create

	describe('create', () => {
		it('creates an empty workflow', async () => {
			const result = await tool.execute({ operation: 'create', name: 'My Plan' })
			expect(result.ok).toBe(true)
			expect(result.operation).toBe('create')
			const out = output(result)
			expect(typeof out['workflowId']).toBe('string')
			expect(out['name']).toBe('My Plan')
			expect(out['status']).toBe('pending')
		})

		it('creates a workflow with phases and tasks', async () => {
			const result = await tool.execute({
				operation: 'create',
				name: 'Build App',
				description: 'Build a web app',
				phases: [
					{
						name: 'Design',
						description: 'Design phase',
						tasks: [
							{ name: 'Wireframes', description: 'Create wireframes' },
							{ name: 'Mockups', description: 'Create mockups' },
						],
					},
					{
						name: 'Implement',
						tasks: [{ name: 'Frontend' }, { name: 'Backend' }],
					},
				],
			})
			expect(result.ok).toBe(true)
			const out = output(result)
			const phases = out['phases'] as Record<string, unknown>[]
			expect(phases).toHaveLength(2)
			expect(phases[0]['name']).toBe('Design')
			const tasks = phases[0]['tasks'] as Record<string, unknown>[]
			expect(tasks).toHaveLength(2)
			expect(tasks[0]['name']).toBe('Wireframes')
			expect(tasks[0]['status']).toBe('pending')
		})

		it('creates a workflow with task metadata', async () => {
			const result = await tool.execute({
				operation: 'create',
				name: 'Test',
				phases: [
					{
						name: 'Phase 1',
						tasks: [
							{
								name: 'Task 1',
								metadata: { priority: 'high', tags: ['urgent'] },
							},
						],
					},
				],
			})
			expect(result.ok).toBe(true)
		})

		it('creates with default empty name', async () => {
			const result = await tool.execute({ operation: 'create' })
			expect(result.ok).toBe(true)
			expect(output(result)['name']).toBe('')
		})

		it('adds workflow to manager', async () => {
			await tool.execute({ operation: 'create', name: 'W1' })
			await tool.execute({ operation: 'create', name: 'W2' })
			expect(tool.workflows()).toHaveLength(2)
		})
	})

	// === status

	describe('status', () => {
		it('returns workflow status and progress', async () => {
			const create = await tool.execute({
				operation: 'create',
				name: 'Status Test',
				phases: [
					{
						name: 'P1',
						tasks: [{ name: 'T1' }, { name: 'T2' }],
					},
				],
			})
			const id = output(create)['workflowId'] as string

			const result = await tool.execute({ operation: 'status', id })
			expect(result.ok).toBe(true)
			expect(result.operation).toBe('status')
			const out = output(result)
			expect(out['workflowId']).toBe(id)
			expect(out['name']).toBe('Status Test')
			const progress = out['progress'] as Record<string, unknown>
			expect(progress['total']).toBe(2)
			expect(progress['pending']).toBe(2)
		})

		it('fails for non-existent workflow', async () => {
			const result = await tool.execute({ operation: 'status', id: 'nonexistent' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('not found')
		})

		it('fails without id', async () => {
			const result = await tool.execute({ operation: 'status' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('id')
		})
	})

	// === advance

	describe('advance', () => {
		async function createSimpleWorkflow(): Promise<string> {
			const create = await tool.execute({
				operation: 'create',
				name: 'Advance Test',
				phases: [
					{
						name: 'P1',
						tasks: [{ name: 'T1' }, { name: 'T2' }],
					},
				],
			})
			return output(create)['workflowId'] as string
		}

		function firstTaskId(result: WorkflowToolResult): string {
			const out = output(result)
			const phases = out['phases'] as Record<string, unknown>[]
			const tasks = phases[0]['tasks'] as Record<string, unknown>[]
			return tasks[0]['taskId'] as string
		}

		it('starts a task', async () => {
			const id = await createSimpleWorkflow()
			const status = await tool.execute({ operation: 'status', id })
			const taskId = firstTaskId(status)

			const result = await tool.execute({
				operation: 'advance',
				id,
				taskId,
				action: 'start',
			})
			expect(result.ok).toBe(true)
			expect(output(result)['status']).toBe('active')
		})

		it('completes a task', async () => {
			const id = await createSimpleWorkflow()
			const status = await tool.execute({ operation: 'status', id })
			const taskId = firstTaskId(status)

			await tool.execute({ operation: 'advance', id, taskId, action: 'start' })
			const result = await tool.execute({
				operation: 'advance',
				id,
				taskId,
				action: 'complete',
				value: 'done!',
			})
			expect(result.ok).toBe(true)
			expect(output(result)['status']).toBe('done')
		})

		it('skips a task', async () => {
			const id = await createSimpleWorkflow()
			const status = await tool.execute({ operation: 'status', id })
			const taskId = firstTaskId(status)

			const result = await tool.execute({
				operation: 'advance',
				id,
				taskId,
				action: 'skip',
			})
			expect(result.ok).toBe(true)
			expect(output(result)['status']).toBe('skipped')
		})

		it('blocks a task with reason', async () => {
			const id = await createSimpleWorkflow()
			const status = await tool.execute({ operation: 'status', id })
			const taskId = firstTaskId(status)

			await tool.execute({ operation: 'advance', id, taskId, action: 'start' })
			const result = await tool.execute({
				operation: 'advance',
				id,
				taskId,
				action: 'block',
				error: 'Need clarification',
			})
			expect(result.ok).toBe(true)
			expect(output(result)['status']).toBe('blocked')
		})

		it('unblocks a blocked task', async () => {
			const id = await createSimpleWorkflow()
			const status = await tool.execute({ operation: 'status', id })
			const taskId = firstTaskId(status)

			await tool.execute({ operation: 'advance', id, taskId, action: 'start' })
			await tool.execute({
				operation: 'advance',
				id,
				taskId,
				action: 'block',
				error: 'Blocked',
			})
			const result = await tool.execute({
				operation: 'advance',
				id,
				taskId,
				action: 'unblock',
			})
			expect(result.ok).toBe(true)
			expect(output(result)['status']).toBe('pending')
		})

		it('fails a task with error', async () => {
			const id = await createSimpleWorkflow()
			const status = await tool.execute({ operation: 'status', id })
			const taskId = firstTaskId(status)

			await tool.execute({ operation: 'advance', id, taskId, action: 'start' })
			const result = await tool.execute({
				operation: 'advance',
				id,
				taskId,
				action: 'fail',
				error: 'Crashed',
			})
			expect(result.ok).toBe(true)
			expect(output(result)['status']).toBe('error')
		})

		it('pauses and resumes a task', async () => {
			const id = await createSimpleWorkflow()
			const status = await tool.execute({ operation: 'status', id })
			const taskId = firstTaskId(status)

			await tool.execute({ operation: 'advance', id, taskId, action: 'start' })
			const paused = await tool.execute({
				operation: 'advance',
				id,
				taskId,
				action: 'pause',
			})
			expect(output(paused)['status']).toBe('paused')

			const resumed = await tool.execute({
				operation: 'advance',
				id,
				taskId,
				action: 'resume',
			})
			expect(output(resumed)['status']).toBe('active')
		})

		it('fails for non-existent task', async () => {
			const id = await createSimpleWorkflow()
			const result = await tool.execute({
				operation: 'advance',
				id,
				taskId: 'fake',
				action: 'start',
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('not found')
		})

		it('fails for unknown action', async () => {
			const id = await createSimpleWorkflow()
			const status = await tool.execute({ operation: 'status', id })
			const taskId = firstTaskId(status)

			const result = await tool.execute({
				operation: 'advance',
				id,
				taskId,
				action: 'explode',
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Unknown action')
		})

		it('fails without taskId', async () => {
			const id = await createSimpleWorkflow()
			const result = await tool.execute({
				operation: 'advance',
				id,
				action: 'start',
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('taskId')
		})

		it('fails without action', async () => {
			const id = await createSimpleWorkflow()
			const status = await tool.execute({ operation: 'status', id })
			const taskId = firstTaskId(status)

			const result = await tool.execute({
				operation: 'advance',
				id,
				taskId,
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('action')
		})

		it('fails block without error message', async () => {
			const id = await createSimpleWorkflow()
			const status = await tool.execute({ operation: 'status', id })
			const taskId = firstTaskId(status)

			await tool.execute({ operation: 'advance', id, taskId, action: 'start' })
			const result = await tool.execute({
				operation: 'advance',
				id,
				taskId,
				action: 'block',
			})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('error')
		})
	})

	// === snapshot

	describe('snapshot', () => {
		it('creates a snapshot of a workflow', async () => {
			const create = await tool.execute({
				operation: 'create',
				name: 'Snap Test',
				phases: [{ name: 'P1', tasks: [{ name: 'T1' }] }],
			})
			const id = output(create)['workflowId'] as string

			const result = await tool.execute({ operation: 'snapshot', id })
			expect(result.ok).toBe(true)
			expect(result.operation).toBe('snapshot')
			expect(output(result)['workflowId']).toBe(id)
			expect(output(result)['persisted']).toBe(false)
		})

		it('stores snapshot in memory for later restore', async () => {
			const create = await tool.execute({
				operation: 'create',
				name: 'Snap Test',
				phases: [{ name: 'P1', tasks: [{ name: 'T1' }] }],
			})
			const id = output(create)['workflowId'] as string

			await tool.execute({ operation: 'snapshot', id })
			expect(tool.snapshots()).toContain(id)
		})
	})

	// === restore

	describe('restore', () => {
		it('restores a workflow from a saved snapshot id', async () => {
			const create = await tool.execute({
				operation: 'create',
				name: 'Restore Test',
				phases: [{ name: 'P1', tasks: [{ name: 'T1' }] }],
			})
			const id = output(create)['workflowId'] as string

			// Advance a task
			const status = await tool.execute({ operation: 'status', id })
			const phases = output(status)['phases'] as Record<string, unknown>[]
			const taskId = (phases[0]['tasks'] as Record<string, unknown>[])[0]['taskId'] as string
			await tool.execute({ operation: 'advance', id, taskId, action: 'start' })
			await tool.execute({ operation: 'advance', id, taskId, action: 'complete', value: 42 })

			// Snapshot
			await tool.execute({ operation: 'snapshot', id })

			// Restore creates a workflow from the snapshot
			const result = await tool.execute({ operation: 'restore', snapshot: id })
			expect(result.ok).toBe(true)
			expect(result.operation).toBe('restore')
			expect(output(result)['workflowId']).toBe(id)
			expect(output(result)['name']).toBe('Restore Test')
		})

		it('restores a workflow from a full snapshot object', async () => {
			const snapshot = {
				workflowId: 'wf-inline',
				name: 'Inline',
				description: '',
				status: 'pending',
				phases: [
					{
						phaseId: 'p-1',
						name: 'Phase 1',
						description: '',
						status: 'pending',
						tasks: [
							{
								taskId: 't-1',
								name: 'Task 1',
								description: '',
								status: 'pending',
								result: undefined,
								metadata: {},
							},
						],
					},
				],
				created: Date.now(),
				updated: Date.now(),
			}

			const result = await tool.execute({ operation: 'restore', snapshot })
			expect(result.ok).toBe(true)
			expect(output(result)['workflowId']).toBe('wf-inline')
		})

		it('fails for non-existent snapshot id', async () => {
			const result = await tool.execute({ operation: 'restore', snapshot: 'nonexistent' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('not found')
		})

		it('fails without snapshot', async () => {
			const result = await tool.execute({ operation: 'restore' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('snapshot')
		})
	})

	// === list

	describe('list', () => {
		it('lists active workflows and saved snapshots', async () => {
			const result = await tool.execute({ operation: 'list' })
			expect(result.ok).toBe(true)
			expect(result.operation).toBe('list')
			expect(output(result)['count']).toBe(0)
			expect(output(result)['savedCount']).toBe(0)
		})

		it('lists created workflows', async () => {
			await tool.execute({ operation: 'create', name: 'W1' })
			await tool.execute({ operation: 'create', name: 'W2' })

			const result = await tool.execute({ operation: 'list' })
			expect(result.ok).toBe(true)
			expect(output(result)['count']).toBe(2)
			const active = output(result)['active'] as Record<string, unknown>[]
			expect(active[0]['name']).toBe('W1')
			expect(active[1]['name']).toBe('W2')
		})

		it('includes saved snapshots in list', async () => {
			const create = await tool.execute({
				operation: 'create',
				name: 'Snap',
				phases: [{ name: 'P1', tasks: [{ name: 'T1' }] }],
			})
			const id = output(create)['workflowId'] as string
			await tool.execute({ operation: 'snapshot', id })

			const result = await tool.execute({ operation: 'list' })
			expect(output(result)['savedCount']).toBe(1)
			const saved = output(result)['saved'] as Record<string, unknown>[]
			expect(saved[0]['workflowId']).toBe(id)
		})
	})

	// === remove

	describe('remove', () => {
		it('removes a workflow by id', async () => {
			const create = await tool.execute({ operation: 'create', name: 'Remove Me' })
			const id = output(create)['workflowId'] as string

			const result = await tool.execute({ operation: 'remove', id })
			expect(result.ok).toBe(true)
			expect(result.operation).toBe('remove')

			expect(tool.workflow(id)).toBeUndefined()
		})

		it('fails for non-existent workflow', async () => {
			const result = await tool.execute({ operation: 'remove', id: 'nonexistent' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('not found')
		})

		it('fails without id', async () => {
			const result = await tool.execute({ operation: 'remove' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('id')
		})
	})

	// === Edge cases

	describe('edge cases', () => {
		it('fails for unknown operation', async () => {
			const result = await tool.execute({ operation: 'unknown' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('Unknown operation')
		})

		it('fails without operation', async () => {
			const result = await tool.execute({})
			expect(result.ok).toBe(false)
			expect(result.error).toContain('operation')
		})

		it('includes duration in all results', async () => {
			const result = await tool.execute({ operation: 'list' })
			expect(typeof result.duration).toBe('number')
			expect(result.duration).toBeGreaterThanOrEqual(0)
		})

		it('workflow accessor returns undefined for non-existent id', () => {
			expect(tool.workflow('nonexistent')).toBeUndefined()
		})

		it('workflows returns empty array initially', () => {
			expect(tool.workflows()).toHaveLength(0)
		})

		it('snapshots returns empty array initially', () => {
			expect(tool.snapshots()).toHaveLength(0)
		})
	})

	// === forget

	describe('forget', () => {
		it('forgets all snapshots', async () => {
			const create = await tool.execute({
				operation: 'create',
				name: 'Forget Test',
				phases: [{ name: 'P1', tasks: [{ name: 'T1' }] }],
			})
			const id = output(create)['workflowId'] as string
			await tool.execute({ operation: 'snapshot', id })

			expect(tool.snapshots()).toHaveLength(1)
			tool.forget()
			expect(tool.snapshots()).toHaveLength(0)
		})

		it('forgets a specific snapshot by id', async () => {
			const create = await tool.execute({
				operation: 'create',
				name: 'Forget One',
				phases: [{ name: 'P1', tasks: [{ name: 'T1' }] }],
			})
			const id = output(create)['workflowId'] as string
			await tool.execute({ operation: 'snapshot', id })

			expect(tool.forget(id)).toBe(true)
			expect(tool.snapshots()).toHaveLength(0)
		})

		it('returns false for non-existent snapshot', () => {
			expect(tool.forget('nonexistent')).toBe(false)
		})
	})

	// === init

	describe('init', () => {
		it('completes without stores', async () => {
			await expect(tool.init()).resolves.toBeUndefined()
		})
	})

	// === onBlocked bridge

	describe('onBlocked', () => {
		it('fires onBlocked when a task is blocked via advance', async () => {
			const blocked: { error: string; taskId: string }[] = []

			const blockedManager = createWorkflowsManager()
			const blockedTool = createWorkflowTool({
				name: 'workflow',
				summary: 'test',
				description: 'test',
				manager: blockedManager,
				onBlocked(result, task) {
					blocked.push({
						error: result.error ?? '',
						taskId: task.context.taskId,
					})
				},
			})

			const create = await blockedTool.execute({
				operation: 'create',
				name: 'Block Test',
				phases: [{ name: 'P1', tasks: [{ name: 'T1' }] }],
			})

			const out = output(create)
			const phases = out['phases'] as Record<string, unknown>[]
			const tasks = phases[0]?.['tasks'] as Record<string, unknown>[]
			const taskId = tasks[0]?.['taskId'] as string
			const workflowId = out['workflowId'] as string

			await blockedTool.execute({
				operation: 'advance',
				id: workflowId,
				taskId,
				action: 'block',
				error: 'Need input',
			})

			expect(blocked).toHaveLength(1)
			expect(blocked[0]?.error).toBe('Need input')
			expect(blocked[0]?.taskId).toBe(taskId)
		})

		it('does not fire onBlocked for non-block actions', async () => {
			const blocked: string[] = []

			const blockedManager = createWorkflowsManager()
			const blockedTool = createWorkflowTool({
				name: 'workflow',
				summary: 'test',
				description: 'test',
				manager: blockedManager,
				onBlocked() {
					blocked.push('blocked')
				},
			})

			const create = await blockedTool.execute({
				operation: 'create',
				name: 'No Block',
				phases: [{ name: 'P1', tasks: [{ name: 'T1' }] }],
			})

			const out = output(create)
			const phases = out['phases'] as Record<string, unknown>[]
			const tasks = phases[0]?.['tasks'] as Record<string, unknown>[]
			const taskId = tasks[0]?.['taskId'] as string
			const workflowId = out['workflowId'] as string

			await blockedTool.execute({
				operation: 'advance',
				id: workflowId,
				taskId,
				action: 'start',
			})

			await blockedTool.execute({
				operation: 'advance',
				id: workflowId,
				taskId,
				action: 'complete',
				value: 'done',
			})

			expect(blocked).toHaveLength(0)
		})

		it('fires onBlocked for tasks in restored workflows', async () => {
			const blocked: string[] = []

			// Create a workflow and snapshot it
			const srcManager = createWorkflowsManager()
			const srcTool = createWorkflowTool({
				name: 'workflow',
				summary: 'test',
				description: 'test',
				manager: srcManager,
			})

			const create = await srcTool.execute({
				operation: 'create',
				name: 'Restore Block',
				phases: [{ name: 'P1', tasks: [{ name: 'T1' }, { name: 'T2' }] }],
			})

			const out = output(create)
			const workflowId = out['workflowId'] as string
			const phases = out['phases'] as Record<string, unknown>[]
			const tasks = phases[0]?.['tasks'] as Record<string, unknown>[]
			const t1Id = tasks[0]?.['taskId'] as string

			// Complete T1, snapshot
			await srcTool.execute({
				operation: 'advance',
				id: workflowId,
				taskId: t1Id,
				action: 'complete',
				value: 'done',
			})

			const snapResult = await srcTool.execute({
				operation: 'snapshot',
				id: workflowId,
			})
			expect(snapResult.ok).toBe(true)

			// Get the snapshot object from the source manager
			const srcWorkflow = srcManager.workflow(workflowId)
			const snapshot = srcWorkflow?.snapshot()

			// Restore into a new tool with onBlocked
			const dstManager = createWorkflowsManager()
			const dstTool = createWorkflowTool({
				name: 'workflow',
				summary: 'test',
				description: 'test',
				manager: dstManager,
				onBlocked(result) {
					blocked.push(result.error ?? '')
				},
			})

			const restoreResult = await dstTool.execute({
				operation: 'restore',
				snapshot,
			})
			expect(restoreResult.ok).toBe(true)

			// T2 should be pending in the restored workflow — block it
			const restoredOut = output(restoreResult)
			const restoredId = restoredOut['workflowId'] as string

			// Find T2 in the restored workflow
			const restoredWorkflow = dstManager.workflow(restoredId)
			const t2 = restoredWorkflow?.phases.phases()[0]?.tasks.tasks()[1]
			const t2Id = t2?.context.taskId

			expect(t2Id).toBeDefined()

			await dstTool.execute({
				operation: 'advance',
				id: restoredId,
				taskId: t2Id,
				action: 'block',
				error: 'Needs guidance',
			})

			expect(blocked).toHaveLength(1)
			expect(blocked[0]).toBe('Needs guidance')
		})
	})
})
