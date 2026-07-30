import type { AgentToolArguments } from '@src/core'
import type { ToolResult } from '@orkestrel/agent'
import type { WorkflowDraft } from '@src/core'
import type { DatabaseInterface } from '@orkestrel/database'
import type { TaskContext, TaskControllerInterface, WorkflowDefinition } from '@orkestrel/workflow'
import type { TerminalManagerInterface, TimerCancel, TimerHandler } from '@orkestrel/terminal'
import type { RelationManagerInterface } from '@orkestrel/relation'
import {
	buildToolResult,
	createAgent,
	createAgentRegistry,
	createMemoryConversationStore,
	createMemoryWorkspaceStore,
	createTool,
	createToolManager,
	createWorkspaceManager,
} from '@orkestrel/agent'
import { booleanShape, isRecord, numberShape, stringShape } from '@orkestrel/contract'
import {
	createMemoryWorkflowStore,
	createWorkflowRunner,
	isWorkflowError,
} from '@orkestrel/workflow'
import {
	AGENT_TOOL_DEPTH,
	AGENT_TOOL_SUMMARY,
	ANSWER_TOOL_NAME,
	createAgentFunction,
	createAgentTool,
	createAnswerTool,
	createDatabaseTool,
	createDescribeTool,
	createEndpointTool,
	createInferTool,
	createMemoryDefinitionStore,
	createPromptTool,
	createRelationTool,
	createToolFunction,
	createWorkflowDraftContract,
	createWorkflowTool,
	createWorkspaceTool,
	DATABASE_TOOL_NAME,
	DESCRIBE_TOOL_NAME,
	INFER_TOOL_NAME,
	isAgentToolError,
	MAX_WORKFLOW_DEPTH,
	PROMPT_TOOL_NAME,
	RELATION_TOOL_NAME,
	WORKFLOW_TOOL_DESCRIPTION,
	WORKFLOW_TOOL_NAME,
	WORKFLOW_TOOL_SUMMARY,
	WORKSPACE_TOOL_DESCRIPTION,
	WORKSPACE_TOOL_SUMMARY,
} from '@src/core'
import { createTerminalManager, TerminalError } from '@orkestrel/terminal'
import { createDatabase, createMemoryDriver, generateUUID } from '@orkestrel/database'
import { belongsTo, createRelationManager, hasMany, hasThrough } from '@orkestrel/relation'
import { describe, expect, it } from 'vitest'
import { createRecorder, createScriptedProvider, waitForDelay } from '../../setup.js'

// tests/src/core/factories.test.ts — mirrors src/core/factories.ts. Ported from
// @orkestrel/workflow's + @orkestrel/agent's own factory suites (the byte-faithful port
// source), plus net-new coverage for this package's ADDITIONS: the pluggable store slot on
// createWorkflowTool, the unified manager/store options on createWorkspaceTool, and the
// net-new createAgentTool sub-agent delegation. Real handlers/stores/scripted providers
// throughout (AGENTS §16 — no mocks).

// ── Shared fixtures ──────────────────────────────────────────────────────────

// A one-task definition whose `run` is left UNREGISTERED against any functions passed at
// `execute` time, so the lone task auto-completes ⇒ a `completed` run.
function simpleDefinition(id = 'nested'): WorkflowDefinition {
	return {
		id,
		name: id,
		phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', run: 'noop' }] }],
	}
}

function readSummary(value: unknown): { status: string; count: number } | undefined {
	if (!isRecord(value) || typeof value.status !== 'string' || typeof value.count !== 'number') {
		return undefined
	}
	return { status: value.status, count: value.count }
}

async function rejectionOf(promise: Promise<unknown> | unknown): Promise<unknown> {
	try {
		await promise
		return undefined
	} catch (error) {
		return error
	}
}

// A minimal, hand-built TaskContext — pure DATA, the lineage shape createAgentFunction /
// createToolFunction read from controller.task. Lets the adapter tests call the returned
// WorkflowFunction directly, without driving a full runner round-trip.
function fakeTaskContext(workflowId = 'wf', taskId = 't'): TaskContext {
	const workflow = { id: workflowId, name: workflowId }
	const phase = { id: 'p', name: 'P', workflow }
	return { id: taskId, name: taskId, phase }
}

function fakeController(overrides: Partial<TaskControllerInterface> = {}): TaskControllerInterface {
	const controller = new AbortController()
	return {
		signal: controller.signal,
		aborted: controller.signal.aborted,
		input: {},
		task: fakeTaskContext(),
		results: () => [],
		...overrides,
	}
}

function executeThroughManager(
	tool: ReturnType<typeof createWorkflowTool>,
	args: Readonly<Record<string, unknown>> = { ...simpleDefinition('via-mgr') },
): Promise<ToolResult> {
	const manager = createToolManager()
	manager.add(tool)
	return manager.execute({ id: 'call-1', name: tool.name, arguments: args })
}

// ── createToolFunction — wraps a registered tool as a WorkflowFunction ───────

describe('createToolFunction — wraps a registered tool as a WorkflowFunction', () => {
	it('happy path: executes the named tool with controller.input and returns its value', async () => {
		const tools = createToolManager()
		const seen = createRecorder<readonly [Readonly<Record<string, unknown>>]>()
		tools.add(
			createTool({
				name: 'scan',
				execute: (args) => {
					seen.handler(args)
					return 'scanned'
				},
			}),
		)
		const fn = createToolFunction(tools, 'scan')
		const value = await fn(fakeController({ input: { path: '/repo' } }))
		expect(value).toBe('scanned')
		expect(seen.calls[0]?.[0]).toEqual({ path: '/repo' })
	})

	it('error-to-cause: a tool whose result carries an error throws an Error carrying it as `cause`', async () => {
		const tools = createToolManager()
		tools.add(
			createTool({
				name: 'boom',
				execute: () => {
					throw new Error('tool exploded')
				},
			}),
		)
		const fn = createToolFunction(tools, 'boom')
		const error = await rejectionOf(fn(fakeController()))
		expect(error).toBeInstanceOf(Error)
		expect(error instanceof Error ? error.cause : undefined).toBe('tool exploded')
	})

	it('an UNREGISTERED tool name throws a typed TOOL WorkflowError', async () => {
		const tools = createToolManager()
		const fn = createToolFunction(tools, 'missing')
		const error = await rejectionOf(fn(fakeController()))
		expect(error instanceof Error ? error.name : undefined).toBe('WorkflowError')
		expect(isWorkflowError(error) ? error.code : undefined).toBe('TOOL')
	})

	it('composed into a real runner: a task whose `run` maps to a createToolFunction entry dispatches the tool for real', async () => {
		const tools = createToolManager()
		tools.add(createTool({ name: 'scan', execute: () => 'scanned' }))
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T', run: 'scan' }] }],
		}
		const result = await createWorkflowRunner().execute(definition, {
			functions: { scan: createToolFunction(tools, 'scan') },
		})
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t')?.result?.result).toEqual({
			success: true,
			value: 'scanned',
		})
	})
})

// ── createAgentFunction — wraps a live AgentInterface as a WorkflowFunction ──

describe('createAgentFunction — wraps a live AgentInterface as a WorkflowFunction', () => {
	it('run: resolves the agent to its settled result, boxed as the task value', async () => {
		const agent = createAgent(createScriptedProvider([{ content: 'audited' }]))
		const fn = createAgentFunction(agent)
		const value = await fn(fakeController())
		const content = isRecord(value) ? value.content : undefined
		expect(content).toBe('audited')
	})

	it('abort fold: a mid-generate controller-signal abort cancels the agent (a partial resolves, never rejects)', async () => {
		const provider = createScriptedProvider([{ content: 'partial-content' }], { delay: 200 })
		const agent = createAgent(provider)
		const controller = new AbortController()
		const fn = createAgentFunction(agent)
		const running = fn(fakeController({ signal: controller.signal }))
		await waitForDelay(20)
		controller.abort(new Error('cancelled mid-generate'))
		const value = await running
		expect(isRecord(value) ? value.partial : undefined).toBe(true)
	})

	it('DEPTH on depth exceed: `depth + 1 > MAX_WORKFLOW_DEPTH` throws a typed DEPTH WorkflowError and never runs the agent', async () => {
		const provider = createScriptedProvider([{ content: 'x' }])
		const agent = createAgent(provider)
		const fn = createAgentFunction(agent, { depth: MAX_WORKFLOW_DEPTH })
		const error = await rejectionOf(fn(fakeController()))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('DEPTH')
		expect(provider.started).toBe(0)
	})

	it('DEPTH on ancestry cycle: an agent already present in the ancestry throws a typed DEPTH WorkflowError and never runs', async () => {
		const provider = createScriptedProvider([{ content: 'x' }])
		const agent = createAgent(provider)
		const fn = createAgentFunction(agent, { ancestry: [`agent:${agent.id}`] })
		const error = await rejectionOf(fn(fakeController()))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('DEPTH')
		expect(provider.started).toBe(0)
	})

	it('tool binding when `runner` is supplied: the agent context gains exactly one workflow tool under WORKFLOW_TOOL_NAME', async () => {
		const agent = createAgent(createScriptedProvider([{ content: 'audited' }]))
		expect(agent.context.tools.count).toBe(0)
		const fn = createAgentFunction(agent, { runner: createWorkflowRunner() })
		await fn(fakeController())
		expect(agent.context.tools.count).toBe(1)
		expect(agent.context.tools.tool(WORKFLOW_TOOL_NAME)).toBeDefined()
	})

	it('composed into a real runner: a task whose `run` maps to a createAgentFunction entry dispatches the agent for real', async () => {
		const agent = createAgent(createScriptedProvider([{ content: 'audited' }]))
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T', run: 'auditor' }] }],
		}
		const result = await createWorkflowRunner().execute(definition, {
			functions: { auditor: createAgentFunction(agent) },
		})
		expect(result.status).toBe('completed')
		const value = result.workflow.phase('a')?.task('t')?.result?.result
		const content =
			value?.success === true && isRecord(value.value) ? value.value.content : undefined
		expect(content).toBe('audited')
	})
})

// ── createWorkflowTool — wrap a definition as an LLM-callable tool ───────────

describe('createWorkflowTool — its parameters advertise the FLAT authoring shape', () => {
	it('the advertised parameters expose only name/steps (no id/phases)', () => {
		const tool = createWorkflowTool(simpleDefinition(), createWorkflowRunner())
		expect(tool.parameters?.type).toBe('object')
		const properties = tool.parameters?.properties
		expect(isRecord(properties) ? Object.keys(properties).sort() : []).toEqual(['name', 'steps'])
		expect(isRecord(properties) ? 'id' in properties : true).toBe(false)
		expect(isRecord(properties) ? 'phases' in properties : true).toBe(false)
	})

	it('the step `name` field carries a description', () => {
		const tool = createWorkflowTool(simpleDefinition(), createWorkflowRunner())
		const properties = tool.parameters?.properties
		const steps = isRecord(properties) ? properties.steps : undefined
		const items = isRecord(steps) ? steps.items : undefined
		const stepProps = isRecord(items) ? items.properties : undefined
		const nameField = isRecord(stepProps) ? stepProps.name : undefined
		expect(typeof (isRecord(nameField) ? nameField.description : undefined)).toBe('string')
	})
})

describe('createWorkflowTool — authoring forms (flat / draft / full / precedence)', () => {
	it('a valid authored full-form blob runs that workflow and RETURNS the plain run summary', async () => {
		const tool = createWorkflowTool(simpleDefinition('wrapped'), createWorkflowRunner())
		const summary = readSummary(await tool.execute({ ...simpleDefinition('authored') }))
		expect(summary).toEqual({ status: 'completed', count: 1 })
	})

	it('no authored args runs the WRAPPED definition (the tool genuinely wraps it)', async () => {
		const tool = createWorkflowTool(simpleDefinition('wrapped'), createWorkflowRunner())
		expect(readSummary(await tool.execute({}))).toEqual({ status: 'completed', count: 1 })
	})

	it('a malformed authored blob THROWS a typed TOOL WorkflowError (the §14 handler contract)', async () => {
		const tool = createWorkflowTool(simpleDefinition('wrapped'), createWorkflowRunner())
		const error = await rejectionOf(
			tool.execute({
				id: '',
				name: 'X',
				phases: [{ id: 'p', name: 'P', tasks: [], concurrency: 0 }],
			}),
		)
		expect(isWorkflowError(error) ? error.code : undefined).toBe('TOOL')
		expect(isWorkflowError(error) ? error.context : undefined).toMatchObject({
			workflow: 'wrapped',
		})
	})

	it('an over-deep call (depth at the ceiling) THROWS a typed DEPTH WorkflowError without running', async () => {
		const tool = createWorkflowTool(simpleDefinition(), createWorkflowRunner(), {
			depth: MAX_WORKFLOW_DEPTH,
		})
		const error = await rejectionOf(tool.execute({ ...simpleDefinition('deep') }))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('DEPTH')
		expect(error instanceof Error ? error.message : '').toContain('max depth')
	})

	it('a cyclic call (target id already an ancestor) THROWS a typed DEPTH WorkflowError', async () => {
		const tool = createWorkflowTool(simpleDefinition(), createWorkflowRunner(), {
			ancestry: ['workflow:loop'],
		})
		const error = await rejectionOf(tool.execute({ ...simpleDefinition('loop') }))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('DEPTH')
		expect(error instanceof Error ? error.message : '').toContain('cycle')
	})

	it('the draft contract accepts an ids-omitted blob but the tool rejects an explicitly-empty id', () => {
		const draft = createWorkflowDraftContract()
		const omitted: WorkflowDraft = { phases: [{ tasks: [{ run: 'a' }] }] }
		expect(draft.is(omitted)).toBe(true)
		expect(draft.parse({ id: '', phases: [] })).toBeUndefined()
	})

	it('the tool runs an ids-OMITTED nested draft end-to-end → completed with the right result count', async () => {
		const tool = createWorkflowTool(simpleDefinition('wrapped'), createWorkflowRunner())
		const summary = readSummary(
			await tool.execute({ phases: [{ tasks: [{ run: 'x' }] }, { tasks: [{ run: 'y' }] }] }),
		)
		expect(summary).toEqual({ status: 'completed', count: 2 })
	})

	it('the tool runs a minimal FLAT steps blob end-to-end → { status: completed, count: N }', async () => {
		const tool = createWorkflowTool(simpleDefinition('wrapped'), createWorkflowRunner())
		const summary = readSummary(
			await tool.execute({ name: 'build', steps: [{ name: 'compile' }, { name: 'publish' }] }),
		)
		expect(summary).toEqual({ status: 'completed', count: 2 })
	})

	it('a flat blob that cannot expand (a step missing `name`) THROWS a typed TOOL WorkflowError', async () => {
		const tool = createWorkflowTool(simpleDefinition('wrapped'), createWorkflowRunner())
		const error = await rejectionOf(tool.execute({ steps: [{}] }))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('TOOL')
	})

	it('a blob carrying BOTH `steps` and `phases` takes the FLAT branch (expands steps, IGNORES phases)', async () => {
		const tool = createWorkflowTool(simpleDefinition('wrapped'), createWorkflowRunner())
		const summary = readSummary(
			await tool.execute({
				name: 'precedence',
				steps: [{ name: 'a' }, { name: 'b' }],
				phases: [
					{ id: 'x', name: 'X', tasks: [{ id: 'x0', name: 'X0', run: 'p' }] },
					{ id: 'y', name: 'Y', tasks: [{ id: 'y0', name: 'Y0', run: 'q' }] },
					{ id: 'z', name: 'Z', tasks: [{ id: 'z0', name: 'Z0', run: 'r' }] },
				],
			}),
		)
		expect(summary).toEqual({ status: 'completed', count: 2 })
	})
})

describe('createWorkflowTool — tool-through-manager execution', () => {
	it('a SUCCESS maps to a SINGLE-LEVEL ToolResult — value IS the plain summary, no nested envelope', async () => {
		const tool = createWorkflowTool(simpleDefinition('wrapped'), createWorkflowRunner())
		const result = await executeThroughManager(tool)
		expect(result.value).toEqual({ status: 'completed', count: 1 })
		expect(isRecord(result.value) && 'value' in result.value).toBe(false)
		expect(result.error).toBeUndefined()
		expect(result.id).toBe('call-1')
		expect(result.name).toBe('workflow')
	})

	it('a FAILURE maps to a SINGLE-LEVEL ToolResult — a TOP-LEVEL error, no value', async () => {
		const tool = createWorkflowTool(simpleDefinition('wrapped'), createWorkflowRunner(), {
			depth: MAX_WORKFLOW_DEPTH,
		})
		const result = await executeThroughManager(tool)
		expect(result.value).toBeUndefined()
		expect(result.error).toContain('max depth')
		expect(result.id).toBe('call-1')
	})

	it('the manager FAILURE ToolResult maps to MCP isError:true; SUCCESS to the plain summary text', async () => {
		const failing = createWorkflowTool(simpleDefinition('wrapped'), createWorkflowRunner(), {
			depth: MAX_WORKFLOW_DEPTH,
		})
		const failure = buildToolResult(await executeThroughManager(failing))
		expect(failure.isError).toBe(true)
		expect(failure.content[0]?.text).toContain('max depth')

		const ok = createWorkflowTool(simpleDefinition('wrapped'), createWorkflowRunner())
		const success = buildToolResult(await executeThroughManager(ok))
		expect(success.isError).toBeUndefined()
		expect(success.content[0]?.text).toBe(JSON.stringify({ status: 'completed', count: 1 }))
	})
})

// ── net-new: createWorkflowTool's store slot ─────────────────────────────────

describe('createWorkflowTool — the optional durable store slot (this package`s addition)', () => {
	it('a successful authored run PERSISTS the final snapshot into the provided store', async () => {
		const store = createMemoryWorkflowStore()
		const tool = createWorkflowTool(simpleDefinition('wrapped'), createWorkflowRunner(), { store })
		expect(await store.get('authored')).toBeUndefined()
		await tool.execute({ ...simpleDefinition('authored') })
		const persisted = await store.get('authored')
		expect(persisted).toBeDefined()
		expect(persisted?.status).toBe('completed')
	})

	it('the persisted snapshot round-trips through the strict contract and is restorable', async () => {
		const store = createMemoryWorkflowStore()
		const tool = createWorkflowTool(simpleDefinition('wrapped'), createWorkflowRunner(), { store })
		await tool.execute({ ...simpleDefinition('restorable') })
		const persisted = await store.get('restorable')
		expect(persisted?.phases[0]?.tasks[0]?.status).toBe('completed')
	})

	it('an ABSENT store has NO persistence side effects', async () => {
		const tool = createWorkflowTool(simpleDefinition('wrapped'), createWorkflowRunner())
		const summary = readSummary(await tool.execute({ ...simpleDefinition('no-store') }))
		expect(summary).toEqual({ status: 'completed', count: 1 })
		// No store was supplied; nothing to assert beyond the run completing without error.
	})

	it('a FAILED run (depth guard) does NOT persist anything (the store.set is post-run only)', async () => {
		const store = createMemoryWorkflowStore()
		const tool = createWorkflowTool(simpleDefinition('wrapped'), createWorkflowRunner(), {
			store,
			depth: MAX_WORKFLOW_DEPTH,
		})
		await rejectionOf(tool.execute({ ...simpleDefinition('unreached') }))
		expect(await store.get('unreached')).toBeUndefined()
	})
})

// ── createWorkspaceTool — unified manager/store options (this package`s addition) ──

describe('createWorkspaceTool — default (in-memory manager constructed)', () => {
	it('with no options, edits land on a freshly-constructed in-memory-backed manager', async () => {
		const tool = createWorkspaceTool()
		expect(tool.name).toBe('workspace')
		const result = await tool.execute({ operation: 'write', path: 'a.ts', content: 'x' })
		expect(result).toEqual({ path: 'a.ts', state: 'created' })
		expect(await tool.execute({ operation: 'read', path: 'a.ts' })).toBe('x')
	})

	it('honors name / description overrides', () => {
		const tool = createWorkspaceTool({ name: 'fs', description: 'edit files' })
		expect(tool.name).toBe('fs')
		expect(tool.description).toBe('edit files')
	})
})

describe('createWorkspaceTool — explicit store (persistence observable via the store)', () => {
	it('a write through the tool is retrievable through a fresh manager over the SAME store', async () => {
		const store = createMemoryWorkspaceStore()
		const tool = createWorkspaceTool({ store })
		await tool.execute({ operation: 'write', path: 'notes.md', content: '# Title' })
		// The tool's own manager auto-creates + activates a default workspace on the write (the
		// no-active ergonomic seam) but never persists on its own — persistence flows through the
		// store only once a caller explicitly saves through a manager built over it.
		const author = createWorkspaceManager({ store })
		const workspace = author.add({ id: 'w' })
		workspace.write('a.txt', 'x')
		expect(await author.save('w')).toBe(true)
		const reader = createWorkspaceManager({ store })
		const opened = await reader.open('w')
		expect(opened?.read('a.txt')).toBe('x')
	})

	it('the tool operates correctly (its handler works) when constructed over a store', async () => {
		const store = createMemoryWorkspaceStore()
		const tool = createWorkspaceTool({ store })
		const result = await tool.execute({ operation: 'write', path: 'a.ts', content: 'x' })
		expect(result).toEqual({ path: 'a.ts', state: 'created' })
		expect(await tool.execute({ operation: 'read', path: 'a.ts' })).toBe('x')
	})
})

describe('createWorkspaceTool — explicit manager (drives the caller`s manager directly)', () => {
	it('edits land on the manager`s ACTIVE workspace, observable through the manager', async () => {
		const manager = createWorkspaceManager()
		const workspace = manager.add()
		const tool = createWorkspaceTool({ manager })
		await tool.execute({ operation: 'write', path: 'a.ts', content: 'const x = 1' })
		expect(workspace.read('a.ts')).toBe('const x = 1')
	})

	it('a caller-supplied manager with no active workspace still auto-creates on a write', async () => {
		const manager = createWorkspaceManager()
		expect(manager.active).toBeUndefined()
		const tool = createWorkspaceTool({ manager })
		await tool.execute({ operation: 'write', path: 'x.txt', content: 'y' })
		expect(manager.count).toBe(1)
		expect(manager.active?.read('x.txt')).toBe('y')
	})

	it('a manager built over a store lets the tool`s edits be persisted by the caller afterwards', async () => {
		const store = createMemoryWorkspaceStore()
		const manager = createWorkspaceManager({ store })
		manager.add({ id: 'w' })
		const tool = createWorkspaceTool({ manager })
		await tool.execute({ operation: 'write', path: 'a.ts', content: 'via-manager' })
		expect(await manager.save('w')).toBe(true)
		const reader = createWorkspaceManager({ store })
		const opened = await reader.open('w')
		expect(opened?.read('a.ts')).toBe('via-manager')
	})
})

describe('createWorkspaceTool — precedence: manager wins when BOTH manager and store are given', () => {
	it('the caller-supplied manager drives the tool; the store is not built into a competing manager', async () => {
		const store = createMemoryWorkspaceStore()
		const manager = createWorkspaceManager()
		const workspace = manager.add()
		const tool = createWorkspaceTool({ manager, store })
		await tool.execute({ operation: 'write', path: 'a.ts', content: 'from-manager' })
		expect(workspace.read('a.ts')).toBe('from-manager')
		// `store` was NOT used to build the tool's manager — a fresh manager over it has nothing.
		const overStore = createWorkspaceManager({ store })
		expect(overStore.count).toBe(0)
	})
})

// ── createAgentTool — sub-agent delegation ────────────────────────────────────

describe('createAgentTool — schema accept/reject via agentToolShape', () => {
	it('a malformed call (missing/empty task) THROWS a typed TOOL AgentToolError', async () => {
		const registry = createAgentRegistry({
			providers: { main: createScriptedProvider([{ content: 'x' }]) },
		})
		const tool = createAgentTool(registry, { provider: 'main' })
		const error = await rejectionOf(tool.execute({}))
		expect(isAgentToolError(error)).toBe(true)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')

		const emptyTask = await rejectionOf(tool.execute({ task: '' }))
		expect(isAgentToolError(emptyTask) ? emptyTask.code : undefined).toBe('TOOL')
	})

	it('a well-formed call with every optional field is accepted by the contract', () => {
		const call: AgentToolArguments = {
			task: 'summarize',
			provider: 'main',
			tools: ['search'],
			system: 'be terse',
		}
		expect(call.task).toBe('summarize')
	})

	it('a malformed tools/system field on the call THROWS a typed TOOL AgentToolError', async () => {
		const registry = createAgentRegistry({
			providers: { main: createScriptedProvider([{ content: 'x' }]) },
		})
		const tool = createAgentTool(registry, { provider: 'main' })
		const error = await rejectionOf(tool.execute({ task: 'x', tools: 'not-an-array' }))
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
	})

	it('no resolvable provider (neither call nor tool default) THROWS a typed TOOL AgentToolError', async () => {
		const registry = createAgentRegistry({
			providers: { main: createScriptedProvider([{ content: 'x' }]) },
		})
		const tool = createAgentTool(registry) // no default provider configured
		const error = await rejectionOf(tool.execute({ task: 'do it' }))
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
	})
})

describe('createAgentTool — depth / cycle guard', () => {
	it('depth at the ceiling THROWS a typed DEPTH AgentToolError', async () => {
		const provider = createScriptedProvider([{ content: 'x' }])
		const registry = createAgentRegistry({ providers: { main: provider } })
		const tool = createAgentTool(registry, { provider: 'main', depth: AGENT_TOOL_DEPTH })
		const error = await rejectionOf(tool.execute({ task: 'do it' }))
		expect(isAgentToolError(error) ? error.code : undefined).toBe('DEPTH')
		expect(provider.started).toBe(0)
	})

	it('a cyclic ancestry (provider already present) THROWS a typed DEPTH AgentToolError', async () => {
		const provider = createScriptedProvider([{ content: 'x' }])
		const registry = createAgentRegistry({ providers: { main: provider } })
		const tool = createAgentTool(registry, { provider: 'main', ancestry: ['agent:main'] })
		const error = await rejectionOf(tool.execute({ task: 'do it' }))
		expect(isAgentToolError(error) ? error.code : undefined).toBe('DEPTH')
		expect(provider.started).toBe(0)
	})
})

describe('createAgentTool — delegation happy-path with a real minimal registry + scripted provider', () => {
	it('delegates the task and returns the sub-agent`s settled content', async () => {
		const provider = createScriptedProvider([{ content: 'delegated result' }])
		const registry = createAgentRegistry({ providers: { main: provider } })
		const tool = createAgentTool(registry, { provider: 'main' })
		const result = await tool.execute({ task: 'summarize the notes' })
		expect(result).toBe('delegated result')
		expect(provider.calls[0]?.messages[0]).toMatchObject({
			role: 'user',
			content: 'summarize the notes',
		})
	})

	it('a per-call provider overrides the tool default', async () => {
		const defaultProvider = createScriptedProvider([{ content: 'default-provider' }])
		const otherProvider = createScriptedProvider([{ content: 'other-provider' }])
		const registry = createAgentRegistry({
			providers: { primary: defaultProvider, secondary: otherProvider },
		})
		const tool = createAgentTool(registry, { provider: 'primary' })
		const result = await tool.execute({ task: 'x', provider: 'secondary' })
		expect(result).toBe('other-provider')
		expect(defaultProvider.started).toBe(0)
	})

	it('per-call tools/system override the tool`s own configured defaults', async () => {
		const provider = createScriptedProvider([{ content: 'ok' }])
		const registry = createAgentRegistry({ providers: { main: provider } })
		const tool = createAgentTool(registry, { provider: 'main', system: 'default system' })
		await tool.execute({ task: 'x', system: 'override system' })
		expect(provider.started).toBe(1)
	})
})

describe('createAgentTool — abort fold (abort during generate settles per the agent contract)', () => {
	it('the delegated agent genuinely runs to a settled result through the tool (no throw)', async () => {
		const provider = createScriptedProvider([{ content: 'partial-delegate' }], { delay: 20 })
		const registry = createAgentRegistry({ providers: { main: provider } })
		const tool = createAgentTool(registry, { provider: 'main' })
		const result = await tool.execute({ task: 'do it' })
		expect(result).toBe('partial-delegate')
		expect(provider.started).toBe(1)
	})
})

// ── net-new: createAgentTool's store slot (agent 0.0.4 addition) ─────────────

describe('createAgentTool — the optional conversation store slot (this package`s addition)', () => {
	it('a successful delegation PERSISTS the sub-agent`s conversation snapshot into the provided store', async () => {
		const backing = createMemoryConversationStore()
		const seen = createRecorder<readonly [string]>()
		const store = {
			get: (id: string) => backing.get(id),
			set: async (snapshot: Awaited<ReturnType<typeof backing.get>> & object) => {
				seen.handler(snapshot.id)
				await backing.set(snapshot)
			},
			delete: (id: string) => backing.delete(id),
		}
		const provider = createScriptedProvider([{ content: 'delegated' }])
		const registry = createAgentRegistry({ providers: { main: provider } })
		const tool = createAgentTool(registry, { provider: 'main', store })
		const result = await tool.execute({ task: 'summarize the notes' })
		expect(result).toBe('delegated')
		expect(seen.count).toBe(1)
		const stored = await backing.get(seen.calls[0]?.[0] ?? '')
		expect(stored).toBeDefined()
	})

	it('two delegations through the SAME store slot persist TWO distinct snapshots', async () => {
		const backing = createMemoryConversationStore()
		const seen = createRecorder<readonly [string]>()
		const store = {
			get: (id: string) => backing.get(id),
			set: async (snapshot: Awaited<ReturnType<typeof backing.get>> & object) => {
				seen.handler(snapshot.id)
				await backing.set(snapshot)
			},
			delete: (id: string) => backing.delete(id),
		}
		const provider = createScriptedProvider([{ content: 'first' }, { content: 'second' }])
		const registry = createAgentRegistry({ providers: { main: provider } })
		const tool = createAgentTool(registry, { provider: 'main', store })
		await tool.execute({ task: 'first task' })
		await tool.execute({ task: 'second task' })
		expect(seen.count).toBe(2)
		expect(new Set(seen.calls.map((call) => call[0])).size).toBe(2)
	})

	it('an ABSENT store has no persistence side effects (the storeless path is unchanged)', async () => {
		const provider = createScriptedProvider([{ content: 'no-store-result' }])
		const registry = createAgentRegistry({ providers: { main: provider } })
		const tool = createAgentTool(registry, { provider: 'main' })
		const result = await tool.execute({ task: 'do it' })
		expect(result).toBe('no-store-result')
	})

	it('a store failure surfaces as the tool call`s failure via the manager envelope', async () => {
		const failingStore = {
			get: async () => undefined,
			set: async () => {
				throw new Error('store unavailable')
			},
			delete: async () => undefined,
		}
		const provider = createScriptedProvider([{ content: 'x' }])
		const registry = createAgentRegistry({ providers: { main: provider } })
		const tool = createAgentTool(registry, { provider: 'main', store: failingStore })
		const manager = createToolManager()
		manager.add(tool)
		const result = await manager.execute({
			id: 'call-1',
			name: tool.name,
			arguments: { task: 'x' },
		})
		expect(result.value).toBeUndefined()
		expect(result.error).toContain('store unavailable')
	})
})

// ── net-new: the three tools' advertised `summary` (agent 0.0.4 lean projection) ──

describe('the workflow/workspace/agent tool factories advertise a `summary` alongside the full `description`', () => {
	it('createWorkflowTool exposes the exact summary and keeps its full description', () => {
		const tool = createWorkflowTool(simpleDefinition(), createWorkflowRunner())
		expect(tool.summary).toBe(WORKFLOW_TOOL_SUMMARY)
		expect(tool.description).toBe(WORKFLOW_TOOL_DESCRIPTION)
	})

	it('createWorkspaceTool exposes the exact summary and keeps its full description', () => {
		const tool = createWorkspaceTool()
		expect(tool.summary).toBe(WORKSPACE_TOOL_SUMMARY)
		expect(tool.description).toBe(WORKSPACE_TOOL_DESCRIPTION)
	})

	it('createAgentTool exposes the exact summary and keeps its full description', () => {
		const registry = createAgentRegistry({
			providers: { main: createScriptedProvider([{ content: 'x' }]) },
		})
		const tool = createAgentTool(registry, { provider: 'main' })
		expect(tool.summary).toBe(AGENT_TOOL_SUMMARY)
		expect(tool.description).toBeDefined()
	})

	it('a real ToolManager`s definitions() advertise the summary while tool(name).description keeps the full text', () => {
		const registry = createAgentRegistry({
			providers: { main: createScriptedProvider([{ content: 'x' }]) },
		})
		const manager = createToolManager()
		const workflowTool = createWorkflowTool(simpleDefinition(), createWorkflowRunner())
		const workspaceTool = createWorkspaceTool()
		const agentTool = createAgentTool(registry, { provider: 'main' })
		manager.add([workflowTool, workspaceTool, agentTool])
		const definitions = manager.definitions()
		const byName = (name: string): (typeof definitions)[number] | undefined =>
			definitions.find((definition) => definition.name === name)
		expect(byName('workflow')?.description).toBe(WORKFLOW_TOOL_SUMMARY)
		expect(byName('workspace')?.description).toBe(WORKSPACE_TOOL_SUMMARY)
		expect(byName('agent')?.description).toBe(AGENT_TOOL_SUMMARY)
		expect(manager.tool('workflow')?.description).toBe(WORKFLOW_TOOL_DESCRIPTION)
		expect(manager.tool('workspace')?.description).toBe(WORKSPACE_TOOL_DESCRIPTION)
	})
})

// ── net-new: createDescribeTool — full-description lookup by name ────────────

describe('createDescribeTool — returns a registered tool`s full description', () => {
	it('describes each of the three tools through a real ToolManager', async () => {
		const registry = createAgentRegistry({
			providers: { main: createScriptedProvider([{ content: 'x' }]) },
		})
		const manager = createToolManager()
		const workflowTool = createWorkflowTool(simpleDefinition(), createWorkflowRunner())
		const workspaceTool = createWorkspaceTool()
		const agentTool = createAgentTool(registry, { provider: 'main' })
		manager.add([workflowTool, workspaceTool, agentTool])
		const describeTool = createDescribeTool(manager)
		manager.add(describeTool)

		expect(describeTool.name).toBe(DESCRIBE_TOOL_NAME)
		expect(await describeTool.execute({ name: 'workflow' })).toBe(WORKFLOW_TOOL_DESCRIPTION)
		expect(await describeTool.execute({ name: 'workspace' })).toBe(WORKSPACE_TOOL_DESCRIPTION)
		expect(await describeTool.execute({ name: 'agent' })).toBe(agentTool.description)
	})

	it('an unknown tool name THROWS a typed TOOL AgentToolError via the manager`s error envelope', async () => {
		const manager = createToolManager()
		const describeTool = createDescribeTool(manager)
		manager.add(describeTool)
		const result = await manager.execute({
			id: 'call-1',
			name: DESCRIBE_TOOL_NAME,
			arguments: { name: 'nonexistent' },
		})
		expect(result.value).toBeUndefined()
		expect(result.error).toContain('nonexistent')

		const direct = await rejectionOf(describeTool.execute({ name: 'nonexistent' }))
		expect(isAgentToolError(direct) ? direct.code : undefined).toBe('TOOL')
	})

	it('malformed args (missing/empty name) are REJECTED with a typed TOOL AgentToolError', async () => {
		const manager = createToolManager()
		const describeTool = createDescribeTool(manager)
		const missing = await rejectionOf(describeTool.execute({}))
		expect(isAgentToolError(missing) ? missing.code : undefined).toBe('TOOL')
		const empty = await rejectionOf(describeTool.execute({ name: '' }))
		expect(isAgentToolError(empty) ? empty.code : undefined).toBe('TOOL')
	})
})

// ── createPromptTool / createAnswerTool — the terminal ask/answer seam ───────

/** A controllable fake `TimerHandler` — records armed `(callback, ms)` pairs and lets a test fire one on demand. */
function createFakeTimer(): {
	readonly timer: TimerHandler
	fire: (index: number) => void
	readonly armed: number
} {
	const armed: Array<{ callback: () => void; cancelled: boolean }> = []
	const timer: TimerHandler = (callback, _ms) => {
		const entry = { callback, cancelled: false }
		armed.push(entry)
		const cancel: TimerCancel = () => {
			entry.cancelled = true
		}
		return cancel
	}
	return {
		timer,
		fire(index: number): void {
			const entry = armed[index]
			if (entry !== undefined && !entry.cancelled) entry.callback()
		},
		get armed() {
			return armed.length
		},
	}
}

describe('createPromptTool / createAnswerTool — the terminal ask/answer seam', () => {
	it('ask BLOCKS then resolves when the peer answers via the answer tool', async () => {
		const manager = createTerminalManager()
		manager.add('agent')
		manager.add('reviewer')
		const askTool = createPromptTool({ manager, from: 'agent' })
		const answerTool = createAnswerTool({ manager, to: 'reviewer' })
		expect(askTool.name).toBe(PROMPT_TOOL_NAME)
		expect(answerTool.name).toBe(ANSWER_TOOL_NAME)

		const pending = askTool.execute({ to: 'reviewer', form: 'confirm', message: 'Approve?' })

		// Give the ask a tick to park, then list + answer through the answer tool.
		await waitForDelay(0)
		const listed = await answerTool.execute({ operation: 'pending' })
		expect(Array.isArray(listed) ? listed.length : 0).toBe(1)
		const first = Array.isArray(listed) ? listed[0] : undefined
		const id = first !== null && typeof first === 'object' && 'id' in first ? first.id : undefined
		expect(typeof id).toBe('string')

		const ack = await answerTool.execute({ operation: 'answer', id, value: 'true' })
		expect(ack).toEqual({ answered: id })
		expect(await pending).toBe(true)
	})

	it('DEADLOCK: a prompt cycle maps to a typed DEADLOCK AgentToolError', async () => {
		const manager = createTerminalManager()
		manager.add('a')
		manager.add('b')
		const askFromA = createPromptTool({ manager, from: 'a' })
		const askFromB = createPromptTool({ manager, from: 'b' })

		const aAsksB = Promise.resolve(askFromA.execute({ to: 'b', form: 'confirm', message: 'ok?' }))
		aAsksB.catch(() => {})
		await waitForDelay(0)

		const error = await rejectionOf(askFromB.execute({ to: 'a', form: 'confirm', message: 'ok?' }))
		expect(isAgentToolError(error) ? error.code : undefined).toBe('DEADLOCK')
	})

	it('unknown target maps to a typed TOOL AgentToolError listing known terminals', async () => {
		const manager = createTerminalManager()
		manager.add('agent')
		const askTool = createPromptTool({ manager, from: 'agent' })
		const error = await rejectionOf(
			askTool.execute({ to: 'ghost', form: 'input', message: 'name?' }),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		const known = isAgentToolError(error) ? error.context?.known : undefined
		expect(known).toEqual(['agent'])
	})

	it('EXPIRE: an injected-timer expiry maps to a typed EXPIRE AgentToolError', async () => {
		const manager = createTerminalManager()
		const fake = createFakeTimer()
		manager.add('agent')
		manager.add('reviewer', { timeout: 10, timer: fake.timer })
		const askTool = createPromptTool({ manager, from: 'agent' })

		const pending = rejectionOf(
			askTool.execute({ to: 'reviewer', form: 'input', message: 'name?' }),
		)
		await waitForDelay(0)
		fake.fire(0)
		const error = await pending
		expect(isAgentToolError(error) ? error.code : undefined).toBe('EXPIRE')
	})

	it("answer tool 'pending' lists addressed prompts with from attribution", async () => {
		const manager = createTerminalManager()
		manager.add('agent')
		manager.add('reviewer')
		const askTool = createPromptTool({ manager, from: 'agent' })
		const answerTool = createAnswerTool({ manager, to: 'reviewer' })

		const pending = Promise.resolve(
			askTool.execute({ to: 'reviewer', form: 'confirm', message: 'Approve?' }),
		)
		pending.catch(() => {})
		await waitForDelay(0)

		const listed = await answerTool.execute({ operation: 'pending' })
		expect(Array.isArray(listed)).toBe(true)
		const first = Array.isArray(listed) ? listed[0] : undefined
		expect(first).toMatchObject({ from: 'agent', form: 'confirm', message: 'Approve?' })

		// Answer it so the outstanding ask settles and doesn't leak between tests.
		const id = first !== null && typeof first === 'object' && 'id' in first ? first.id : undefined
		await answerTool.execute({ operation: 'answer', id, value: true })
	})

	it("answer tool 'answer' with a confirm prompt accepts a string 'true' (coercion) and resolves", async () => {
		const manager = createTerminalManager()
		manager.add('agent')
		manager.add('reviewer')
		const askTool = createPromptTool({ manager, from: 'agent' })
		const answerTool = createAnswerTool({ manager, to: 'reviewer' })

		const pending = askTool.execute({ to: 'reviewer', form: 'confirm', message: 'Approve?' })
		await waitForDelay(0)
		const listed = await answerTool.execute({ operation: 'pending' })
		const first = Array.isArray(listed) ? listed[0] : undefined
		const id = first !== null && typeof first === 'object' && 'id' in first ? first.id : undefined

		const ack = await answerTool.execute({ operation: 'answer', id, value: 'true' })
		expect(ack).toEqual({ answered: id })
		expect(await pending).toBe(true)
	})

	it('unknown id maps to a typed ANSWER AgentToolError', async () => {
		const manager = createTerminalManager()
		manager.add('reviewer')
		const answerTool = createAnswerTool({ manager, to: 'reviewer' })
		const error = await rejectionOf(
			answerTool.execute({ operation: 'answer', id: 'ghost-id', value: true }),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('ANSWER')
		expect(isAgentToolError(error) ? error.context?.reason : undefined).toBe('unknown')
	})

	it('from/to cannot be overridden by args — construction-fixed identity', async () => {
		const manager = createTerminalManager()
		manager.add('agent')
		manager.add('spoof')
		manager.add('reviewer')
		const askTool = createPromptTool({ manager, from: 'agent' })
		const answerTool = createAnswerTool({ manager, to: 'reviewer' })

		// Passing `from`/`to` in args is simply ignored — the shapes don't even accept them, and the
		// handler never reads them: an ask still parks under the FIXED `from`, never `spoof`.
		const pending = Promise.resolve(
			askTool.execute({
				to: 'reviewer',
				form: 'confirm',
				message: 'ok?',
			}),
		)
		pending.catch(() => {})
		await waitForDelay(0)

		const listed = await answerTool.execute({ operation: 'pending' })
		const first = Array.isArray(listed) ? listed[0] : undefined
		expect(first).toMatchObject({ from: 'agent' })
		const id = first !== null && typeof first === 'object' && 'id' in first ? first.id : undefined
		await answerTool.execute({ operation: 'answer', id, value: true })
	})

	it('empty choices (select) THROWS a typed TOOL AgentToolError naming the choices requirement, without parking', async () => {
		const manager = createTerminalManager()
		manager.add('agent')
		manager.add('reviewer')
		const askTool = createPromptTool({ manager, from: 'agent' })
		const error = await rejectionOf(
			askTool.execute({ to: 'reviewer', form: 'select', message: 'pick one', choices: [] }),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		expect(error instanceof Error ? error.message : '').toContain('choice')
		expect(manager.pending('reviewer')).toEqual([])
	})

	it('empty choices (checkbox, choices omitted) THROWS a typed TOOL AgentToolError, without parking', async () => {
		const manager = createTerminalManager()
		manager.add('agent')
		manager.add('reviewer')
		const askTool = createPromptTool({ manager, from: 'agent' })
		const error = await rejectionOf(
			askTool.execute({ to: 'reviewer', form: 'checkbox', message: 'pick some' }),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		expect(error instanceof Error ? error.message : '').toContain('choice')
		expect(manager.pending('reviewer')).toEqual([])
	})

	it('a generic non-TARGET/DEADLOCK/EXPIRE TerminalError surfaces as TOOL with the generic asking-failed message', async () => {
		const emitter: TerminalManagerInterface['emitter'] = {
			destroyed: false,
			on: () => {},
			once: () => {},
			off: () => {},
			emit: () => {},
			count: () => 0,
			clear: () => {},
			destroy: () => {},
		}
		function ask(..._args: readonly unknown[]): Promise<never> {
			return Promise.reject(new TerminalError('DRIVER', 'driver failed'))
		}
		const stub: TerminalManagerInterface = {
			emitter,
			count: 0,
			terminal: () => undefined,
			terminals: () => ['b'],
			add: () => {
				throw new Error('not implemented')
			},
			ask,
			pending: () => [],
			answer: () => ({ success: false, error: 'unknown' }),
			open: async () => undefined,
			save: async () => false,
			remove: () => false,
			clear: () => {},
			destroy: () => {},
		}
		const askTool = createPromptTool({ manager: stub, from: 'a' })
		const error = await rejectionOf(askTool.execute({ to: 'b', form: 'input', message: 'name?' }))
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		const message = error instanceof Error ? error.message : ''
		expect(message).toContain('failed')
		expect(message).not.toContain('unknown terminal')
	})
})

// ── pressure: createPromptTool arg fuzz ──────────────────────────────────────

describe('pressure: prompt-tool arg fuzz — schema-invalid args surface as typed TOOL errors, nothing parks', () => {
	it('missing `to` throws typed TOOL, nothing parks', async () => {
		const manager = createTerminalManager()
		manager.add('agent')
		manager.add('reviewer')
		const askTool = createPromptTool({ manager, from: 'agent' })
		const error = await rejectionOf(askTool.execute({ form: 'input', message: 'hi' }))
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		expect(manager.pending('reviewer')).toEqual([])
	})

	it('missing `form` throws typed TOOL, nothing parks', async () => {
		const manager = createTerminalManager()
		manager.add('agent')
		manager.add('reviewer')
		const askTool = createPromptTool({ manager, from: 'agent' })
		const error = await rejectionOf(askTool.execute({ to: 'reviewer', message: 'hi' }))
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		expect(manager.pending('reviewer')).toEqual([])
	})

	it('missing `message` throws typed TOOL, nothing parks', async () => {
		const manager = createTerminalManager()
		manager.add('agent')
		manager.add('reviewer')
		const askTool = createPromptTool({ manager, from: 'agent' })
		const error = await rejectionOf(askTool.execute({ to: 'reviewer', form: 'input' }))
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		expect(manager.pending('reviewer')).toEqual([])
	})

	it("unknown form 'wizard' throws typed TOOL, nothing parks", async () => {
		const manager = createTerminalManager()
		manager.add('agent')
		manager.add('reviewer')
		const askTool = createPromptTool({ manager, from: 'agent' })
		const error = await rejectionOf(
			askTool.execute({ to: 'reviewer', form: 'wizard', message: 'hi' }),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		expect(manager.pending('reviewer')).toEqual([])
	})

	// FINDING: a numeric `message` is NOT schema-invalid — `@orkestrel/contract`'s string parser
	// (`parseString`) coerces a finite number to its string form before validation, so
	// `message: 42` parses successfully as `'42'` and the ask genuinely parks (it does not throw).
	// Pinning the ACTUAL documented contract behavior here instead of the originally-assumed
	// rejection (which would hang the ask forever, since nothing ever answers it).
	it('a numeric `message` is COERCED to its string form by the contract layer (not rejected) — the ask parks normally', async () => {
		const manager = createTerminalManager()
		manager.add('agent')
		manager.add('reviewer')
		const askTool = createPromptTool({ manager, from: 'agent' })
		const answerTool = createAnswerTool({ manager, to: 'reviewer' })
		const pending = Promise.resolve(askTool.execute({ to: 'reviewer', form: 'input', message: 42 }))
		pending.catch(() => {})
		await waitForDelay(0)
		expect(manager.pending('reviewer')).toHaveLength(1)
		const listed = await answerTool.execute({ operation: 'pending' })
		const first = Array.isArray(listed) ? listed[0] : undefined
		expect(first).toMatchObject({ message: '42' })
		const id = first !== null && typeof first === 'object' && 'id' in first ? first.id : undefined
		await answerTool.execute({ operation: 'answer', id, value: 'ok' })
		expect(await pending).toBe('ok')
	})

	it('an OBJECT `message` (not string/finite-number coercible) throws typed TOOL, nothing parks', async () => {
		const manager = createTerminalManager()
		manager.add('agent')
		manager.add('reviewer')
		const askTool = createPromptTool({ manager, from: 'agent' })
		const error = await rejectionOf(askTool.execute({ to: 'reviewer', form: 'input', message: {} }))
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		expect(manager.pending('reviewer')).toEqual([])
	})

	it('negative `timeout` throws typed TOOL, nothing parks', async () => {
		const manager = createTerminalManager()
		manager.add('agent')
		manager.add('reviewer')
		const askTool = createPromptTool({ manager, from: 'agent' })
		const error = await rejectionOf(
			askTool.execute({ to: 'reviewer', form: 'input', message: 'hi', timeout: -5 }),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		expect(manager.pending('reviewer')).toEqual([])
	})

	it('`choices` as a bare string (not an array of {name, value}) throws typed TOOL, nothing parks', async () => {
		const manager = createTerminalManager()
		manager.add('agent')
		manager.add('reviewer')
		const askTool = createPromptTool({ manager, from: 'agent' })
		const error = await rejectionOf(
			askTool.execute({ to: 'reviewer', form: 'select', message: 'pick one', choices: 'a,b' }),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		expect(manager.pending('reviewer')).toEqual([])
	})
})

// ── pressure: multi-agent round — ten terminals, thirty interleaved asks ────

describe('pressure: multi-agent round — ten terminals, thirty interleaved asks, deadlock, expire', () => {
	const NAMES = Array.from({ length: 10 }, (_, i) => `t${i}`)

	function buildTerminals(manager: TerminalManagerInterface): void {
		for (const name of NAMES) manager.add(name)
	}

	it('30 interleaved asks across a lower→upper bipartite split (no cycle) all resolve with the coerced value', async () => {
		const manager = createTerminalManager()
		buildTerminals(manager)
		const askTools = new Map(NAMES.map((name) => [name, createPromptTool({ manager, from: name })]))
		const answerTools = new Map(
			NAMES.map((name) => [name, createAnswerTool({ manager, to: name })]),
		)

		const lower = NAMES.slice(0, 5)
		const upper = NAMES.slice(5, 10)
		const forms: ReadonlyArray<'input' | 'confirm' | 'checkbox'> = ['input', 'confirm', 'checkbox']

		// 30 asks, each strictly lower → upper (bipartite — never a reverse edge, so no cycle can
		// ever close regardless of how many are held pending simultaneously).
		type Ask = {
			readonly from: string
			readonly to: string
			readonly form: 'input' | 'confirm' | 'checkbox'
		}
		const asks: Ask[] = []
		for (let i = 0; i < 30; i++) {
			const from = lower[i % 5]
			const to = upper[(i + Math.floor(i / 5)) % 5]
			const form = forms[i % 3]
			if (from === undefined || to === undefined || form === undefined)
				throw new Error('unreachable')
			asks.push({ from, to, form })
		}

		const pendingAsks = asks.map(({ from, to, form }) => {
			const askTool = askTools.get(from)
			if (askTool === undefined) throw new Error('unreachable')
			const message = `${form} question from ${from} to ${to}`
			const args: Record<string, unknown> =
				form === 'checkbox'
					? {
							to,
							form,
							message,
							choices: [
								{ name: 'x', value: 'x' },
								{ name: 'y', value: 'y' },
							],
						}
					: { to, form, message }
			const promise = Promise.resolve(askTool.execute(args))
			promise.catch(() => {})
			return promise
		})

		await waitForDelay(0)

		// Gather every parked prompt id (per upper terminal) up front, then answer them in a
		// SHUFFLED-but-deterministic order (reverse of discovery order) — first-write-wins /
		// ordering must not matter to correctness.
		const allPending: Array<{ readonly to: string; readonly id: string; readonly form: string }> =
			[]
		for (const to of upper) {
			const answerTool = answerTools.get(to)
			if (answerTool === undefined) throw new Error('unreachable')
			const listed = await answerTool.execute({ operation: 'pending' })
			if (!Array.isArray(listed)) throw new Error('expected an array')
			for (const entry of listed) {
				if (
					entry !== null &&
					typeof entry === 'object' &&
					'id' in entry &&
					typeof entry.id === 'string'
				) {
					const form = 'form' in entry && typeof entry.form === 'string' ? entry.form : ''
					allPending.push({ to, id: entry.id, form })
				}
			}
		}
		expect(allPending).toHaveLength(30)

		const shuffled = [...allPending].reverse()
		for (const entry of shuffled) {
			const answerTool = answerTools.get(entry.to)
			if (answerTool === undefined) throw new Error('unreachable')
			const value = entry.form === 'confirm' ? true : entry.form === 'checkbox' ? 'x,y' : 'answered'
			const ack = await answerTool.execute({ operation: 'answer', id: entry.id, value })
			expect(ack).toEqual({ answered: entry.id })
		}

		const settled = await Promise.all(pendingAsks)
		const expected = asks.map((ask) => {
			if (ask.form === 'confirm') return true
			if (ask.form === 'checkbox') return ['x', 'y']
			return 'answered'
		})
		expect(settled).toEqual(expected)
	})

	it('a reciprocal ask between two agents surfaces DEADLOCK with the cycle path in context', async () => {
		const manager = createTerminalManager()
		buildTerminals(manager)
		const askTools = new Map(NAMES.map((name) => [name, createPromptTool({ manager, from: name })]))

		const askA = askTools.get('t0')
		const askB = askTools.get('t1')
		if (askA === undefined || askB === undefined) throw new Error('unreachable')

		const first = Promise.resolve(askA.execute({ to: 't1', form: 'confirm', message: 'ok?' }))
		first.catch(() => {})
		await waitForDelay(0)

		const error = await rejectionOf(askB.execute({ to: 't0', form: 'confirm', message: 'ok?' }))
		expect(isAgentToolError(error) ? error.code : undefined).toBe('DEADLOCK')
		const context = isAgentToolError(error) ? error.context : undefined
		const path = context !== undefined && 'path' in context ? context.path : undefined
		expect(Array.isArray(path) ? path : []).toEqual(expect.arrayContaining(['t0', 't1']))
	})

	it('an EXPIRE (fake-timer-driven) fires while nine other agents remain pending — surfaces typed EXPIRE only for the expired ask', async () => {
		const fake = createFakeTimer()
		const manager = createTerminalManager()
		manager.add('t0')
		manager.add('t9', { timeout: 10, timer: fake.timer })
		for (const name of NAMES.slice(1, 9)) manager.add(name)
		const askFromT0 = createPromptTool({ manager, from: 't0' })
		const askFromT1 = createPromptTool({ manager, from: 't1' })

		// A second, ordinary ask (no timer) stays pending throughout — proves the expiry is scoped
		// to the one prompt whose broker was configured with the fake timer, not global.
		const other = Promise.resolve(
			askFromT1.execute({ to: 't2', form: 'input', message: 'still waiting' }),
		)
		other.catch(() => {})

		const expiring = rejectionOf(askFromT0.execute({ to: 't9', form: 'input', message: 'name?' }))
		await waitForDelay(0)
		fake.fire(0)
		const error = await expiring
		expect(isAgentToolError(error) ? error.code : undefined).toBe('EXPIRE')

		// The unrelated pending ask is untouched — still parked, not settled.
		expect(manager.pending('t2')).toHaveLength(1)
	})
})

// ── createDatabaseTool — create / query / mutate through one operation-discriminated call ────

// Mixed bare-kind and `{type,optional}` column specs — the call-args shape `'create'`/`'migrate'`
// accept, mirroring stores.test.ts's `fullDefinition` fixture.
function itemsTables(): Readonly<Record<string, unknown>> {
	return {
		items: {
			columns: {
				id: 'string',
				name: 'string',
				price: { type: 'number', optional: true },
				active: 'boolean',
			},
		},
	}
}

function itemRow(
	id: string,
	overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
	return { id, name: `item-${id}`, price: 10, active: true, ...overrides }
}

// Builds a LIVE `DatabaseInterface` handle directly (bypassing the tool) — used by the
// readonly-gate suite where a pre-existing handle is the fixture.
function buildItemsHandle(): DatabaseInterface {
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

describe('createDatabaseTool — create', () => {
	it('happy path: mixed bare-kind and {type,optional} column specs mint a live database', async () => {
		const tool = createDatabaseTool()
		expect(tool.name).toBe(DATABASE_TOOL_NAME)
		const result = await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		expect(result).toEqual({ id: 'shop', tables: ['items'] })
	})

	it('honors name / description overrides', () => {
		const tool = createDatabaseTool({ name: 'db', description: 'manage databases' })
		expect(tool.name).toBe('db')
		expect(tool.description).toBe('manage databases')
	})
})

describe('createDatabaseTool — tables', () => {
	it('lists table name/primary/columns for a created database', async () => {
		const tool = createDatabaseTool()
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		const result = await tool.execute({ operation: 'tables', id: 'shop' })
		expect(isRecord(result) && Array.isArray(result.tables) ? result.tables : []).toEqual([
			expect.objectContaining({ name: 'items', primary: 'id' }),
		])
	})
})

describe('createDatabaseTool — get', () => {
	it('single key resolves { row }, an array resolves { rows } with misses left absent', async () => {
		const tool = createDatabaseTool()
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		await tool.execute({ operation: 'add', id: 'shop', table: 'items', row: itemRow('a') })

		const single = await tool.execute({ operation: 'get', id: 'shop', table: 'items', key: 'a' })
		expect(isRecord(single) ? single.row : undefined).toEqual(itemRow('a'))

		const many = await tool.execute({
			operation: 'get',
			id: 'shop',
			table: 'items',
			key: ['a', 'missing'],
		})
		expect(isRecord(many) && Array.isArray(many.rows) ? many.rows : []).toEqual([
			itemRow('a'),
			undefined,
		])
	})
})

describe('createDatabaseTool — records (serialized criteria)', () => {
	it('conditions/order/limit/offset are honored via the SERIALIZED criteria form', async () => {
		const tool = createDatabaseTool()
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		await tool.execute({
			operation: 'add',
			id: 'shop',
			table: 'items',
			row: [itemRow('a', { price: 5 }), itemRow('b', { price: 15 }), itemRow('c', { price: 25 })],
		})

		const result = await tool.execute({
			operation: 'records',
			id: 'shop',
			table: 'items',
			criteria: {
				conditions: [{ column: 'price', operator: 'above', values: [1] }],
				order: [{ column: 'price', direction: 'descending' }],
				limit: 2,
				offset: 1,
			},
		})
		expect(isRecord(result) && Array.isArray(result.rows) ? result.rows : []).toEqual([
			itemRow('b', { price: 15 }),
			itemRow('a', { price: 5 }),
		])
		expect(isRecord(result) ? result.count : undefined).toBe(2)
		expect(isRecord(result) ? result.truncated : undefined).toBe(false)
	})
})

describe('createDatabaseTool — count', () => {
	it('counts rows matching criteria', async () => {
		const tool = createDatabaseTool()
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		await tool.execute({
			operation: 'add',
			id: 'shop',
			table: 'items',
			row: [itemRow('a'), itemRow('b'), itemRow('c', { active: false })],
		})
		const result = await tool.execute({
			operation: 'count',
			id: 'shop',
			table: 'items',
			criteria: { conditions: [{ column: 'active', operator: 'equals', values: [true] }] },
		})
		expect(result).toEqual({ count: 2 })
	})
})

describe('createDatabaseTool — aggregate', () => {
	it('computes all five aggregate functions over a numeric column', async () => {
		const tool = createDatabaseTool()
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		await tool.execute({
			operation: 'add',
			id: 'shop',
			table: 'items',
			row: [itemRow('a', { price: 5 }), itemRow('b', { price: 15 }), itemRow('c', { price: 25 })],
		})

		const functions = ['count', 'sum', 'average', 'minimum', 'maximum'] as const
		const expected: Readonly<Record<(typeof functions)[number], number>> = {
			count: 3,
			sum: 45,
			average: 15,
			minimum: 5,
			maximum: 25,
		}
		for (const fn of functions) {
			const result = await tool.execute({
				operation: 'aggregate',
				id: 'shop',
				table: 'items',
				function: fn,
				column: 'price',
			})
			expect(result).toEqual({ value: expected[fn] })
		}
	})
})

describe('createDatabaseTool — add', () => {
	it('single row resolves { key }, an array resolves { keys }', async () => {
		const tool = createDatabaseTool()
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })

		const single = await tool.execute({
			operation: 'add',
			id: 'shop',
			table: 'items',
			row: itemRow('a'),
		})
		expect(single).toEqual({ key: 'a' })

		const many = await tool.execute({
			operation: 'add',
			id: 'shop',
			table: 'items',
			row: [itemRow('b'), itemRow('c')],
		})
		expect(many).toEqual({ keys: ['b', 'c'] })
	})

	it('a duplicate key CONFLICT re-surfaces as a typed DATABASE error with context.code CONFLICT', async () => {
		const tool = createDatabaseTool()
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		await tool.execute({ operation: 'add', id: 'shop', table: 'items', row: itemRow('a') })

		const error = await rejectionOf(
			tool.execute({ operation: 'add', id: 'shop', table: 'items', row: itemRow('a') }),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('DATABASE')
		expect(isAgentToolError(error) ? error.context?.code : undefined).toBe('CONFLICT')
	})
})

describe('createDatabaseTool — set (upsert)', () => {
	it('inserts an absent key and replaces an existing one', async () => {
		const tool = createDatabaseTool()
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		await tool.execute({
			operation: 'set',
			id: 'shop',
			table: 'items',
			row: itemRow('a', { price: 1 }),
		})
		await tool.execute({
			operation: 'set',
			id: 'shop',
			table: 'items',
			row: itemRow('a', { price: 2 }),
		})

		const result = await tool.execute({ operation: 'get', id: 'shop', table: 'items', key: 'a' })
		expect(isRecord(result) ? result.row : undefined).toEqual(itemRow('a', { price: 2 }))
	})
})

describe('createDatabaseTool — update', () => {
	it('single key resolves { updated }, an array resolves { updated: [] }', async () => {
		const tool = createDatabaseTool()
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		await tool.execute({
			operation: 'add',
			id: 'shop',
			table: 'items',
			row: [itemRow('a'), itemRow('b')],
		})

		const single = await tool.execute({
			operation: 'update',
			id: 'shop',
			table: 'items',
			key: 'a',
			changes: { price: 99 },
		})
		expect(single).toEqual({ updated: true })

		const many = await tool.execute({
			operation: 'update',
			id: 'shop',
			table: 'items',
			key: ['a', 'b'],
			changes: { active: false },
		})
		expect(many).toEqual({ updated: [true, true] })
	})

	it('a row that fails re-validation re-surfaces as a typed DATABASE error with context.code VALIDATION', async () => {
		const tool = createDatabaseTool()
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		await tool.execute({ operation: 'add', id: 'shop', table: 'items', row: itemRow('a') })

		const error = await rejectionOf(
			tool.execute({
				operation: 'update',
				id: 'shop',
				table: 'items',
				key: 'a',
				changes: { price: 'not-a-number' },
			}),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('DATABASE')
		expect(isAgentToolError(error) ? error.context?.code : undefined).toBe('VALIDATION')
	})
})

describe('createDatabaseTool — remove', () => {
	it('single key resolves { removed }, an array resolves { removed: [] }', async () => {
		const tool = createDatabaseTool()
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		await tool.execute({
			operation: 'add',
			id: 'shop',
			table: 'items',
			row: [itemRow('a'), itemRow('b')],
		})

		const single = await tool.execute({ operation: 'remove', id: 'shop', table: 'items', key: 'a' })
		expect(single).toEqual({ removed: true })
		const many = await tool.execute({
			operation: 'remove',
			id: 'shop',
			table: 'items',
			key: ['b', 'x'],
		})
		expect(many).toEqual({ removed: [true, false] })
	})
})

describe('createDatabaseTool — migrate', () => {
	it('adding a column returns the migration plan and the new column is writable/readable afterward', async () => {
		const tool = createDatabaseTool()
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		await tool.execute({ operation: 'add', id: 'shop', table: 'items', row: itemRow('a') })

		const migratedTables = {
			items: {
				columns: {
					...(itemsTables().items as Readonly<{ columns: Readonly<Record<string, unknown>> }>)
						.columns,
					discount: { type: 'number', optional: true },
				},
			},
		}
		const result = await tool.execute({ operation: 'migrate', id: 'shop', tables: migratedTables })
		expect(isRecord(result) ? result.migration : undefined).toEqual({
			from: 0,
			to: 1,
			steps: [
				{
					operation: 'column.add',
					table: 'items',
					column: { name: 'discount', type: 'real', nullable: true },
				},
			],
		})

		await tool.execute({
			operation: 'update',
			id: 'shop',
			table: 'items',
			key: 'a',
			changes: { discount: 5 },
		})
		const row = await tool.execute({ operation: 'get', id: 'shop', table: 'items', key: 'a' })
		expect(isRecord(row) ? row.row : undefined).toEqual(itemRow('a', { discount: 5 }))
	})

	it('removing a column returns the migration plan and stripped rows read back without the column', async () => {
		const tool = createDatabaseTool()
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		await tool.execute({ operation: 'add', id: 'shop', table: 'items', row: itemRow('a') })

		const { price: _price, ...remainingColumns } = (
			itemsTables().items as Readonly<{ columns: Readonly<Record<string, unknown>> }>
		).columns
		const migratedTables = { items: { columns: remainingColumns } }
		const result = await tool.execute({ operation: 'migrate', id: 'shop', tables: migratedTables })
		expect(isRecord(result) ? result.migration : undefined).toEqual({
			from: 0,
			to: 1,
			steps: [{ operation: 'column.remove', table: 'items', column: 'price' }],
		})

		// MemoryDriver.migrate applies `migrateRows` for `column.remove` in place, so storage
		// itself is stripped (not merely narrowed by the records()/get() contract guard).
		const row = await tool.execute({ operation: 'get', id: 'shop', table: 'items', key: 'a' })
		expect(isRecord(row) ? row.row : undefined).toEqual({ id: 'a', name: 'item-a', active: true })
	})
})

describe('createDatabaseTool — destroy', () => {
	it('drops the database; a subsequent operation throws a typed TOOL "unknown database" error', async () => {
		const tool = createDatabaseTool()
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		const result = await tool.execute({ operation: 'destroy', id: 'shop' })
		expect(result).toEqual({ id: 'shop', destroyed: true })

		const error = await rejectionOf(tool.execute({ operation: 'tables', id: 'shop' }))
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		expect(
			isAgentToolError(error) && typeof error.message === 'string'
				? error.message.includes('unknown database')
				: false,
		).toBe(true)
	})
})

describe('createDatabaseTool — error paths', () => {
	it('an unknown id (no cached handle, no store) throws a typed TOOL error', async () => {
		const tool = createDatabaseTool()
		const error = await rejectionOf(tool.execute({ operation: 'tables', id: 'missing' }))
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
	})

	it('an unknown driver name on create throws a typed TOOL error', async () => {
		const tool = createDatabaseTool()
		const error = await rejectionOf(
			tool.execute({ operation: 'create', id: 'shop', tables: itemsTables(), driver: 'nope' }),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
	})

	it('a duplicate create (same id twice) throws a typed TOOL error', async () => {
		const tool = createDatabaseTool()
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		const error = await rejectionOf(
			tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() }),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
	})

	it('malformed args (missing required fields) throw a typed TOOL error', async () => {
		const tool = createDatabaseTool()
		const error = await rejectionOf(tool.execute({ operation: 'create' }))
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')

		const badOperation = await rejectionOf(tool.execute({ operation: 'nope', id: 'shop' }))
		expect(isAgentToolError(badOperation) ? badOperation.code : undefined).toBe('TOOL')
	})

	it('a row that fails validation on add re-surfaces as a typed DATABASE error with context.code VALIDATION', async () => {
		const tool = createDatabaseTool()
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		const error = await rejectionOf(
			tool.execute({
				operation: 'add',
				id: 'shop',
				table: 'items',
				row: { id: 'a', name: 'x', price: 1, active: 'not-a-boolean' },
			}),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('DATABASE')
		expect(isAgentToolError(error) ? error.context?.code : undefined).toBe('VALIDATION')
	})
})

describe('createDatabaseTool — readonly gates mutations, leaves reads open', () => {
	it('create/add/set/update/remove/migrate/destroy each throw TOOL; tables/get/records/count/aggregate still work', async () => {
		const handle = buildItemsHandle()
		await handle.table('items').add([{ id: 'a', name: 'x', price: 1, active: true }])
		const tool = createDatabaseTool({ readonly: true, databases: { shop: handle } })

		const mutations: ReadonlyArray<Readonly<Record<string, unknown>>> = [
			{ operation: 'create', id: 'other', tables: itemsTables() },
			{ operation: 'add', id: 'shop', table: 'items', row: itemRow('b') },
			{ operation: 'set', id: 'shop', table: 'items', row: itemRow('a') },
			{ operation: 'update', id: 'shop', table: 'items', key: 'a', changes: { price: 2 } },
			{ operation: 'remove', id: 'shop', table: 'items', key: 'a' },
			{ operation: 'migrate', id: 'shop', tables: itemsTables() },
			{ operation: 'destroy', id: 'shop' },
		]
		for (const call of mutations) {
			const error = await rejectionOf(tool.execute(call))
			expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		}

		expect(await tool.execute({ operation: 'tables', id: 'shop' })).toEqual({
			tables: [expect.objectContaining({ name: 'items', primary: 'id' })],
		})
		expect(await tool.execute({ operation: 'get', id: 'shop', table: 'items', key: 'a' })).toEqual({
			row: { id: 'a', name: 'x', price: 1, active: true },
		})
		expect(await tool.execute({ operation: 'records', id: 'shop', table: 'items' })).toEqual({
			rows: [{ id: 'a', name: 'x', price: 1, active: true }],
			count: 1,
			truncated: false,
			limit: 1000,
		})
		expect(await tool.execute({ operation: 'count', id: 'shop', table: 'items' })).toEqual({
			count: 1,
		})
		expect(
			await tool.execute({
				operation: 'aggregate',
				id: 'shop',
				table: 'items',
				function: 'count',
				column: 'id',
			}),
		).toEqual({ value: 1 })
	})
})

describe('createDatabaseTool — truncation & offset paging', () => {
	it('records over a small limit reports truncated:true, count == limit; offset paging walks the rest', async () => {
		const tool = createDatabaseTool({ limit: 2 })
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		await tool.execute({
			operation: 'add',
			id: 'shop',
			table: 'items',
			row: [itemRow('a'), itemRow('b'), itemRow('c'), itemRow('d'), itemRow('e')],
		})

		const collected: unknown[] = []
		let offset = 0
		for (let page = 0; page < 3; page++) {
			const result = await tool.execute({
				operation: 'records',
				id: 'shop',
				table: 'items',
				criteria: { order: [{ column: 'id', direction: 'ascending' }], offset },
			})
			if (!isRecord(result) || !Array.isArray(result.rows)) throw new Error('unreachable')
			expect(result.count).toBe(result.rows.length)
			collected.push(...result.rows)
			offset += result.rows.length
			if (result.truncated !== true) break
		}
		expect(collected).toEqual([
			itemRow('a'),
			itemRow('b'),
			itemRow('c'),
			itemRow('d'),
			itemRow('e'),
		])

		const first = await tool.execute({
			operation: 'records',
			id: 'shop',
			table: 'items',
			criteria: { order: [{ column: 'id', direction: 'ascending' }] },
		})
		expect(isRecord(first) ? first.truncated : undefined).toBe(true)
		expect(isRecord(first) ? first.count : undefined).toBe(2)
	})
})

describe('createDatabaseTool — lazy re-mint over a shared store', () => {
	it('a second tool over the SAME store re-mints the handle; destroy through it deletes the store definition', async () => {
		const store = createMemoryDefinitionStore()
		// A shared driver instance (not a fresh one per tool) so the re-minted handle reads the
		// SAME underlying storage — proving the re-mint itself works, not just that it doesn't throw.
		const sharedDriver = createMemoryDriver()
		const drivers = { memory: () => sharedDriver }
		const toolA = createDatabaseTool({ store, drivers })
		await toolA.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		await toolA.execute({ operation: 'add', id: 'shop', table: 'items', row: itemRow('a') })

		const toolB = createDatabaseTool({ store, drivers })
		const result = await toolB.execute({ operation: 'records', id: 'shop', table: 'items' })
		expect(isRecord(result) && Array.isArray(result.rows) ? result.rows : []).toEqual([
			itemRow('a'),
		])

		await toolB.execute({ operation: 'destroy', id: 'shop' })
		expect(await store.get('shop')).toBeUndefined()
	})
})

describe('createDatabaseTool — timeout option threads without breaking a normal op', () => {
	it('a configured timeout does not interfere with an ordinary create/add/records round trip', async () => {
		const tool = createDatabaseTool({ timeout: 5_000 })
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })
		await tool.execute({ operation: 'add', id: 'shop', table: 'items', row: itemRow('a') })
		const result = await tool.execute({ operation: 'records', id: 'shop', table: 'items' })
		expect(isRecord(result) && Array.isArray(result.rows) ? result.rows : []).toEqual([
			itemRow('a'),
		])
	})
})

describe('pressure: createDatabaseTool — 500-row batch add, full paging, migrate, slice update, destroy', () => {
	it('exact counts survive the round trip', async () => {
		const tool = createDatabaseTool({ limit: 100 })
		await tool.execute({ operation: 'create', id: 'shop', tables: itemsTables() })

		const total = 500
		const batchSize = 50
		for (let start = 0; start < total; start += batchSize) {
			const batch = Array.from({ length: batchSize }, (_unused, offset) =>
				itemRow(String(start + offset).padStart(4, '0')),
			)
			const added = await tool.execute({ operation: 'add', id: 'shop', table: 'items', row: batch })
			expect(isRecord(added) && Array.isArray(added.keys) ? added.keys.length : 0).toBe(batchSize)
		}

		const collected: unknown[] = []
		let offset = 0
		for (;;) {
			const result = await tool.execute({
				operation: 'records',
				id: 'shop',
				table: 'items',
				criteria: { order: [{ column: 'id', direction: 'ascending' }], offset },
			})
			if (!isRecord(result) || !Array.isArray(result.rows)) throw new Error('unreachable')
			collected.push(...result.rows)
			offset += result.rows.length
			if (result.truncated !== true) break
		}
		expect(collected).toHaveLength(total)

		const migratedTables = {
			items: {
				columns: {
					...(itemsTables().items as Readonly<{ columns: Readonly<Record<string, unknown>> }>)
						.columns,
					tag: { type: 'string', optional: true },
				},
			},
		}
		const migration = await tool.execute({
			operation: 'migrate',
			id: 'shop',
			tables: migratedTables,
		})
		expect(
			isRecord(migration) && isRecord(migration.migration) ? migration.migration.to : undefined,
		).toBe(1)

		const sliceIds = Array.from({ length: 25 }, (_unused, index) => String(index).padStart(4, '0'))
		const updated = await tool.execute({
			operation: 'update',
			id: 'shop',
			table: 'items',
			key: sliceIds,
			changes: { tag: 'tagged' },
		})
		expect(isRecord(updated) && Array.isArray(updated.updated) ? updated.updated : []).toEqual(
			Array.from({ length: 25 }, () => true),
		)

		const tagged = await tool.execute({
			operation: 'count',
			id: 'shop',
			table: 'items',
			criteria: { conditions: [{ column: 'tag', operator: 'equals', values: ['tagged'] }] },
		})
		expect(tagged).toEqual({ count: 25 })

		const untaggedRow = await tool.execute({
			operation: 'get',
			id: 'shop',
			table: 'items',
			key: '0499',
		})
		expect(
			isRecord(untaggedRow) && isRecord(untaggedRow.row) ? 'tag' in untaggedRow.row : false,
		).toBe(false)

		const taggedRow = await tool.execute({
			operation: 'get',
			id: 'shop',
			table: 'items',
			key: '0000',
		})
		expect(isRecord(taggedRow) ? taggedRow.row : undefined).toEqual(
			itemRow('0000', { tag: 'tagged' }),
		)

		const destroyed = await tool.execute({ operation: 'destroy', id: 'shop' })
		expect(destroyed).toEqual({ id: 'shop', destroyed: true })
	})
})

// ── createRelationTool — traverse/edit `@orkestrel/relation` relationships ───

// A shared 4-table relation graph: `accounts` has-many `contacts` and has-through `reps` via
// the `accountReps` junction; `contacts` belongs-to `account`; `reps` has-through `accounts`
// via the SAME junction (the inverse side) — enough shapes to exercise belongs/many/through.
function buildRelationDatabase(): DatabaseInterface {
	return createDatabase({
		driver: createMemoryDriver(),
		tables: {
			accounts: { id: stringShape(), name: stringShape() },
			contacts: { id: stringShape(), name: stringShape(), accountId: stringShape() },
			reps: { id: stringShape(), name: stringShape() },
			accountReps: { id: stringShape(), accountId: stringShape(), repId: stringShape() },
		},
		key: generateUUID,
	})
}

function buildRelationManager(): RelationManagerInterface {
	return createRelationManager({
		database: buildRelationDatabase(),
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

async function seedAccount(
	manager: RelationManagerInterface,
	id: string,
	name = `account-${id}`,
): Promise<void> {
	await manager.model('accounts').table.set({ id, name })
}

async function seedContact(
	manager: RelationManagerInterface,
	id: string,
	accountId: string,
	name = `contact-${id}`,
): Promise<void> {
	await manager.model('contacts').table.set({ id, name, accountId })
}

async function seedRep(
	manager: RelationManagerInterface,
	id: string,
	name = `rep-${id}`,
): Promise<void> {
	await manager.model('reps').table.set({ id, name })
}

describe('createRelationTool — manager resolution', () => {
	it('a single registered manager is used by default when the call omits `manager`', async () => {
		const manager = buildRelationManager()
		await seedAccount(manager, 'a1', 'Acme')
		const tool = createRelationTool({ managers: { shop: manager } })
		const result = await tool.execute({
			operation: 'load',
			model: 'accounts',
			key: 'a1',
			include: [],
		})
		expect(isRecord(result) ? result.row : undefined).toMatchObject({ id: 'a1', name: 'Acme' })
	})

	it('an explicit `manager` selects among two registered managers', async () => {
		const shop = buildRelationManager()
		const other = buildRelationManager()
		await seedAccount(shop, 'a1', 'Shop Acme')
		await seedAccount(other, 'a1', 'Other Acme')
		const tool = createRelationTool({ managers: { shop, other } })
		const result = await tool.execute({
			operation: 'load',
			manager: 'other',
			model: 'accounts',
			key: 'a1',
			include: [],
		})
		expect(isRecord(result) ? result.row : undefined).toMatchObject({ name: 'Other Acme' })
	})

	it('an unknown `manager` name throws a typed TOOL error listing the registered manager keys', async () => {
		const manager = buildRelationManager()
		const tool = createRelationTool({ managers: { shop: manager } })
		const error = await rejectionOf(
			tool.execute({
				operation: 'load',
				manager: 'ghost',
				model: 'accounts',
				key: 'a1',
				include: [],
			}),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		expect(isAgentToolError(error) ? error.context?.managers : undefined).toEqual(['shop'])
	})

	it('two registered managers with an omitted `manager` throws a typed TOOL ambiguous error', async () => {
		const shop = buildRelationManager()
		const other = buildRelationManager()
		const tool = createRelationTool({ managers: { shop, other } })
		const error = await rejectionOf(
			tool.execute({ operation: 'load', model: 'accounts', key: 'a1', include: [] }),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		expect(isAgentToolError(error) ? error.context?.managers : undefined).toEqual(['shop', 'other'])
	})
})

describe('createRelationTool — model resolution', () => {
	it('an unknown `model` name throws a typed TOOL error listing the registered model names', async () => {
		const manager = buildRelationManager()
		const tool = createRelationTool({ managers: { shop: manager } })
		const error = await rejectionOf(
			tool.execute({ operation: 'load', model: 'ghost', key: 'a1', include: [] }),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		const models = isAgentToolError(error) ? error.context?.models : undefined
		expect(Array.isArray(models) ? [...models].sort() : []).toEqual([
			'accounts',
			'contacts',
			'reps',
		])
	})
})

describe('createRelationTool — load', () => {
	it('a single key with a nested dot-path include round-trips the related row through its own relation', async () => {
		const manager = buildRelationManager()
		await seedAccount(manager, 'a1', 'Acme')
		await seedContact(manager, 'c1', 'a1', 'Wile')
		const tool = createRelationTool({ managers: { shop: manager } })
		const result = await tool.execute({
			operation: 'load',
			model: 'accounts',
			key: 'a1',
			include: ['contacts.account'],
		})
		const row = isRecord(result) ? result.row : undefined
		const contacts = isRecord(row) && Array.isArray(row.contacts) ? row.contacts : []
		expect(contacts).toHaveLength(1)
		const contact = contacts[0]
		expect(isRecord(contact) ? contact.name : undefined).toBe('Wile')
		const account = isRecord(contact) ? contact.account : undefined
		expect(isRecord(account) ? account.id : undefined).toBe('a1')
	})

	it('array keys resolve positionally, a miss at an index left undefined there', async () => {
		const manager = buildRelationManager()
		await seedAccount(manager, 'a1', 'Acme')
		const tool = createRelationTool({ managers: { shop: manager } })
		const result = await tool.execute({
			operation: 'load',
			model: 'accounts',
			key: ['a1', 'ghost'],
			include: [],
		})
		const rows = isRecord(result) && Array.isArray(result.rows) ? result.rows : []
		expect(rows).toHaveLength(2)
		expect(isRecord(rows[0]) ? rows[0].id : undefined).toBe('a1')
		expect(rows[1]).toBeUndefined()
	})
})

describe('createRelationTool — find (sort / direction / offset, truncation & paging)', () => {
	it('sort/direction/offset are honored', async () => {
		const manager = buildRelationManager()
		await seedAccount(manager, 'a1', 'Alpha')
		await seedAccount(manager, 'a2', 'Bravo')
		await seedAccount(manager, 'a3', 'Charlie')
		const tool = createRelationTool({ managers: { shop: manager } })
		const result = await tool.execute({
			operation: 'find',
			model: 'accounts',
			include: [],
			sort: 'name',
			direction: 'descending',
			offset: 1,
		})
		const rows = isRecord(result) && Array.isArray(result.rows) ? result.rows : []
		expect(rows.map((row) => (isRecord(row) ? row.name : undefined))).toEqual(['Bravo', 'Alpha'])
	})

	it('a small `limit` option reports truncated:true and count == the effective limit', async () => {
		const manager = buildRelationManager()
		await seedAccount(manager, 'a1')
		await seedAccount(manager, 'a2')
		await seedAccount(manager, 'a3')
		const tool = createRelationTool({ managers: { shop: manager }, limit: 2 })
		const result = await tool.execute({ operation: 'find', model: 'accounts', include: [] })
		expect(isRecord(result) ? result.truncated : undefined).toBe(true)
		expect(isRecord(result) ? result.count : undefined).toBe(2)
	})

	it('offset paging walks every row when driven by the reported truncation', async () => {
		const manager = buildRelationManager()
		for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) await seedAccount(manager, id)
		const tool = createRelationTool({ managers: { shop: manager }, limit: 2 })
		const collected: unknown[] = []
		let offset = 0
		for (let page = 0; page < 3; page++) {
			const result = await tool.execute({
				operation: 'find',
				model: 'accounts',
				include: [],
				sort: 'id',
				direction: 'ascending',
				offset,
			})
			if (!isRecord(result) || !Array.isArray(result.rows)) throw new Error('unreachable')
			collected.push(...result.rows)
			offset += result.rows.length
			if (result.truncated !== true) break
		}
		expect(collected.map((row) => (isRecord(row) ? row.id : undefined))).toEqual([
			'a1',
			'a2',
			'a3',
			'a4',
			'a5',
		])
	})
})

describe('createRelationTool — link / unlink / links round trip on a through relation', () => {
	it('link then unlink is reflected by a subsequent links call', async () => {
		const manager = buildRelationManager()
		await seedAccount(manager, 'a1')
		await seedRep(manager, 'r1')
		const tool = createRelationTool({ managers: { shop: manager } })

		const before = await tool.execute({
			operation: 'links',
			model: 'accounts',
			key: 'a1',
			relation: 'reps',
		})
		expect(isRecord(before) ? before.keys : undefined).toEqual([])

		const linked = await tool.execute({
			operation: 'link',
			model: 'accounts',
			key: 'a1',
			relation: 'reps',
			target: 'r1',
		})
		expect(linked).toEqual({ linked: true })

		const after = await tool.execute({
			operation: 'links',
			model: 'accounts',
			key: 'a1',
			relation: 'reps',
		})
		expect(isRecord(after) ? after.keys : undefined).toEqual(['r1'])

		const unlinked = await tool.execute({
			operation: 'unlink',
			model: 'accounts',
			key: 'a1',
			relation: 'reps',
			target: 'r1',
		})
		expect(unlinked).toEqual({ unlinked: true })

		const removed = await tool.execute({
			operation: 'links',
			model: 'accounts',
			key: 'a1',
			relation: 'reps',
		})
		expect(isRecord(removed) ? removed.keys : undefined).toEqual([])
	})

	it('a `links` call over the configured limit reports truncated:true and a capped count', async () => {
		const manager = buildRelationManager()
		await seedAccount(manager, 'a1')
		for (const id of ['r1', 'r2', 'r3']) {
			await seedRep(manager, id)
			await manager.model('accounts').link('a1', 'reps', id)
		}
		const tool = createRelationTool({ managers: { shop: manager }, limit: 2 })
		const result = await tool.execute({
			operation: 'links',
			model: 'accounts',
			key: 'a1',
			relation: 'reps',
		})
		expect(isRecord(result) ? result.truncated : undefined).toBe(true)
		expect(isRecord(result) && Array.isArray(result.keys) ? result.keys.length : 0).toBe(2)
	})
})

describe('createRelationTool — depth cap', () => {
	it('an include path deeper than the configured depth throws a typed TOOL error', async () => {
		const manager = buildRelationManager()
		await seedAccount(manager, 'a1')
		const tool = createRelationTool({ managers: { shop: manager }, depth: 1 })
		const error = await rejectionOf(
			tool.execute({
				operation: 'load',
				model: 'accounts',
				key: 'a1',
				include: ['contacts.account'],
			}),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
	})
})

describe('createRelationTool — error mapping (RelationError → typed RELATION)', () => {
	it('`link` on a non-through relation surfaces context.code NOT_THROUGH', async () => {
		const manager = buildRelationManager()
		await seedAccount(manager, 'a1')
		await seedContact(manager, 'c1', 'a1')
		const tool = createRelationTool({ managers: { shop: manager } })
		const error = await rejectionOf(
			tool.execute({
				operation: 'link',
				model: 'accounts',
				key: 'a1',
				relation: 'contacts',
				target: 'c1',
			}),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('RELATION')
		expect(isAgentToolError(error) ? error.context?.code : undefined).toBe('NOT_THROUGH')
	})

	it('an unknown relation name surfaces context.code UNKNOWN_RELATION', async () => {
		const manager = buildRelationManager()
		await seedAccount(manager, 'a1')
		const tool = createRelationTool({ managers: { shop: manager } })
		const error = await rejectionOf(
			tool.execute({
				operation: 'link',
				model: 'accounts',
				key: 'a1',
				relation: 'ghost',
				target: 'x',
			}),
		)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('RELATION')
		expect(isAgentToolError(error) ? error.context?.code : undefined).toBe('UNKNOWN_RELATION')
	})
})

describe('createRelationTool — advertised name/depth/limit defaults', () => {
	it('uses RELATION_TOOL_NAME by default and honors a name override', () => {
		const manager = buildRelationManager()
		const tool = createRelationTool({ managers: { shop: manager } })
		expect(tool.name).toBe(RELATION_TOOL_NAME)

		const named = createRelationTool({ managers: { shop: manager }, name: 'graph' })
		expect(named.name).toBe('graph')
	})
})

describe('pressure: createRelationTool — 200-parent seed, nested load, 50-row link/unlink cycle', () => {
	it('nested load resolves across the full set and link/unlink counts stay exact at every step', async () => {
		const manager = buildRelationManager()
		const parentCount = 200
		for (let i = 0; i < parentCount; i++) {
			const id = `a${String(i).padStart(4, '0')}`
			await seedAccount(manager, id)
			await seedContact(manager, `c${String(i).padStart(4, '0')}`, id)
		}
		const tool = createRelationTool({ managers: { shop: manager }, limit: 1000 })

		const found = await tool.execute({
			operation: 'find',
			model: 'accounts',
			include: ['contacts.account'],
		})
		const rows = isRecord(found) && Array.isArray(found.rows) ? found.rows : []
		expect(rows).toHaveLength(parentCount)
		for (const row of rows) {
			const contacts = isRecord(row) && Array.isArray(row.contacts) ? row.contacts : []
			expect(contacts).toHaveLength(1)
			const contact = contacts[0]
			const account = isRecord(contact) ? contact.account : undefined
			expect(isRecord(account) ? account.id : undefined).toBe(isRecord(row) ? row.id : undefined)
		}

		// 50-row link/unlink cycle against a single parent's `reps` through relation — verify the
		// `links` count grows to exactly 50, then shrinks back to exactly 0.
		await seedAccount(manager, 'hub')
		const repIds = Array.from(
			{ length: 50 },
			(_unused, index) => `rep${String(index).padStart(3, '0')}`,
		)
		for (const id of repIds) await seedRep(manager, id)

		for (let i = 0; i < repIds.length; i++) {
			await tool.execute({
				operation: 'link',
				model: 'accounts',
				key: 'hub',
				relation: 'reps',
				target: repIds[i],
			})
			const result = await tool.execute({
				operation: 'links',
				model: 'accounts',
				key: 'hub',
				relation: 'reps',
			})
			expect(isRecord(result) ? result.count : undefined).toBe(i + 1)
		}

		for (let i = 0; i < repIds.length; i++) {
			await tool.execute({
				operation: 'unlink',
				model: 'accounts',
				key: 'hub',
				relation: 'reps',
				target: repIds[i],
			})
			const result = await tool.execute({
				operation: 'links',
				model: 'accounts',
				key: 'hub',
				relation: 'reps',
			})
			expect(isRecord(result) ? result.count : undefined).toBe(repIds.length - (i + 1))
		}
	})
})

// ── createInferTool — standalone JSON-Schema-from-samples utility ───────────

describe('createInferTool', () => {
	it('infers a parameters record from homogeneous object samples, deep-equal to the known contract 0.0.6 output', async () => {
		const tool = createInferTool()
		const manager = createToolManager()
		manager.add(tool)
		const result = await manager.execute({
			id: 'call-1',
			name: INFER_TOOL_NAME,
			arguments: {
				samples: [
					{ id: 1, name: 'Ada' },
					{ id: 2, name: 'Bob' },
				],
			},
		})
		expect(result.error).toBeUndefined()
		expect(result.value).toEqual({
			type: 'object',
			properties: { id: { type: 'integer' }, name: { type: 'string' } },
			required: ['id', 'name'],
			additionalProperties: false,
		})
	})

	it('the format toggle adds a string format only when true', async () => {
		const tool = createInferTool()
		const samples = [
			{ createdAt: '2024-01-01T00:00:00.000Z' },
			{ createdAt: '2024-02-01T00:00:00.000Z' },
		]
		const withoutFormat = await tool.execute({ samples })
		expect(withoutFormat).toEqual({
			type: 'object',
			properties: { createdAt: { type: 'string' } },
			required: ['createdAt'],
			additionalProperties: false,
		})
		const withFormat = await tool.execute({ samples, format: true })
		expect(withFormat).toEqual({
			type: 'object',
			properties: { createdAt: { type: 'string', format: 'date-time' } },
			required: ['createdAt'],
			additionalProperties: false,
		})
	})

	it('the enum toggle adds an enum constraint only when true', async () => {
		const tool = createInferTool()
		const samples = [{ status: 'open' }, { status: 'open' }, { status: 'closed' }]
		const withoutEnum = await tool.execute({ samples })
		expect(withoutEnum).toEqual({
			type: 'object',
			properties: { status: { type: 'string' } },
			required: ['status'],
			additionalProperties: false,
		})
		const withEnum = await tool.execute({ samples, enum: true })
		expect(withEnum).toEqual({
			type: 'object',
			properties: { status: { enum: ['closed', 'open'] } },
			required: ['status'],
			additionalProperties: false,
		})
	})

	it('zero samples THROWS a typed TOOL AgentToolError, surfaced through the manager error envelope', async () => {
		const tool = createInferTool()
		const manager = createToolManager()
		manager.add(tool)
		const result = await manager.execute({
			id: 'call-1',
			name: INFER_TOOL_NAME,
			arguments: { samples: [] },
		})
		expect(result.value).toBeUndefined()
		expect(result.error).toBeDefined()

		const direct = await rejectionOf(tool.execute({ samples: [] }))
		expect(isAgentToolError(direct) ? direct.code : undefined).toBe('TOOL')
	})

	it('malformed args (missing samples) THROW a typed TOOL AgentToolError', async () => {
		const tool = createInferTool()
		const missing = await rejectionOf(tool.execute({}))
		expect(isAgentToolError(missing) ? missing.code : undefined).toBe('TOOL')

		const wrongType = await rejectionOf(tool.execute({ samples: 'not-an-array' }))
		expect(isAgentToolError(wrongType) ? wrongType.code : undefined).toBe('TOOL')
	})

	it('name/description overrides are advertised on the returned ToolInterface', () => {
		const tool = createInferTool({ name: 'schema', description: 'Custom description.' })
		expect(tool.name).toBe('schema')
		expect(tool.description).toBe('Custom description.')
	})

	it('defaults: omitted format/enum behave as false', async () => {
		const tool = createInferTool()
		const dateResult = await tool.execute({
			samples: [{ at: '2024-01-01T00:00:00.000Z' }],
		})
		expect(isRecord(dateResult) && isRecord(dateResult.properties)).toBe(true)
		const atSchema =
			isRecord(dateResult) && isRecord(dateResult.properties) ? dateResult.properties.at : undefined
		expect(isRecord(atSchema) ? atSchema.format : undefined).toBeUndefined()
	})

	it('heterogeneous samples (mixed object/string) still return a valid, value-wrapped parameters record', async () => {
		const tool = createInferTool()
		const result = await tool.execute({ samples: [{ a: 1 }, 'x'] })
		expect(result).toEqual({
			type: 'object',
			properties: {
				value: {
					anyOf: [
						{
							type: 'object',
							properties: { a: { type: 'integer' } },
							required: ['a'],
							additionalProperties: false,
						},
						{ type: 'string' },
					],
				},
			},
			required: ['value'],
			additionalProperties: false,
		})
	})

	it('deep nesting and a large array sample complete without throwing', async () => {
		const tool = createInferTool()
		const deep = { a: { b: { c: { d: { e: 'leaf' } } } } }
		const array = Array.from({ length: 200 }, (_, i) => i)
		const result = await tool.execute({ samples: [{ deep, array }] })
		expect(result).toBeDefined()
	})

	it('(c1) mixed candidates: correct indexes, valid true/false/false, coercible discriminates, faults present and non-empty ONLY on non-coercible entries', async () => {
		const tool = createInferTool()
		const samples = [
			{ id: 1, name: 'Ada' },
			{ id: 2, name: 'Bob' },
		]
		const result = await tool.execute({
			samples,
			candidates: [{ id: 3, name: 'Cy' }, { id: 4 }, 'not-a-record'],
		})
		expect(isRecord(result) ? result.checks : undefined).toEqual([
			{ index: 0, valid: true, coercible: true },
			{
				index: 1,
				valid: false,
				coercible: false,
				faults: [{ reason: 'missing', path: ['name'], expected: 'string' }],
			},
			{
				index: 2,
				valid: false,
				coercible: false,
				faults: [{ reason: 'type', path: [], expected: 'object', received: '"not-a-record"' }],
			},
		])
	})

	it('(c2) strict-verdict pin: a candidate that WOULD coerce under a normalizing parse is still INVALID under the strict guard, yielding coercible: true with EMPTY faults', async () => {
		const tool = createInferTool()
		const result = await tool.execute({
			samples: [{ name: 'Ada' }],
			candidates: [{ name: 7 }],
		})
		// contrast: createEndpointTool's enforcement NORMALIZES via `.parse` (7 coerces to '7' and
		// would be accepted); createInferTool's candidate check uses the strict `.is` guard, where a
		// number is never a string regardless of whether it coerces cleanly. `coercible: true` reports
		// that the normalizing parse WOULD accept it, and `.explain` mirrors that leniency — so
		// `faults` stays empty even though `valid` is false.
		expect(isRecord(result) && Array.isArray(result.checks) ? result.checks[0] : undefined).toEqual(
			{ index: 0, valid: false, coercible: true, faults: [] },
		)
	})

	it('(c2b) non-coercible wrong-type candidate: a boolean in a string slot is invalid AND non-coercible, with non-empty faults', async () => {
		const tool = createInferTool()
		const result = await tool.execute({
			samples: [{ name: 'Ada' }],
			candidates: [{ name: true }],
		})
		// discriminates the three cases together with c1's index-0 (conformant: valid + coercible)
		// and c2's index-0 (coercible-only: !valid but coercible) — this is the fully-rejected case:
		// !valid and !coercible, with faults populated.
		expect(isRecord(result) && Array.isArray(result.checks) ? result.checks[0] : undefined).toEqual(
			{
				index: 0,
				valid: false,
				coercible: false,
				faults: [{ reason: 'type', path: ['name'], expected: 'string', received: 'true' }],
			},
		)
	})

	it('(c3) empty candidates array returns wrapped { parameters, checks: [] }, parameters deep-equal to the bare no-candidates return', async () => {
		const tool = createInferTool()
		const samples = [{ id: 1, name: 'Ada' }]
		const bare = await tool.execute({ samples })
		const wrapped = await tool.execute({ samples, candidates: [] })
		expect(isRecord(wrapped) ? wrapped.checks : undefined).toEqual([])
		expect(isRecord(wrapped) ? wrapped.parameters : undefined).toEqual(bare)
	})

	it('(c4) no candidates returns the bare parameters record, NOT a { parameters, checks } wrapper', async () => {
		const tool = createInferTool()
		const result = await tool.execute({ samples: [{ id: 1, name: 'Ada' }] })
		expect(isRecord(result) ? 'checks' in result : undefined).toBe(false)
		expect(result).toEqual({
			type: 'object',
			properties: { id: { type: 'integer' }, name: { type: 'string' } },
			required: ['id', 'name'],
			additionalProperties: false,
		})
	})

	it('(c5) bare-value samples check candidates against the RAW string schema, not a value-wrapped object', async () => {
		const tool = createInferTool()
		const result = await tool.execute({ samples: ['a', 'b'], candidates: ['x', 7] })
		expect(isRecord(result) ? result.parameters : undefined).toEqual({
			type: 'object',
			properties: { value: { type: 'string' } },
			required: ['value'],
			additionalProperties: false,
		})
		expect(isRecord(result) ? result.checks : undefined).toEqual([
			{ index: 0, valid: true, coercible: true },
			{ index: 1, valid: false, coercible: true, faults: [] },
		])
	})

	it('(c6) enum:true rejects an out-of-enum candidate and accepts an in-enum one; format:true never asserts format on a check', async () => {
		const tool = createInferTool()
		const enumResult = await tool.execute({
			samples: [{ status: 'open' }, { status: 'open' }, { status: 'closed' }],
			enum: true,
			candidates: [{ status: 'closed' }, { status: 'unknown' }],
		})
		expect(isRecord(enumResult) ? enumResult.checks : undefined).toEqual([
			{ index: 0, valid: true, coercible: true },
			{
				index: 1,
				valid: false,
				coercible: false,
				faults: [{ reason: 'type', path: ['status'], expected: 'literal', received: '"unknown"' }],
			},
		])

		const formatResult = await tool.execute({
			samples: [{ at: '2024-01-01T00:00:00.000Z' }],
			format: true,
			candidates: [{ at: 'not-an-email' }],
		})
		// format is never asserted — a non-email string in an email-inferred slot is still VALID.
		expect(isRecord(formatResult) ? formatResult.checks : undefined).toEqual([
			{ index: 0, valid: true, coercible: true },
		])
	})

	it('(c7) hostile candidates complete without an unhandled throw escaping to the manager', async () => {
		const tool = createInferTool()
		const manager = createToolManager()
		manager.add(tool)

		// a __proto__-carrying JSON.parse'd candidate is a plain JSON-safe value — it reaches
		// checker.is/.explain (both total) and yields a bounded, non-throwing verdict.
		const hostileParsed = JSON.parse('{"name":"Ada","__proto__":{"polluted":true}}')
		const parsedResult = await manager.execute({
			id: 'call-1',
			name: INFER_TOOL_NAME,
			arguments: { samples: [{ name: 'Ada' }], candidates: [hostileParsed] },
		})
		expect(parsedResult.error).toBeUndefined()
		const checks = isRecord(parsedResult.value) ? parsedResult.value.checks : undefined
		expect(Array.isArray(checks)).toBe(true)
		const verdicts = Array.isArray(checks)
			? checks.map((check) => (isRecord(check) ? check.valid : undefined))
			: []
		expect(verdicts.every((valid) => typeof valid === 'boolean')).toBe(true)

		// a throwing-getter Proxy is not a JSON-safe value at all — the outer args parse rejects it
		// (same shape family as `samples`/`format`/`enum`), surfaced through the EXISTING malformed
		// -args TOOL error path via the manager envelope, never as an unhandled exception.
		const proxy = new Proxy(
			{ name: 'Ada' },
			{
				get() {
					throw new Error('hostile getter')
				},
			},
		)
		const proxyResult = await manager.execute({
			id: 'call-2',
			name: INFER_TOOL_NAME,
			arguments: { samples: [{ name: 'Ada' }], candidates: [proxy] },
		})
		expect(proxyResult.value).toBeUndefined()
		expect(proxyResult.error).toBeDefined()
	})

	it('(c8) malformed candidates arg (not an array) THROWS the existing TOOL error through the manager envelope', async () => {
		const tool = createInferTool()
		const manager = createToolManager()
		manager.add(tool)
		const result = await manager.execute({
			id: 'call-1',
			name: INFER_TOOL_NAME,
			arguments: { samples: [{ id: 1 }], candidates: 'nope' },
		})
		expect(result.value).toBeUndefined()
		expect(result.error).toBeDefined()

		const direct = await rejectionOf(tool.execute({ samples: [{ id: 1 }], candidates: 'nope' }))
		expect(isAgentToolError(direct) ? direct.code : undefined).toBe('TOOL')
	})
})

// ── createEndpointTool — wraps one concrete endpoint over an inferred schema ─

describe('createEndpointTool', () => {
	it('infers and advertises parameters from samples', () => {
		const tool = createEndpointTool({
			name: 'lookupUser',
			description: 'Look up a user by id.',
			samples: [
				{ id: '1', name: 'Ada' },
				{ id: '2', name: 'Bob' },
			],
			invoke: (args) => args,
		})
		expect(tool.parameters).toEqual({
			type: 'object',
			properties: { id: { type: 'string' }, name: { type: 'string' } },
			required: ['id', 'name'],
			additionalProperties: false,
		})
	})

	it('validate: false PASSTHROUGH: invoke receives the model-supplied args EXACTLY (same reference), even when they diverge from the inferred schema', async () => {
		let received: unknown
		const tool = createEndpointTool(
			{
				name: 'echo',
				description: 'Echoes call args.',
				samples: [{ id: '1' }],
				invoke: (args) => {
					received = args
					return null
				},
			},
			{ validate: false },
		)
		const args = { id: 'unrelated-shape', extra: { nested: true }, list: [1, 2, 3] }
		await tool.execute(args)
		expect(received).toBe(args)
	})

	it('default validation COERCES a scalar to its inferred type before invoke runs', async () => {
		let received: unknown
		const tool = createEndpointTool({
			name: 'lookupUser',
			description: 'Look up a user by id.',
			samples: [
				{ id: '1', name: 'a' },
				{ id: '2', name: 'b' },
			],
			invoke: (args) => {
				received = args
				return args
			},
		})
		await tool.execute({ id: 7, name: 'x' })
		expect(received).toEqual({ id: '7', name: 'x' })
	})

	it('a nonconforming call THROWS a typed TOOL AgentToolError carrying non-empty explain faults', async () => {
		const tool = createEndpointTool({
			name: 'lookupUser',
			description: 'Look up a user by id.',
			samples: [
				{ id: '1', name: 'a' },
				{ id: '2', name: 'b' },
			],
			invoke: (args) => args,
		})
		const error = await rejectionOf(
			Promise.resolve().then(() => tool.execute({ id: true, name: 'Ada' })),
		)
		expect(isAgentToolError(error)).toBe(true)
		expect(isAgentToolError(error) ? error.code : undefined).toBe('TOOL')
		const faults = isAgentToolError(error) ? error.context?.faults : undefined
		expect(Array.isArray(faults)).toBe(true)
		expect(Array.isArray(faults) ? faults.length : 0).toBeGreaterThan(0)
	})

	it('a sync invoke result flows back as the manager value', async () => {
		const tool = createEndpointTool({
			name: 'add',
			description: 'Adds two numbers.',
			samples: [{ a: 1, b: 2 }],
			invoke: (args) => Number(args.a) + Number(args.b),
		})
		const manager = createToolManager()
		manager.add(tool)
		const result = await manager.execute({
			id: 'call-1',
			name: 'add',
			arguments: { a: 3, b: 4 },
		})
		expect(result.value).toBe(7)
		expect(result.error).toBeUndefined()
	})

	it('an async invoke result flows back as the manager value', async () => {
		const tool = createEndpointTool({
			name: 'fetchUser',
			description: 'Fetches a user by id.',
			samples: [{ id: '1' }],
			invoke: async (args) => {
				await Promise.resolve()
				return { id: args.id, name: 'Ada' }
			},
		})
		const manager = createToolManager()
		manager.add(tool)
		const result = await manager.execute({
			id: 'call-1',
			name: 'fetchUser',
			arguments: { id: '1' },
		})
		expect(result.value).toEqual({ id: '1', name: 'Ada' })
	})

	it('invoke throwing surfaces exactly once through the manager error envelope, never double-wrapped', async () => {
		const tool = createEndpointTool({
			name: 'boom',
			description: 'Always fails.',
			samples: [{ x: 1 }],
			invoke: () => {
				throw new Error('endpoint failure')
			},
		})
		const manager = createToolManager()
		manager.add(tool)
		const result = await manager.execute({ id: 'call-1', name: 'boom', arguments: { x: 1 } })
		expect(result.value).toBeUndefined()
		expect(result.error).toBe('endpoint failure')
		expect(result.error?.split('endpoint failure').length).toBe(2)
	})

	it('async invoke rejecting surfaces exactly once through the manager error envelope, never double-wrapped', async () => {
		const tool = createEndpointTool({
			name: 'asyncBoom',
			description: 'Always rejects.',
			samples: [{ x: 1 }],
			invoke: async () => {
				await Promise.resolve()
				throw new Error('async endpoint failure')
			},
		})
		const manager = createToolManager()
		manager.add(tool)
		const result = await manager.execute({ id: 'call-1', name: 'asyncBoom', arguments: { x: 1 } })
		expect(result.value).toBeUndefined()
		expect(result.error).toBe('async endpoint failure')
		expect(result.error?.split('async endpoint failure').length).toBe(2)
	})

	it('empty samples THROWS a typed TOOL AgentToolError at construction', () => {
		let caught: unknown
		try {
			createEndpointTool({
				name: 'empty',
				description: 'No samples.',
				samples: [],
				invoke: (args) => args,
			})
		} catch (error) {
			caught = error
		}
		expect(isAgentToolError(caught)).toBe(true)
		expect(isAgentToolError(caught) ? caught.code : undefined).toBe('TOOL')
	})

	it('format/enum options change the advertised parameters', () => {
		const samples = [{ status: 'open' }, { status: 'open' }, { status: 'closed' }]
		const withoutEnum = createEndpointTool({
			name: 'status',
			description: 'Status endpoint.',
			samples,
			invoke: (args) => args,
		})
		expect(withoutEnum.parameters).toEqual({
			type: 'object',
			properties: { status: { type: 'string' } },
			required: ['status'],
			additionalProperties: false,
		})
		const withEnum = createEndpointTool(
			{ name: 'status', description: 'Status endpoint.', samples, invoke: (args) => args },
			{ enum: true },
		)
		expect(withEnum.parameters).toEqual({
			type: 'object',
			properties: { status: { enum: ['closed', 'open'] } },
			required: ['status'],
			additionalProperties: false,
		})
	})

	it('advertises the descriptor name/description', () => {
		const tool = createEndpointTool({
			name: 'custom',
			description: 'A custom endpoint.',
			samples: [{ x: 1 }],
			invoke: (args) => args,
		})
		expect(tool.name).toBe('custom')
		expect(tool.description).toBe('A custom endpoint.')
	})

	it('non-object root samples (bare strings) advertise a value-wrapped root', () => {
		const tool = createEndpointTool({
			name: 'text',
			description: 'Bare string samples.',
			samples: ['a', 'b', 'c'],
			invoke: (args) => args,
		})
		expect(tool.parameters).toEqual({
			type: 'object',
			properties: { value: { type: 'string' } },
			required: ['value'],
			additionalProperties: false,
		})
	})

	it('non-object root samples (bare strings), validate: false: invoke receives raw args unchecked', async () => {
		let received: unknown
		const tool = createEndpointTool(
			{
				name: 'text',
				description: 'Bare string samples.',
				samples: ['a', 'b', 'c'],
				invoke: (args) => {
					received = args
					return 'ok'
				},
			},
			{ validate: false },
		)
		const args = { value: 'hello', unrelated: true }
		await tool.execute(args)
		expect(received).toEqual(args)
	})

	// ── default validation (v1–v8) ──────────────────────────────────────────

	it('(v1) conforming args parse and reach invoke as a record deep-equal to the sent args', async () => {
		let received: unknown
		const tool = createEndpointTool({
			name: 'lookupUser',
			description: 'Look up a user by id.',
			samples: [
				{ id: '1', name: 'Ada' },
				{ id: '2', name: 'Bob' },
			],
			invoke: (args) => {
				received = args
				return args
			},
		})
		const args = { id: '1', name: 'Ada' }
		await tool.execute(args)
		// Normalization yields a parsed COPY, not the same reference — assert deep-equal.
		expect(received).toEqual(args)
	})

	it('(v2) nonconforming args (wrong property type) reject through the manager error envelope exactly once; construction never throws', async () => {
		const tool = createEndpointTool({
			name: 'lookupUser',
			description: 'Look up a user by id.',
			samples: [{ id: '1', name: 'Ada' }],
			invoke: (args) => args,
		})
		const manager = createToolManager()
		manager.add(tool)
		const result = await manager.execute({
			id: 'call-1',
			name: 'lookupUser',
			// A boolean does not coerce to a string (unlike a number, which `parseString` stringifies) —
			// this is a genuine type mismatch, verified against the compiled contract directly.
			arguments: { id: true, name: 'Ada' },
		})
		expect(result.value).toBeUndefined()
		expect(result.error).toBeDefined()
		expect(result.error?.split('malformed endpoint call arguments').length).toBe(2)
	})

	it('(v3) missing required key is rejected; an extra key against a closed inferred schema is silently DROPPED before invoke by default, passed through raw under validate: false', async () => {
		// Verified against `@orkestrel/contract` 0.0.7 directly (`compileParser` / `compileReporter`
		// docs): a closed object's extra keys never fault — `parse` silently drops them rather than
		// rejecting the whole object. So the default-validation endpoint below still ACCEPTS a call
		// with an extra key, but `invoke` receives the key stripped; only `validate: false` passes it
		// through raw.
		const definition = {
			name: 'lookupUser',
			description: 'Look up a user by id.',
			samples: [{ id: '1', name: 'Ada' }],
			invoke: (args: Readonly<Record<string, unknown>>) => args,
		}
		const strict = createEndpointTool(definition)
		let caught: unknown
		try {
			await strict.execute({ id: '1' })
		} catch (error) {
			caught = error
		}
		expect(isAgentToolError(caught)).toBe(true)
		expect(isAgentToolError(caught) ? caught.code : undefined).toBe('TOOL')

		let strictReceived: unknown
		const strictWithRecorder = createEndpointTool({
			...definition,
			invoke: (args) => {
				strictReceived = args
				return args
			},
		})
		await strictWithRecorder.execute({ id: '1', name: 'Ada', extra: true })
		expect(strictReceived).toEqual({ id: '1', name: 'Ada' })

		let received: unknown
		const lenient = createEndpointTool(
			{
				...definition,
				invoke: (args) => {
					received = args
					return args
				},
			},
			{ validate: false },
		)
		await lenient.execute({ id: '1', name: 'Ada', extra: true })
		expect(received).toEqual({ id: '1', name: 'Ada', extra: true })
	})

	it('(v4) enum enforcement: an { enum: true } endpoint over repeated literal samples rejects an out-of-enum value and accepts an in-enum one', async () => {
		const samples = [{ status: 'open' }, { status: 'open' }, { status: 'closed' }]
		let received: unknown
		const tool = createEndpointTool(
			{
				name: 'status',
				description: 'Status endpoint.',
				samples,
				invoke: (args) => {
					received = args
					return args
				},
			},
			{ enum: true },
		)
		await tool.execute({ status: 'closed' })
		expect(received).toEqual({ status: 'closed' })
		let caught: unknown
		try {
			await tool.execute({ status: 'pending' })
		} catch (error) {
			caught = error
		}
		expect(isAgentToolError(caught)).toBe(true)
	})

	it('(v5) format is NOT enforced: a { format: true } endpoint over email-shaped samples still accepts a non-email string', async () => {
		let received: unknown
		const tool = createEndpointTool(
			{
				name: 'notify',
				description: 'Notify by email.',
				samples: [{ email: 'ada@example.com' }, { email: 'bob@example.com' }],
				invoke: (args) => {
					received = args
					return args
				},
			},
			{ format: true },
		)
		await tool.execute({ email: 'not-an-email' })
		expect(received).toEqual({ email: 'not-an-email' })
	})

	it('(v6) value-wrap enforcement: bare-string samples under default validation accept { value: string } and reject { value: boolean }', async () => {
		let received: unknown
		const tool = createEndpointTool({
			name: 'text',
			description: 'Bare string samples.',
			samples: ['a', 'b', 'c'],
			invoke: (args) => {
				received = args
				return args
			},
		})
		await tool.execute({ value: 'hello' })
		expect(received).toEqual({ value: 'hello' })
		let caught: unknown
		try {
			// A boolean does not coerce to a string (unlike a number) — a genuine type mismatch.
			await tool.execute({ value: true })
		} catch (error) {
			caught = error
		}
		expect(isAgentToolError(caught)).toBe(true)
	})

	it("(v7) hostile args: a __proto__-carrying JSON.parse'd object flows through parse without polluting, and a throwing-getter Proxy yields the canonical TOOL error, never an unhandled throw", async () => {
		const tool = createEndpointTool({
			name: 'lookupUser',
			description: 'Look up a user by id.',
			samples: [{ id: '1', name: 'Ada' }],
			invoke: (args) => args,
		})
		const hostile = JSON.parse('{"id":"1","name":"Ada","__proto__":{"polluted":true}}') as Record<
			string,
			unknown
		>
		const result = await tool.execute(hostile)
		expect(isRecord(result) ? result.polluted : undefined).toBeUndefined()
		expect(({} as Record<string, unknown>).polluted).toBeUndefined()

		const proxy = new Proxy(
			{ id: '1', name: 'Ada' },
			{
				get() {
					throw new Error('hostile getter')
				},
			},
		)
		const manager = createToolManager()
		manager.add(tool)
		const proxyResult = await manager.execute({
			id: 'call-1',
			name: 'lookupUser',
			arguments: proxy,
		})
		expect(proxyResult.value).toBeUndefined()
		expect(proxyResult.error).toBeDefined()
	})

	it('(v8) construction compiles the contract once — many executes with identical args stay fast and behave identically', async () => {
		const samples = Array.from({ length: 50 }, (_, i) => ({ id: String(i), name: `user-${i}` }))
		const tool = createEndpointTool({
			name: 'lookupUser',
			description: 'Look up a user by id.',
			samples,
			invoke: (args) => args,
		})
		const args = { id: '1', name: 'Ada' }
		const start = performance.now()
		for (let i = 0; i < 200; i++) {
			await tool.execute(args)
		}
		const elapsed = performance.now() - start
		expect(elapsed).toBeLessThan(1000)
	})
})
