import type { ContractInterface } from '@orkestrel/contract'
import type { AgentInterface, AgentRegistryInterface } from '@orkestrel/agent'
import type { WorkspaceManagerInterface } from '@orkestrel/workspace'
import type { ToolInterface, ToolManagerInterface } from '@orkestrel/tool'
import type {
	WorkflowDefinition,
	WorkflowFunction,
	WorkflowRegistry,
	WorkflowRunnerInterface,
	TaskControllerInterface,
} from '@orkestrel/workflow'
import type {
	AgentFunction,
	AgentFunctionOptions,
	WorkflowAgents,
	AgentToolArguments,
	AgentToolOptions,
	AnswerToolOptions,
	DatabaseDefinition,
	DatabaseDefinitionRow,
	DatabaseToolOptions,
	DefinitionStoreInterface,
	EndpointDefinition,
	EndpointToolOptions,
	InferToolOptions,
	PromptToolOptions,
	RelationToolOptions,
	WorkflowDraft,
	WorkflowSteps,
	WorkflowToolOptions,
	WorkspaceOperation,
	WorkspaceToolOptions,
} from './types.js'
import type { DatabaseInterface, DriverInterface, TableInterface } from '@orkestrel/database'
import { agentResultToJSON } from '@orkestrel/agent'
import { createWorkspaceManager, isTextContent, rangeOf } from '@orkestrel/workspace'
import { createTool, ToolError } from '@orkestrel/tool'
import {
	arrayOf,
	attempt,
	cloneJSONRecord,
	createContract,
	describeFaults,
	isArray,
	isError,
	isFunction,
	isNonNegativeInteger,
	isNumber,
	isString,
	parseJSONValue,
	preview,
	rawShape,
	renderList,
	samplesToSchema,
	schemaToObject,
	schemaToParameters,
	schemaToShape,
	stringShape,
} from '@orkestrel/contract'
import { isTerminalError } from '@orkestrel/terminal'
import { createForm, FIELD_CONTROLS, isFormError, isFormValues, parseForm } from '@orkestrel/form'
import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import { createWorkflowContract } from '@orkestrel/workflow'
import { MemoryDefinitionStore } from './stores/MemoryDefinitionStore.js'
import { DatabaseDefinitionStore } from './stores/DatabaseDefinitionStore.js'
import { DatabaseResolver } from './databases/DatabaseResolver.js'
import {
	AGENT_TOOL_DEPTH,
	AGENT_TOOL_DESCRIPTION,
	AGENT_TOOL_NAME,
	AGENT_TOOL_SUMMARY,
	ANSWER_TOOL_DESCRIPTION,
	ANSWER_TOOL_NAME,
	ANSWER_TOOL_SUMMARY,
	DATABASE_TOOL_DESCRIPTION,
	DATABASE_TOOL_LIMIT,
	DATABASE_TOOL_MUTATIONS,
	DATABASE_TOOL_NAME,
	DATABASE_TOOL_SUMMARY,
	DESCRIBE_TOOL_DESCRIPTION,
	DESCRIBE_TOOL_NAME,
	DESCRIBE_TOOL_SUMMARY,
	INFER_TOOL_DESCRIPTION,
	INFER_TOOL_NAME,
	INFER_TOOL_SUMMARY,
	MAX_WORKFLOW_CHAIN,
	PROMPT_TOOL_DESCRIPTION,
	PROMPT_TOOL_NAME,
	PROMPT_TOOL_SUMMARY,
	RELATION_TOOL_DEPTH,
	RELATION_TOOL_DESCRIPTION,
	RELATION_TOOL_LIMIT,
	RELATION_TOOL_NAME,
	RELATION_TOOL_SUMMARY,
	WORKFLOW_TOOL_DESCRIPTION,
	WORKFLOW_TOOL_FLAT_EXAMPLE,
	WORKFLOW_TOOL_NAME,
	WORKFLOW_TOOL_SUMMARY,
	WORKSPACE_TOOL_DESCRIPTION,
	WORKSPACE_TOOL_NAME,
	WORKSPACE_TOOL_SUMMARY,
} from './constants.js'
import { ToolboxError, isToolboxError } from './errors.js'
import {
	clampQuery,
	resolveWorkflowTarget,
	deriveWorkflowDepth,
	expandInclude,
	extendLineage,
	inferDatabaseCode,
	inferRelationCode,
	inferTerminalCode,
	limitRefusal,
	normalizeLineage,
	normalizeQuery,
	renderCandidates,
	requireActiveWorkspace,
	requireToolCall,
	resolveBound,
	resolveLimit,
	resolveRelationManager,
	resolveRelationModel,
	summarizeWorkflow,
	tagAgent,
	tagWorkflow,
} from './helpers.js'
import { expandTables } from './compilers.js'
import { isAgentFunction } from './validators.js'
import {
	agentToolShape,
	answerToolShape,
	databaseToolShape,
	describeToolShape,
	inferToolShape,
	promptToolShape,
	relationToolShape,
	workflowDraftShape,
	workflowStepsShape,
	workspaceToolShape,
} from './shapers.js'

// This package's tool factories. `createWorkflowTool` owns authoring translation and boundary
// policy while delegating execution/persistence to `@orkestrel/workflow`; `createWorkspaceTool`
// owns the model-facing operation dispatch over `@orkestrel/workspace`; `createAgentTool` owns
// sub-agent delegation over an `AgentRegistryInterface`.

/**
 * Wraps a registered tool as a {@link WorkflowFunction} (`@orkestrel/workflow`) — the opt-in
 * adapter that lets a `function`-form task run a `@orkestrel/tool` tool by name.
 *
 * @remarks
 * Composes into a caller's `WorkflowOptions.functions` registry like any other behavior
 * (`{ publish: createToolFunction(tools, 'publish') }`); the pure workflow runner has no
 * knowledge of tools itself. The returned function executes `name` against `tools` with the
 * task's `controller.input` as the call arguments. The adapter resolves the live tool, calls its
 * `execute` method directly, and deep-gates the returned unknown through `parseJSONValue`. The
 * execution context it passes carries the task's own `controller.signal`, so a handler that
 * reads `context.signal` observes the caller's cancellation.
 * Genuine execution throws retain identity. An unregistered name or non-JSON return throws this
 * package's typed `TOOL` `ToolboxError`.
 *
 * @param tools - The `ToolManagerInterface` (`@orkestrel/tool`) the named tool is registered on
 * @param name - The registered tool's name
 * @returns A {@link WorkflowFunction} that runs the named tool
 *
 * @example
 * ```ts
 * import { createToolFunction } from '@src/core'
 * import { createToolManager } from '@orkestrel/tool'
 * import { createWorkflowRunner } from '@orkestrel/workflow'
 *
 * const tools = createToolManager()
 * tools.add(myPublishTool)
 * const runner = createWorkflowRunner()
 * await runner.execute(definition, { functions: { publish: createToolFunction(tools, 'publish') } })
 * ```
 */
export function createToolFunction(tools: ToolManagerInterface, name: string): WorkflowFunction {
	if (name === WORKFLOW_TOOL_NAME) {
		throw new ToolboxError('TOOL', `tool '${WORKFLOW_TOOL_NAME}' is reserved for live workflows`, {
			tool: name,
		})
	}
	return async (controller) => {
		const tool = tools.tool(name)
		if (tool === undefined) {
			throw new ToolboxError('TOOL', `tool '${name}' is not registered`, { tool: name })
		}
		const result = parseJSONValue(
			await tool.execute(controller.input, { signal: controller.signal }),
		)
		if (result === undefined) {
			throw new ToolboxError('TOOL', `tool '${name}' returned a non-JSON value`, { tool: name })
		}
		return result
	}
}

/**
 * Wraps a live `AgentInterface` (`@orkestrel/agent`) as a {@link WorkflowFunction}
 * (`@orkestrel/workflow`) — the opt-in adapter that runs the agent to a settled result and carries
 * immutable lineage metadata for contextual Toolbox composition.
 *
 * @remarks
 * Composes into a caller's registry like any other behavior; the pure workflow runner has no
 * knowledge of agents itself. A root adapter derives its workflow lineage from the controller,
 * while a contextual adapter requires an exact match. Repeated agents, repeated workflows, and
 * targets deeper than {@link import('./constants.js').MAX_WORKFLOW_CHAIN} are rejected before
 * agent or runner activity. When {@link import('./types.js').AgentFunctionOptions.runner} is
 * supplied, the adapter binds a recursion-safe {@link createWorkflowTool} onto the agent's
 * `context.tools`, propagating opaque leaves, raw agents, lineage, and the native store. The agent
 * needs an `authority` of its own to run that tool, because an agent with none denies every call. The
 * task's cancellation propagates through the Agent's native per-run signal seam:
 * `agent.generate({ signal: controller.signal })` resolves a partial `AgentResult` on a cancel
 * (never rejects), projected onto its exact JSON fields.
 *
 * A bound agent is single-run. A concurrent branch sharing the same real agent is rejected before
 * its fixed {@link import('./constants.js').WORKFLOW_TOOL_NAME} binding can be replaced. Toolbox
 * cannot serialize opaque external wrappers that hide or bypass the raw agent registry; hosts
 * must give such concurrent work distinct agents.
 *
 * @param agent - The live `AgentInterface` to run
 * @param options - The nested-workflow composition and lineage options
 * @returns A frozen {@link AgentFunction} that runs `agent` to its settled result
 *
 * @example
 * ```ts
 * import { createAgentFunction } from '@src/core'
 * import { createWorkflowRunner } from '@orkestrel/workflow'
 *
 * const runner = createWorkflowRunner()
 * const review = createAgentFunction(myAgent, { runner })
 * await runner.execute(definition, { functions: { review } })
 * ```
 */
export function createAgentFunction(
	agent: AgentInterface,
	options?: AgentFunctionOptions,
): AgentFunction {
	const lineage = normalizeLineage(options?.lineage)
	if (lineage.length > 0 && !lineage.at(-1)?.startsWith('workflow:')) {
		throw new ToolboxError('TOOL', 'agent function lineage must end with a workflow tag')
	}
	const functions =
		options?.functions === undefined ? undefined : Object.freeze({ ...options.functions })
	const agents = options?.agents === undefined ? undefined : Object.freeze({ ...options.agents })
	const metadata: Pick<AgentFunction, 'category' | 'lineage'> = {
		category: 'agent',
		lineage,
	}
	return Object.freeze(
		Object.assign(async (controller: TaskControllerInterface) => {
			const workflow = tagWorkflow(controller.task.phase.workflow.id)
			const current = lineage.length === 0 ? extendLineage(lineage, workflow) : lineage
			if (current.at(-1) !== workflow) {
				throw new ToolboxError('DEPTH', 'agent function workflow does not match its lineage', {
					workflow,
					lineage: [...current],
				})
			}
			const depth = deriveWorkflowDepth(current)
			// Reject over-depth or re-entry before the agent, tool registry, or runner becomes active.
			if (depth > MAX_WORKFLOW_CHAIN) {
				throw new ToolboxError('DEPTH', `agent '${agent.id}' exceeds max workflow depth`, {
					agent: agent.id,
					depth,
					max: MAX_WORKFLOW_CHAIN,
				})
			}
			const tag = tagAgent(agent.id)
			if (current.includes(tag)) {
				throw new ToolboxError('DEPTH', `agent '${agent.id}' is already an ancestor (cycle)`, {
					agent: agent.id,
					lineage: [...current],
				})
			}
			const nested = extendLineage(current, tag)
			// Bind the nested workflow tool with this agent appended to the immutable lineage.
			const runner = options?.runner
			if (runner !== undefined) {
				if (agent.status === 'running') {
					throw new ToolboxError('TOOL', `agent '${agent.id}' is already running`, {
						agent: agent.id,
					})
				}
				const workflowId = controller.task.phase.workflow.id
				const wrapped: WorkflowDefinition = { id: workflowId, name: workflowId, phases: [] }
				agent.context.tools.add(
					createWorkflowTool(wrapped, runner, {
						lineage: nested,
						...(functions === undefined ? {} : { functions }),
						...(agents === undefined ? {} : { agents }),
						...(options?.store === undefined ? {} : { store: options.store }),
					}),
				)
			}
			// Start synchronously with the task's native per-run signal so Agent owns cancellation,
			// including already-aborted signals and partial-result settlement.
			const generated = agent.generate({ signal: controller.signal })
			const result = agentResultToJSON(await generated)
			if (result === undefined) {
				throw new ToolboxError('TOOL', `agent '${agent.id}' returned a non-JSON result`, {
					agent: agent.id,
				})
			}
			return result
		}, metadata),
	)
}

/**
 * Composes opaque host functions and raw agents into one immutable workflow registry.
 *
 * @remarks
 * This is the target-aware composition boundary used by direct runner consumers and
 * {@link createWorkflowTool}. Opaque leaves are copied unchanged, marked agent adapters are
 * rejected from that channel, raw agents are rebound to the supplied lineage, collisions fail
 * closed, and the returned null-prototype record prevents inherited names from becoming phantom
 * Workflow handlers.
 *
 * @param runner - The native runner propagated into contextual agent adapters
 * @param options - Target lineage, opaque functions, raw agents, and native store
 * @returns A frozen null-prototype snapshot of the target workflow's callable registry
 *
 * @example
 * ```ts
 * import { createWorkflowFunctions } from '@src/core'
 * import { createWorkflowRunner } from '@orkestrel/workflow'
 *
 * const runner = createWorkflowRunner()
 * const functions = createWorkflowFunctions(runner, {
 * 	functions: { publish: async () => 'published' },
 * 	agents: { review: reviewAgent },
 * })
 * await runner.execute(definition, { functions })
 * ```
 */
export function createWorkflowFunctions(
	runner: WorkflowRunnerInterface,
	options?: WorkflowToolOptions,
): WorkflowRegistry {
	const lineage = normalizeLineage(options?.lineage)
	if (lineage.length > 0 && !lineage.at(-1)?.startsWith('workflow:')) {
		throw new ToolboxError('TOOL', 'workflow functions lineage must end with a workflow tag')
	}
	const functions: WorkflowRegistry =
		options?.functions === undefined ? Object.freeze({}) : Object.freeze({ ...options.functions })
	const agents: WorkflowAgents =
		options?.agents === undefined ? Object.freeze({}) : Object.freeze({ ...options.agents })
	const composed: Record<string, WorkflowFunction> = {}
	Object.setPrototypeOf(composed, null)
	for (const [name, fn] of Object.entries(functions)) {
		if (!isFunction(fn)) {
			throw new ToolboxError('TOOL', `workflow function '${name}' is not callable`, {
				function: name,
			})
		}
		if (isAgentFunction(fn)) {
			throw new ToolboxError('TOOL', `agent function '${name}' must be supplied through agents`, {
				function: name,
			})
		}
		composed[name] = fn
	}
	for (const [name, agent] of Object.entries(agents)) {
		if (Object.hasOwn(composed, name)) {
			throw new ToolboxError('TOOL', `workflow function '${name}' collides with an agent`, {
				function: name,
			})
		}
		const fn = createAgentFunction(agent, {
			runner,
			lineage,
			functions,
			agents,
			...(options?.store === undefined ? {} : { store: options.store }),
		})
		composed[name] = fn
	}
	return Object.freeze(composed)
}

/**
 * Compiles the lenient workflow draft contract {@link createWorkflowTool} parses an authored tree
 * with — a `ContractInterface` over a {@link WorkflowDraft}, whose `id` and `name` are optional at
 * the workflow, phase, and task levels.
 *
 * @returns The compiled {@link import('./types.js').WorkflowDraft} contract
 */
export function createWorkflowDraftContract(): ContractInterface<WorkflowDraft> {
	return createContract(workflowDraftShape)
}

/**
 * Wraps a {@link WorkflowDefinition} as an LLM-callable tool — it advertises the flat authoring
 * shape (`{ name?, steps: [{ name }] }`) as its `parameters`, and its handler completes the
 * authored blob, validates it against the strict contract, and runs it through `runner`, forwarding
 * the caller's optional named functions and native checkpoint store.
 *
 * @remarks
 * A plain `ToolManagerInterface`-compatible tool (`@orkestrel/tool`), reproducing
 * Toolbox's flat / draft / full authoring contract, strict soundness gate, and lineage guard.
 * It is also the propagation carrier
 * {@link createAgentFunction} binds onto a wrapped agent's `context.tools`: because a tool
 * handler receives only the model-supplied `args`, the immutable lineage is closed over at bind
 * time. The authored target is appended and its zero-based depth derived from workflow tags. That
 * bound tool wraps the containing workflow's id over no phases, and its empty-args call always
 * refuses as a cycle before the runner, so the wrapper never runs.
 *
 * `parameters` advertises the flat form alone, so the tool is built `strict: false` and its handler
 * runs the door ({@link import('./helpers.js').requireToolCall}) on the form the arguments take.
 *
 * **Widened authoring surface (additive — the canonical contract and runner stay strict and
 * unchanged).** A 2B model reliably calls the tool but cannot reliably emit the full nested
 * {@link WorkflowDefinition}, whose every `id` and `name` is required across an all-or-nothing
 * tree. So the tool accepts the authoring forms that follow and converges them on the same strict
 * `createWorkflowContract` gate before running (soundness preserved):
 * - the flat shape `{ name?, steps: [{ name }] }` — the advertised `parameters` (the simplest
 *   form, {@link import('./helpers.js').expandSteps}'d into one one-task phase per step);
 * - a nested draft with any `id`/`name` omitted — {@link createWorkflowDraftContract}-parsed then
 *   {@link import('./helpers.js').completeDraft}'d (missing ids synthesized positionally);
 * - the full nested {@link WorkflowDefinition} — the advanced escape-hatch, accepted as the draft
 *   super-set.
 *
 * The universal tool-handler contract: returns the plain run summary
 * (`{ status, count, durable?, fault? }`) on success. Malformed authored args throw a `ToolError`
 * with code `ARGUMENTS` (`@orkestrel/tool`) whose text lists what to correct, carrying
 * `context.faults`; a wrapped definition the strict contract refuses throws `TOOL`, and an over-deep
 * or cyclic nested run throws `DEPTH`. Genuine runner `WorkflowError`s are preserved, including
 * `SCHEDULE` for a target with no task. The `ToolManagerInterface` isolates every throw into the canonical tool result's
 * top-level `error`, so nothing escapes the run. `options.lineage` is the propagation carrier
 * across a workflow → agent → workflow chain. Opaque `functions` remain host leaves; raw `agents`
 * are contextually adapted through {@link createWorkflowFunctions}; native checkpoint persistence
 * makes the final snapshot retrievable without a second Toolbox write.
 *
 * @param definition - The workflow the tool runs when called with no authored args
 * @param runner - The `WorkflowRunnerInterface` (`@orkestrel/workflow`) that executes the (nested) workflow
 * @param options - Lineage-aware functions, agents, and optional native store
 * @returns A `ToolInterface` (named {@link import('./constants.js').WORKFLOW_TOOL_NAME}) whose
 *   `parameters` advertise the flat authoring schema
 *
 * @example Authoring and running a workflow through the tool with a real ToolManager
 * ```ts
 * import { createWorkflowTool } from '@orkestrel/toolbox'
 * import { createToolManager } from '@orkestrel/tool'
 * import { createWorkflowRunner } from '@orkestrel/workflow'
 * import type { WorkflowDefinition } from '@orkestrel/workflow'
 *
 * const definition: WorkflowDefinition = { id: 'release', name: 'Release', phases: [] }
 * const runner = createWorkflowRunner()
 * const functions = {
 * 	compile: () => 'compiled',
 * 	publish: () => 'published',
 * }
 * const tool = createWorkflowTool(definition, runner, { functions })
 *
 * const tools = createToolManager()
 * tools.add(tool)
 *
 * // A small model authors the simple flat shape — no ids/names required.
 * const result = await tools.execute({
 * 	id: 'call-1',
 * 	name: 'workflow',
 * 	arguments: { name: 'release', steps: [{ name: 'compile' }, { name: 'publish' }] },
 * })
 * if (!result.success) throw new Error(result.error)
 * result.value // { status: 'completed', count: 2 } — the single-level envelope; no nested { id, name, value }
 * ```
 *
 * @example
 * ```ts
 * import { createWorkflowTool } from '@src/core'
 * import { createWorkflowRunner, createMemoryWorkflowStore } from '@orkestrel/workflow'
 * import { createToolManager } from '@orkestrel/tool'
 *
 * const runner = createWorkflowRunner()
 * const store = createMemoryWorkflowStore()
 * const tool = createWorkflowTool(definition, runner, { store })
 * const tools = createToolManager()
 * tools.add(tool) // authored runs now use native checkpoints through `store`
 * ```
 */
export function createWorkflowTool(
	definition: WorkflowDefinition,
	runner: WorkflowRunnerInterface,
	options?: WorkflowToolOptions,
): ToolInterface {
	const strict = createWorkflowContract()
	const draft = createWorkflowDraftContract()
	const steps: ContractInterface<WorkflowSteps> = createContract(workflowStepsShape)
	const lineage = normalizeLineage(options?.lineage)
	if (lineage.length > 0 && !lineage.at(-1)?.startsWith('agent:')) {
		throw new ToolboxError('TOOL', 'workflow tool lineage must end with an agent tag')
	}
	const functions =
		options?.functions === undefined ? undefined : Object.freeze({ ...options.functions })
	const agents = options?.agents === undefined ? undefined : Object.freeze({ ...options.agents })
	const store = options?.store
	const parameters = schemaToParameters(steps.schema)
	return createTool({
		name: WORKFLOW_TOOL_NAME,
		description: WORKFLOW_TOOL_DESCRIPTION,
		summary: WORKFLOW_TOOL_SUMMARY,
		...(parameters === undefined ? {} : { parameters }),
		strict: false,
		async execute(args) {
			const cloned = attempt(() => cloneJSONRecord(args))
			if (!cloned.success) {
				throw new ToolError(
					'ARGUMENTS',
					`Arguments could not be read; send one JSON object such as ${JSON.stringify(WORKFLOW_TOOL_FLAT_EXAMPLE)}`,
					undefined,
					{ cause: cloned.error },
				)
			}
			// Branch on the owned args snapshot's shape (no ambient context — a tool handler gets only
			// `args`), and refuse with the chosen form's own faults.
			const target = resolveWorkflowTarget(cloned.value, definition, steps, draft)
			// The soundness gate: whatever authoring form produced `target`, it must satisfy the
			// strict canonical contract before it runs — the leniency never reaches the runner.
			if (!strict.is(target)) {
				const faults = strict.audit(target)
				throw new ToolboxError(
					'TOOL',
					limitRefusal(
						`workflow ${preview(definition.id)} cannot run; send steps to author another one, or correct it:\n${describeFaults(faults, strict.schema)}`,
					),
					{ workflow: definition.id, faults },
				)
			}
			const tag = tagWorkflow(target.id)
			if (lineage.includes(tag)) {
				throw new ToolboxError(
					'DEPTH',
					`workflow ${preview(target.id)} is already an ancestor (cycle); send steps with a new name, or phases with a new id`,
					{ workflow: target.id, lineage: [...lineage] },
				)
			}
			const targetLineage = extendLineage(lineage, tag)
			const depth = deriveWorkflowDepth(targetLineage)
			if (depth > MAX_WORKFLOW_CHAIN) {
				throw new ToolboxError(
					'DEPTH',
					`nested workflow exceeds max depth ${MAX_WORKFLOW_CHAIN}; finish this task without nesting another workflow`,
					{ workflow: target.id, depth, max: MAX_WORKFLOW_CHAIN },
				)
			}
			const registry =
				functions === undefined && agents === undefined
					? undefined
					: createWorkflowFunctions(runner, {
							lineage: targetLineage,
							...(functions === undefined ? {} : { functions }),
							...(agents === undefined ? {} : { agents }),
							...(store === undefined ? {} : { store }),
						})
			const result = await runner.execute(target, {
				...(registry === undefined ? {} : { functions: registry }),
				...(store === undefined ? {} : { store }),
			})
			return summarizeWorkflow(result)
		},
	})
}

/**
 * Builds an LLM-callable workspace-editing tool — it advertises the `operation`-discriminated union
 * ({@link import('./shapers.js').workspaceToolShape}) as its `parameters`, and its handler parses
 * the model-supplied args against that contract and dispatches the matched operation against the
 * manager's active workspace, returning the plain result.
 *
 * @remarks
 * Manager-driven: every op (read / list / has / search / replace / write / splice / prepend /
 * append / move / remove) targets `manager.active`, so the model edits whichever workspace is
 * active. The host re-points `active` through `WorkspaceManagerInterface.switch` between runs, and
 * the tool holds no operation that lists or selects a workspace.
 *
 * No-active rule (the ergonomic seam): an op that can create the file it names (write / prepend /
 * append) run when `manager.active` is `undefined` auto-creates and activates a default workspace
 * (`manager.add()`) so the model can start writing; an op that edits a file that must already exist
 * (splice / move / remove / replace) refuses with a `TOOL` `ToolboxError` and creates none; a
 * pure-read op (read / list / has / search) against no active workspace returns the empty result
 * (`null` / `[]` / `false`), never creating one and never throwing.
 *
 * The Tool door enforces the operation union through `contract`, repairing lossless scalar leaves
 * and refusing malformed args with a `ToolError` carrying code `ARGUMENTS`. A selected operation
 * reports its own faults; an unknown operation reports a bounded summary of alternatives.
 * The handler then `switch`es on `op.operation` and returns the plain result
 * — letting a `WorkspaceError` raised by the live workspace (`MISSING` / `MODALITY` / `PATTERN` /
 * `RANGE`) propagate uncaught. `read` returns `null` for a path that holds no text, because JSON
 * tells that from an empty file. The range edit is the flat `'splice'` op: its flat caret integers are
 * reassembled into a `Range` (`@orkestrel/workspace`) by `rangeOf` and fed to the workspace's
 * ranged `write`.
 *
 * @param options - `manager` (drive directly) or `store` (build a manager over it); neither ⇒
 *   an in-memory-backed manager (see {@link import('./types.js').WorkspaceToolOptions})
 * @returns A `ToolInterface` (named {@link import('./constants.js').WORKSPACE_TOOL_NAME} by default)
 *
 * @example
 * ```ts
 * import { createWorkspaceTool } from '@src/core'
 * import { createToolManager } from '@orkestrel/tool'
 *
 * const tool = createWorkspaceTool() // in-memory workspace, no persistence
 * const tools = createToolManager()
 * tools.add(tool)
 * ```
 */
export function createWorkspaceTool(options?: WorkspaceToolOptions): ToolInterface {
	const manager: WorkspaceManagerInterface =
		options?.manager ??
		createWorkspaceManager(options?.store === undefined ? undefined : { store: options.store })
	const contract: ContractInterface<WorkspaceOperation> = createContract(workspaceToolShape)
	return createTool({
		name: options?.name ?? WORKSPACE_TOOL_NAME,
		description: options?.description ?? WORKSPACE_TOOL_DESCRIPTION,
		summary: WORKSPACE_TOOL_SUMMARY,
		contract: workspaceToolShape,
		execute(args) {
			const op = requireToolCall(contract, args)
			// Every op targets the active workspace. An op that can create its file auto-creates
			// and activates a default workspace when none is active (the no-active ergonomic seam), an op
			// on a file that must exist refuses, and a pure-read op returns the empty result.
			const active = manager.active
			switch (op.operation) {
				case 'read':
					return active?.read(op.path) ?? null
				case 'list':
					return (active?.files() ?? []).map((file) => ({
						path: file.path,
						state: file.state,
						size: file.size,
						lines: file.lines,
						kind: isTextContent(file.content) ? 'text' : 'binary',
					}))
				case 'has':
					return active?.has(op.path) ?? false
				case 'search':
					return (
						active?.search(op.query, {
							...(op.regex === undefined ? {} : { regex: op.regex }),
							...(op.sensitive === undefined ? {} : { sensitive: op.sensitive }),
							...(op.limit === undefined ? {} : { limit: op.limit }),
						}) ?? []
					)
				case 'replace': {
					const workspace = requireActiveWorkspace(manager, op.operation)
					return workspace.replace(op.query, op.replacement, {
						...(op.regex === undefined ? {} : { regex: op.regex }),
						...(op.sensitive === undefined ? {} : { sensitive: op.sensitive }),
						...(op.limit === undefined ? {} : { limit: op.limit }),
					})
				}
				case 'write': {
					const workspace = active ?? manager.add()
					workspace.write(op.path, op.content)
					return { path: op.path, state: workspace.file(op.path)?.state }
				}
				case 'splice': {
					const workspace = requireActiveWorkspace(manager, op.operation)
					workspace.write(
						op.path,
						op.content,
						rangeOf(op.fromLine, op.fromColumn, op.toLine, op.toColumn),
					)
					return { path: op.path, state: workspace.file(op.path)?.state }
				}
				case 'prepend': {
					const workspace = active ?? manager.add()
					workspace.prepend(op.path, op.content)
					return { path: op.path, state: workspace.file(op.path)?.state }
				}
				case 'append': {
					const workspace = active ?? manager.add()
					workspace.append(op.path, op.content)
					return { path: op.path, state: workspace.file(op.path)?.state }
				}
				case 'move': {
					const workspace = requireActiveWorkspace(manager, op.operation)
					return { from: op.from, to: op.to, moved: workspace.move(op.from, op.to) }
				}
				case 'remove': {
					const workspace = requireActiveWorkspace(manager, op.operation)
					return { path: op.path, removed: workspace.remove(op.path) }
				}
			}
		},
	})
}

/**
 * Builds an LLM-callable sub-agent delegation tool — it resolves a live, seeded `AgentInterface`
 * from `registry` and runs it to completion for one delegated `task`.
 *
 * @remarks
 * The universal tool-handler contract: the Tool door holds the call args to
 * {@link import('./shapers.js').agentToolShape}, refusing a malformed call — one carrying
 * `provider`, `tools`, `system`, or any member besides `task` included — with a `ToolError`
 * carrying code `ARGUMENTS`. The handler assembles an `AgentJobInput` (`task` seeds the
 * sub-agent's conversation as a single `user` message; `provider`, `tools`, `system`, and
 * `authority` are the host's, fixed in {@link import('./types.js').AgentToolOptions}), rehydrates the
 * sub-agent through `registry.build`, runs it with `agent.generate()`, and returns the settled
 * `AgentResult.content` string (the sub-agent's final text). A delegation that would exceed
 * {@link import('./constants.js').AGENT_TOOL_DEPTH}, or re-enter an already-delegated agent (a
 * cycle), throws a typed `DEPTH` {@link import('./errors.js').ToolboxError}, isolated by the
 * `ToolManagerInterface` into the canonical tool result's top-level `error`. A `depth` that is not
 * a nonnegative safe integer, or a non-empty `tools` list with no `authority`, throws `TOOL` at
 * construction.
 *
 * `AgentInterface` (`@orkestrel/agent`) exposes no teardown method — a bound sub-agent's
 * lifetime is the single `generate()` call this handler awaits; there is nothing to release
 * afterwards (unlike a store-backed resource, its state lives entirely in the resolved
 * `AgentContextInterface`, owned by the caller's registry).
 *
 * @param registry - The `AgentRegistryInterface` a delegated job resolves against (providers,
 *   tools, authorities, schedulers, and the `build` rehydration seam)
 * @param options - The fixed sub-agent, depth/ancestry bookkeeping, and advertised overrides
 *   (see {@link import('./types.js').AgentToolOptions})
 * @returns A `ToolInterface` (named {@link import('./constants.js').AGENT_TOOL_NAME} by default)
 *
 * @example
 * ```ts
 * import { createAgentTool } from '@src/core'
 * import { createAgentRegistry } from '@orkestrel/agent'
 * import { createToolManager } from '@orkestrel/tool'
 *
 * const registry = createAgentRegistry({ providers: { openai: myProvider } })
 * const tool = createAgentTool(registry, { provider: 'openai' })
 * const tools = createToolManager()
 * tools.add(tool) // a model can now delegate a task to a sub-agent
 * ```
 */
export function createAgentTool(
	registry: AgentRegistryInterface,
	options: AgentToolOptions,
): ToolInterface {
	const contract: ContractInterface<AgentToolArguments> = createContract(agentToolShape)
	const depth = options.depth ?? 0
	if (!isNonNegativeInteger(depth) || !Number.isSafeInteger(depth)) {
		throw new ToolboxError(
			'TOOL',
			`agent tool depth must be a nonnegative safe integer; received ${preview(depth)}; omit it for a direct root`,
			{ received: preview(depth) },
		)
	}
	const tools = options.tools
	if (tools !== undefined && tools.length > 0 && options.authority === undefined) {
		throw new ToolboxError(
			'TOOL',
			'agent tool names tools and no authority to decide their calls; set authority, or set tools: [] to delegate with none',
			{ tools: [...tools] },
		)
	}
	const ancestry = options.ancestry ?? []
	const provider = options.provider
	return createTool({
		name: options.name ?? AGENT_TOOL_NAME,
		description: options.description ?? AGENT_TOOL_DESCRIPTION,
		summary: AGENT_TOOL_SUMMARY,
		contract: agentToolShape,
		async execute(args) {
			const call = requireToolCall(contract, args)
			if (depth + 1 > AGENT_TOOL_DEPTH) {
				throw new ToolboxError(
					'DEPTH',
					`delegation exceeds max agent depth ${AGENT_TOOL_DEPTH}; carry out this task without delegating`,
					{ provider, depth, max: AGENT_TOOL_DEPTH },
				)
			}
			const tag = tagAgent(provider)
			if (ancestry.includes(tag)) {
				throw new ToolboxError(
					'DEPTH',
					`agent ${preview(provider)} is already an ancestor (cycle); carry out this task without delegating`,
					{ provider, ancestry: [...ancestry] },
				)
			}
			const agent = registry.build({
				provider,
				messages: [{ role: 'user', content: call.task }],
				...(options.system === undefined ? {} : { system: options.system }),
				...(tools === undefined ? {} : { tools }),
				...(options.authority === undefined ? {} : { authority: options.authority }),
			})
			const result = await agent.generate()
			if (options.store !== undefined) {
				const active = agent.context.conversations.active
				if (active !== undefined) await options.store.set(active.snapshot())
			}
			return result.content
		},
	})
}

/**
 * Builds an LLM-callable tool that returns the full `description` of another registered tool by
 * name — the counterpart to the lean `summary` the other tools in this package advertise.
 *
 * @remarks
 * `ToolManagerInterface.definitions()` (`@orkestrel/tool`) advertises `tool.summary ??
 * tool.description` — a lean one-sentence summary stands in for a tool's full teaching
 * description when `summary` is set, keeping the advertised tool list compact for a small model.
 * This tool is the on-demand expansion seam: given a registered tool's `name`, it looks the tool
 * up through `tools.tool(name)` and returns its full `description` (falling back to `summary` when a
 * tool has no `description` of its own, then an explicit `null` when it has neither).
 *
 * The universal tool-handler contract: the Tool door holds the call args to
 * {@link import('./shapers.js').describeToolShape}, refusing a malformed call with a `ToolError`
 * carrying code `ARGUMENTS`. The handler returns the plain description on success, and throws a typed
 * `TOOL` {@link import('./errors.js').ToolboxError} that lists the registered names on an unknown
 * tool name.
 *
 * @param tools - The `ToolManagerInterface` (`@orkestrel/tool`) whose registered tools this
 *   tool can describe
 * @returns A `ToolInterface` (named {@link import('./constants.js').DESCRIBE_TOOL_NAME})
 *
 * @example
 * ```ts
 * import { createDescribeTool, createWorkflowTool } from '@src/core'
 * import { createToolManager } from '@orkestrel/tool'
 *
 * const tools = createToolManager()
 * tools.add(createWorkflowTool(definition, runner))
 * tools.add(createDescribeTool(tools))
 * const full = await tools.execute({ id: '1', name: 'describe', arguments: { name: 'workflow' } })
 * full.value // the workflow tool's full teaching description
 * ```
 */
export function createDescribeTool(tools: ToolManagerInterface): ToolInterface {
	const contract = createContract(describeToolShape)
	return createTool({
		name: DESCRIBE_TOOL_NAME,
		description: DESCRIBE_TOOL_DESCRIPTION,
		summary: DESCRIBE_TOOL_SUMMARY,
		contract: describeToolShape,
		async execute(args) {
			const call = requireToolCall(contract, args)
			const tool = tools.tool(call.name)
			if (tool === undefined) {
				const names = tools.tools().map((registered) => registered.name)
				throw new ToolboxError(
					'TOOL',
					`unknown tool ${preview(call.name)}; send name as one of ${renderCandidates(names)}`,
					{ name: call.name, names },
				)
			}
			return tool.description ?? tool.summary ?? null
		},
	})
}

/**
 * Builds an LLM-callable form tool — the ask side of the terminal seam. It asks a multi-field form
 * and blocks until the addressed terminal answers, returning the resolved values record.
 *
 * @remarks
 * The universal tool-handler contract: the Tool door holds the call args to
 * {@link import('./shapers.js').promptToolShape}, refusing a malformed call with a `ToolError`
 * carrying code `ARGUMENTS`. The handler parses the call's schema through
 * `@orkestrel/form`, constructs the live form, and passes it to `TerminalManagerInterface.ask`.
 * `from` is fixed at construction
 * ({@link import('./types.js').PromptToolOptions.from}) — never read from the model-supplied
 * args — so a model cannot spoof which terminal is asking. A form cycle rejects with
 * `TerminalError('DEADLOCK')`, re-surfaced as a typed `DEADLOCK`
 * {@link import('./errors.js').ToolboxError}; an expired form re-surfaces as `EXPIRE`; an
 * unknown `to` (or any other `TerminalError`) re-surfaces as `TOOL`, naming the unknown terminal
 * and the mounted terminals the manager's refusal lists, encoded and bounded. A schema `parseForm` refuses — an
 * unknown control, a duplicate field name, a `'select'` or `'checkbox'` field without usable
 * `choices` — throws a typed `TOOL` error up front, so a malformed schema never parks as a form
 * nobody can answer.
 *
 * @param options - The live manager, the fixed `from` identity, and advertised overrides (see
 *   {@link import('./types.js').PromptToolOptions})
 * @returns A `ToolInterface` (named {@link import('./constants.js').PROMPT_TOOL_NAME} by default)
 *
 * @example
 * ```ts
 * import { createPromptTool } from '@src/core'
 * import { createToolManager } from '@orkestrel/tool'
 * import { createTerminalManager } from '@orkestrel/terminal'
 *
 * const manager = createTerminalManager()
 * manager.add('agent')
 * manager.add('reviewer')
 * const tool = createPromptTool({ manager, from: 'agent' })
 * const tools = createToolManager()
 * tools.add(tool) // the agent can now ask 'reviewer' and block for the answer
 * ```
 */
export function createPromptTool(options: PromptToolOptions): ToolInterface {
	const contract = createContract(promptToolShape)
	return createTool({
		name: options.name ?? PROMPT_TOOL_NAME,
		description: options.description ?? PROMPT_TOOL_DESCRIPTION,
		summary: PROMPT_TOOL_SUMMARY,
		contract: promptToolShape,
		async execute(args) {
			const call = requireToolCall(contract, args)
			const schema = parseForm(call.schema)
			if (schema === undefined) {
				throw new ToolboxError(
					'TOOL',
					`malformed form schema; send { "fields": [{ "control", "name" }] } with unique names, where control is one of ${FIELD_CONTROLS.join(', ')}, and select or checkbox carries choices of { "label", "value" }`,
					{ schema: call.schema },
				)
			}
			for (const field of schema.fields) {
				if (
					(field.control === 'select' || field.control === 'checkbox') &&
					!field.choices.some((choice) => choice.disabled !== true)
				) {
					throw new ToolboxError(
						'TOOL',
						`${field.control} field ${preview(field.name)} has no enabled choices; add a choice that is not disabled`,
						{ control: field.control, field: field.name },
					)
				}
			}
			try {
				return await options.manager.ask(options.from, call.to, createForm(schema))
			} catch (error) {
				if (isFormError(error) && error.code === 'ABANDONED') {
					throw new ToolboxError(
						'EXPIRE',
						`form to ${preview(call.to)} expired before it was answered; ask again to give it more time`,
						{ to: call.to },
					)
				}
				const code = inferTerminalCode(error)
				if (code === undefined) throw error
				if (code === 'DEADLOCK') {
					throw new ToolboxError(
						'DEADLOCK',
						`asking ${preview(call.to)} would create a form cycle; answer the form addressed to you first`,
						isTerminalError(error) ? error.context : { from: options.from, to: call.to },
					)
				}
				if (code === 'EXPIRE') {
					throw new ToolboxError(
						'EXPIRE',
						`form to ${preview(call.to)} expired before it was answered; ask again to give it more time`,
						{ to: call.to },
					)
				}
				if (isTerminalError(error) && error.code === 'TARGET') {
					// The manager publishes no list of names, so its refusal's context is where they read.
					const listed = error.context?.known
					const known = arrayOf(isString)(listed) ? listed : []
					throw new ToolboxError(
						'TOOL',
						`unknown terminal ${preview(call.to)}; ${known.length === 0 ? 'no mounted terminal name is available' : `send to as one of ${renderCandidates(known)}`}`,
						{ to: call.to, known, count: options.manager.count },
					)
				}
				throw new ToolboxError('TOOL', `asking ${preview(call.to)} failed; ask again`, {
					to: call.to,
				})
			}
		},
	})
}

/**
 * Builds an LLM-callable answer tool — the answer side of the terminal seam. It lists the forms
 * addressed to {@link import('./types.js').AnswerToolOptions.to}, or answers one of them by id.
 *
 * @remarks
 * The universal tool-handler contract: the Tool door holds the call args to
 * {@link import('./shapers.js').answerToolShape} (discriminated by `operation`), refusing malformed
 * args with a `ToolError` carrying code `ARGUMENTS`. `'pending'`
 * returns a compact list (`{ id, from, schema }`) of every form addressed to `to`.
 * `'answer'` looks the form up by `id`, narrows the supplied `values` through `@orkestrel/form`,
 * and applies it through
 * `TerminalManagerInterface.answer` — a rejected / unknown / unresolvable outcome
 * (`TerminalAnswerResult.error`) re-surfaces as a typed `ANSWER` `ToolboxError`; success returns
 * `{ answered: id }`. `to` is fixed at construction
 * ({@link import('./types.js').AnswerToolOptions.to}) — never read from the model-supplied args —
 * so a model cannot spoof which terminal it is answering for. Concurrent answerers racing on one
 * endpoint are first-write-wins — a late answer to an already-settled form returns a typed
 * `ANSWER` `ToolboxError` (surfaced as a 422 over HTTP).
 *
 * @param options - The live manager, the fixed `to` identity, and advertised overrides (see
 *   {@link import('./types.js').AnswerToolOptions})
 * @returns A `ToolInterface` (named {@link import('./constants.js').ANSWER_TOOL_NAME} by default)
 *
 * @example
 * ```ts
 * import { createAnswerTool } from '@src/core'
 * import { createToolManager } from '@orkestrel/tool'
 * import { createTerminalManager } from '@orkestrel/terminal'
 *
 * const manager = createTerminalManager()
 * manager.add('reviewer')
 * const tool = createAnswerTool({ manager, to: 'reviewer' })
 * const tools = createToolManager()
 * tools.add(tool) // the reviewer terminal can now list/answer forms addressed to it
 * ```
 */
export function createAnswerTool(options: AnswerToolOptions): ToolInterface {
	const contract = createContract(answerToolShape)
	return createTool({
		name: options.name ?? ANSWER_TOOL_NAME,
		description: options.description ?? ANSWER_TOOL_DESCRIPTION,
		summary: ANSWER_TOOL_SUMMARY,
		contract: answerToolShape,
		async execute(args) {
			const call = requireToolCall(contract, args)
			if (call.operation === 'pending') {
				return options.manager.pending(options.to).map((form) => ({
					id: form.id,
					from: form.from,
					schema: form.schema,
				}))
			}
			const form = options.manager.pending(options.to).find((entry) => entry.id === call.id)
			if (form === undefined) {
				throw new ToolboxError(
					'ANSWER',
					`unknown form ${preview(call.id)}; call { "operation": "pending" } for the ids you can answer`,
					{ id: call.id, reason: 'unknown' },
				)
			}
			if (!isFormValues(call.values)) {
				throw new ToolboxError(
					'TOOL',
					'malformed form values; send values as a record of each field name to a string, a finite number, a boolean, or a list of strings',
					{ values: call.values },
				)
			}
			const result = options.manager.answer(options.to, call.id, call.values)
			if (!result.success) {
				const detail =
					result.error.reason === 'rejected'
						? `; correct these fields and answer again: ${renderList(result.error.errors.map((fault) => `${preview(fault.field)}: ${preview(fault.message)}`))}`
						: '; call { "operation": "pending" } for the ids you can answer'
				throw new ToolboxError(
					'ANSWER',
					`failed to answer form ${preview(call.id)}: ${result.error.reason}${detail}`,
					{
						id: call.id,
						reason: result.error.reason,
						...(result.error.reason === 'rejected' ? { errors: result.error.errors } : {}),
					},
				)
			}
			return { answered: call.id }
		},
	})
}

// === Database definition stores

/**
 * Creates the in-memory {@link DefinitionStoreInterface} — a process-lifetime `Map` of database
 * definitions, the default store the database and relation tools persist their `DatabaseDefinition`
 * configs through.
 *
 * @returns A {@link DefinitionStoreInterface}
 *
 * @example
 * ```ts
 * import { createMemoryDefinitionStore } from '@src/core'
 *
 * const store = createMemoryDefinitionStore()
 * ```
 */
export function createMemoryDefinitionStore(): DefinitionStoreInterface {
	return new MemoryDefinitionStore()
}

/**
 * Creates a {@link DefinitionStoreInterface} backed by one table of the `@orkestrel/database`
 * layer — the driver-pluggable twin of {@link createMemoryDefinitionStore}, storing each
 * database's definition as one opaque JSON column.
 *
 * @param driver - The {@link DriverInterface} backing the table (default an in-memory driver)
 * @returns A {@link DefinitionStoreInterface}
 *
 * @example
 * ```ts
 * import { createDatabaseDefinitionStore } from '@src/core'
 *
 * const store = createDatabaseDefinitionStore() // in-memory by default
 * ```
 */
export function createDatabaseDefinitionStore(
	driver: DriverInterface = createMemoryDriver(),
): DefinitionStoreInterface {
	// The definition is stored as one opaque JSON column (`rawShape`), so the row infers flat —
	// `{ id: string; definition: unknown }` = DatabaseDefinitionRow.
	const columns = { id: stringShape(), definition: rawShape({}) }
	const database = createDatabase({ driver, tables: { definitions: columns } })
	const table: TableInterface<DatabaseDefinitionRow> = database.table('definitions')
	return new DatabaseDefinitionStore(table)
}

// === Database tool

/**
 * Builds an LLM-callable database tool — it creates, queries, and mutates `@orkestrel/database`
 * databases through one `operation`-discriminated call (matching
 * {@link createWorkspaceTool}'s single-tool-many-operations shape).
 *
 * @remarks
 * The universal tool-handler contract: the Tool door holds the call args to
 * {@link import('./shapers.js').databaseToolShape}, refusing malformed args with a `ToolError`
 * carrying code `ARGUMENTS`. The handler dispatches to the matching operation and
 * returns a plain result on success. A row a `'get'` misses is an explicit `null`. A `limit` that is
 * not a positive safe integer throws `TOOL` at construction. A database is resolved lazily and cached for the tool's
 * lifetime — `'create'` mints one from `tables` ({@link import('./compilers.js').expandTables}) and
 * a registered `driver` key ({@link import('./types.js').DatabaseToolOptions.drivers}, default
 * `{ memory: () => createMemoryDriver() }`); any other operation addressing an uncached id falls
 * back to {@link import('./types.js').DatabaseToolOptions.store} (an unknown id throws a typed
 * `TOOL` {@link import('./errors.js').ToolboxError}). When a `store` is configured, `'create'`
 * persists the new {@link import('./types.js').DatabaseDefinition} and `'destroy'` deletes it.
 *
 * `'records'` clamps its `query` to
 * {@link import('./types.js').DatabaseToolOptions.limit} (default
 * {@link import('./constants.js').DATABASE_TOOL_LIMIT}) through
 * {@link import('./helpers.js').clampQuery}, reporting `truncated` when storage held more rows
 * than the cap. Every operation's `query` is normalized through
 * {@link import('./helpers.js').normalizeQuery} (defaults an omitted condition `connector` to `'and'`).
 * When {@link import('./types.js').DatabaseToolOptions.readonly} is `true`, every mutating
 * operation throws a typed `TOOL` `ToolboxError` before doing anything. A configured
 * {@link import('./types.js').DatabaseToolOptions.timeout} is passed as a fresh
 * `AbortSignal.timeout(timeout)` only to table operations whose current database API accepts
 * operation options (`records`, `count`, `aggregate`, `add`, `set`, `update`, and `remove`). It is
 * not an outer deadline for resolution, construction, schema inspection, `get`, or `close`. A typed `@orkestrel/database`
 * failure (`DatabaseError`) re-surfaces as a typed `DATABASE` `ToolboxError` carrying the
 * original {@link import('@orkestrel/database').DatabaseErrorCode} in `context.code`
 * ({@link import('./helpers.js').inferDatabaseCode}); an `ToolboxError` thrown by this tool's own
 * guards passes through unwrapped.
 *
 * A lazily re-minted database over the default in-memory driver yields an empty database — only
 * the {@link import('./types.js').DatabaseDefinition} schema persists in `store`, never rows;
 * durable rows need a persistent driver factory registered in
 * {@link import('./types.js').DatabaseToolOptions.drivers}. `'destroy'` closes whatever handle is
 * cached for the id, including an embedder-supplied
 * {@link import('./types.js').DatabaseToolOptions.databases} handle — the embedder relinquishes
 * that handle's lifecycle to this tool for any id it wires in. This tool assumes the
 * single-writer, non-reentrant model `@orkestrel/database` itself assumes — concurrent calls
 * against one id are not serialized by this tool. `'get'` is uncapped by
 * {@link import('./types.js').DatabaseToolOptions.limit} (bounded only by the caller's `key` array
 * size), unlike `'records'` / `'find'` / `'links'`.
 *
 * @param options - The tool's configuration (see {@link import('./types.js').DatabaseToolOptions})
 * @returns A `ToolInterface` (named {@link import('./constants.js').DATABASE_TOOL_NAME} by default)
 *
 * @example
 * ```ts
 * import { createDatabaseTool } from '@src/core'
 *
 * const tool = createDatabaseTool()
 * await tool.execute(
 * 	{
 * 		operation: 'create',
 * 		id: 'shop',
 * 		tables: { products: { columns: { name: 'string', price: 'number' } } },
 * 	},
 * 	{ signal: new AbortController().signal },
 * )
 * ```
 */
export function createDatabaseTool(options: DatabaseToolOptions = {}): ToolInterface {
	if (
		options.timeout !== undefined &&
		(options.timeout < 0 || !isNumber(options.timeout) || !Number.isSafeInteger(options.timeout))
	) {
		throw new ToolboxError('TOOL', 'database timeout must be a nonnegative safe integer', {
			timeout: options.timeout,
		})
	}
	const contract = createContract(databaseToolShape)
	const handles = new Map<string, DatabaseInterface>(Object.entries(options.databases ?? {}))
	const drivers = options.drivers ?? { memory: createMemoryDriver }
	const generator = options.generator
	const cap = resolveBound(options.limit, DATABASE_TOOL_LIMIT, 'database limit')
	const store = options.store
	const resolver =
		store === undefined
			? new DatabaseResolver(handles, drivers, generator)
			: new DatabaseResolver(handles, drivers, generator, store)

	return createTool({
		name: options.name ?? DATABASE_TOOL_NAME,
		description: options.description ?? DATABASE_TOOL_DESCRIPTION,
		summary: DATABASE_TOOL_SUMMARY,
		contract: databaseToolShape,
		async execute(args) {
			const call = requireToolCall(contract, args)
			if (options.readonly === true && DATABASE_TOOL_MUTATIONS.includes(call.operation)) {
				throw new ToolboxError(
					'TOOL',
					`operation '${call.operation}' is disabled in readonly mode; call tables, get, records, count, or aggregate`,
					{ operation: call.operation },
				)
			}
			const read: Readonly<{ signal?: AbortSignal }> | undefined =
				options.timeout === undefined ? undefined : { signal: AbortSignal.timeout(options.timeout) }
			try {
				switch (call.operation) {
					case 'create': {
						if (
							resolver.has(call.id) ||
							(store !== undefined && (await store.get(call.id)) !== undefined)
						) {
							throw new ToolboxError(
								'TOOL',
								`database ${preview(call.id)} already exists; use it, destroy it first, or send another id`,
								{ id: call.id },
							)
						}
						const name = call.driver ?? 'memory'
						const factory = drivers[name]
						if (factory === undefined) {
							throw new ToolboxError(
								'TOOL',
								`unknown driver ${preview(name)}; send driver as one of ${renderCandidates(Object.keys(drivers))}`,
								{ id: call.id, driver: name },
							)
						}
						const tables = call.tables
						const primary = call.primary
						const indexes = call.indexes
						const version = call.version
						const handle = createDatabase({
							driver: factory(),
							tables: expandTables(tables),
							name: call.id,
							...(primary === undefined ? {} : { primary }),
							...(indexes === undefined ? {} : { indexes }),
							...(version === undefined ? {} : { version }),
							...(generator === undefined ? {} : { generator }),
						})
						const definition: DatabaseDefinition = {
							id: call.id,
							driver: name,
							tables,
							...(primary === undefined ? {} : { primary }),
							...(indexes === undefined ? {} : { indexes }),
							...(version === undefined ? {} : { version }),
						}
						if (store !== undefined) await store.set(definition)
						resolver.set(call.id, handle)
						return { id: call.id, tables: Object.keys(tables) }
					}
					case 'tables': {
						const handle = await resolver.resolve(call.id)
						const tables = Object.keys(handle.export()).map((name) => {
							const table = handle.table(name)
							return { name, primary: table.primary, columns: table.contract.schema }
						})
						return { tables }
					}
					case 'get': {
						const handle = await resolver.resolve(call.id)
						const table = handle.table(call.table)
						const many = isArray(call.key)
						const keys = isArray(call.key) ? call.key : [call.key]
						const rows = (await table.get(keys)).map((row) => row ?? null)
						return many ? { rows } : { row: rows[0] }
					}
					case 'records': {
						const handle = await resolver.resolve(call.id)
						const table = handle.table(call.table)
						const { query: probe, limit } = clampQuery(normalizeQuery(call.query), cap)
						const rows = await table.records(probe, read)
						const truncated = rows.length > limit
						const sliced = rows.slice(0, limit)
						return { rows: sliced, count: sliced.length, truncated, limit }
					}
					case 'count': {
						const handle = await resolver.resolve(call.id)
						const table = handle.table(call.table)
						const count = await table.count(normalizeQuery(call.query), read)
						return { count }
					}
					case 'aggregate': {
						const handle = await resolver.resolve(call.id)
						const table = handle.table(call.table)
						const value = await table.aggregate(
							call.function,
							call.column,
							normalizeQuery(call.query),
							read,
						)
						return { value }
					}
					case 'add': {
						const handle = await resolver.resolve(call.id)
						const table = handle.table(call.table)
						const many = isArray(call.row)
						const rows = isArray(call.row) ? call.row : [call.row]
						const keys = await table.add(rows, read)
						return many ? { keys } : { key: keys[0] }
					}
					case 'set': {
						const handle = await resolver.resolve(call.id)
						const table = handle.table(call.table)
						const many = isArray(call.row)
						const rows = isArray(call.row) ? call.row : [call.row]
						const keys = await table.set(rows, read)
						return many ? { keys } : { key: keys[0] }
					}
					case 'update': {
						const handle = await resolver.resolve(call.id)
						const table = handle.table(call.table)
						const changes = call.changes
						const many = isArray(call.key)
						const keys = isArray(call.key) ? call.key : [call.key]
						const updated = await table.update(keys, changes, read)
						return many ? { updated } : { updated: updated[0] }
					}
					case 'remove': {
						const handle = await resolver.resolve(call.id)
						const table = handle.table(call.table)
						const many = isArray(call.key)
						const keys = isArray(call.key) ? call.key : [call.key]
						const removed = await table.remove(keys, read)
						return many ? { removed } : { removed: removed[0] }
					}
					case 'destroy': {
						const cached = resolver.get(call.id)
						const persisted =
							store !== undefined && cached === undefined
								? (await store.get(call.id)) !== undefined
								: false
						if (cached !== undefined) {
							await cached.close()
							resolver.delete(call.id)
						}
						if (store !== undefined) await store.delete(call.id)
						return { id: call.id, destroyed: cached !== undefined || persisted }
					}
				}
			} catch (error) {
				if (isToolboxError(error)) throw error
				const code = inferDatabaseCode(error)
				if (code === undefined) throw error
				throw new ToolboxError(
					'DATABASE',
					limitRefusal(isError(error) ? error.message : String(error)),
					{
						code,
						operation: call.operation,
						id: call.id,
						...('table' in call ? { table: call.table } : {}),
					},
				)
			}
		},
	})
}

// === Relation tool

/**
 * Builds an LLM-callable relation tool — it traverses and edits `@orkestrel/relation` relationships
 * through one `operation`-discriminated call (matching {@link createDatabaseTool}'s
 * single-tool-many-operations shape).
 *
 * @remarks
 * The universal tool-handler contract: the Tool door holds the call args to
 * {@link import('./shapers.js').relationToolShape}, refusing malformed args with a `ToolError`
 * carrying code `ARGUMENTS`. A `limit` or `depth` that is not a positive safe integer throws `TOOL` at
 * construction, and a row `'load'` misses is an explicit `null`. The handler resolves the addressed
 * {@link import('@orkestrel/relation').RelationManagerInterface} — an explicit `manager` field
 * must match a key of {@link import('./types.js').RelationToolOptions.managers}, an omitted one
 * resolves to the sole registered manager, either miss throwing a typed `TOOL`
 * {@link import('./errors.js').ToolboxError}
 * ({@link import('./helpers.js').resolveRelationManager}) — then resolves `model` against it
 * ({@link import('./helpers.js').resolveRelationModel}, same typed-`TOOL`-on-miss shape), and
 * dispatches to the matched operation, returning a plain result on success.
 *
 * `'load'` / `'find'` expand the call's flat dot-path `include` list into a live
 * `@orkestrel/relation` `Include` tree through {@link import('./helpers.js').expandInclude}, capped
 * at {@link import('./types.js').RelationToolOptions.depth} (default
 * {@link import('./constants.js').RELATION_TOOL_DEPTH}) — a path exceeding the cap, or carrying an
 * empty segment, throws a typed `TOOL` error. `'load'` dispatches on whether `key` is an array
 * (positional many-key form — an array key is read as many keys rather than one) or a single key.
 * `'find'` and `'links'` clamp their
 * result to {@link import('./types.js').RelationToolOptions.limit} (default
 * {@link import('./constants.js').RELATION_TOOL_LIMIT}), taken through
 * {@link import('./helpers.js').resolveLimit} — `'find'` probes one row past the effective limit to
 * report `truncated`; `'links'` (which has no upstream pagination) fetches the full linked-key
 * list and slices/truncates it the same way. `'link'` writes a `through` junction row.
 * `'unlink'` removes every matching junction row, one row at a time, through the manager's
 * bound storage. Outside a transaction, a failed removal leaves the pair linked; repeat the
 * call to complete removal. The tool opens no transaction. For all-or-nothing removal, build
 * the manager over a transaction's storage and use the tool within that scope.
 *
 * A typed `@orkestrel/relation` failure (`RelationError`) re-surfaces as a typed `RELATION`
 * `ToolboxError` carrying the original {@link import('@orkestrel/relation').RelationErrorCode}
 * in `context.code`; a typed `@orkestrel/database` failure underneath it (`DatabaseError`)
 * re-surfaces as a typed `DATABASE` `ToolboxError`, mirroring {@link createDatabaseTool}'s error
 * mapping; an `ToolboxError` thrown by this tool's own guards (malformed args, an unknown
 * manager/model) passes through unwrapped.
 *
 * @param options - The tool's configuration (see {@link import('./types.js').RelationToolOptions})
 * @returns A `ToolInterface` (named {@link import('./constants.js').RELATION_TOOL_NAME} by default)
 *
 * @example
 * ```ts
 * import { createRelationTool } from '@src/core'
 *
 * const tool = createRelationTool({ managers: { shop: manager } })
 * await tool.execute(
 * 	{ operation: 'load', model: 'accounts', key: 'acc1', include: ['contacts'] },
 * 	{ signal: new AbortController().signal },
 * )
 * ```
 */
export function createRelationTool(options: RelationToolOptions): ToolInterface {
	const contract = createContract(relationToolShape)
	const depth = resolveBound(options.depth, RELATION_TOOL_DEPTH, 'relation depth')
	const cap = resolveBound(options.limit, RELATION_TOOL_LIMIT, 'relation limit')
	return createTool({
		name: options.name ?? RELATION_TOOL_NAME,
		description: options.description ?? RELATION_TOOL_DESCRIPTION,
		summary: RELATION_TOOL_SUMMARY,
		contract: relationToolShape,
		async execute(args) {
			const call = requireToolCall(contract, args)
			try {
				const manager = resolveRelationManager(options.managers, call.manager)
				const model = resolveRelationModel(manager, call.model)
				switch (call.operation) {
					case 'load': {
						const include = expandInclude(call.include, depth)
						if (isString(call.key) || isNumber(call.key)) {
							const row = await model.load(call.key, include)
							return { row: row ?? null }
						}
						const rows = await model.load(call.key, include)
						return { rows: rows.map((row) => row ?? null) }
					}
					case 'find': {
						const include = expandInclude(call.include, depth)
						const effective = resolveLimit(call.limit, cap)
						const rows = await model.find(include, {
							limit: effective + 1,
							...(call.offset === undefined ? {} : { offset: call.offset }),
							...(call.sort === undefined ? {} : { sort: call.sort }),
							...(call.direction === undefined ? {} : { direction: call.direction }),
						})
						const truncated = rows.length > effective
						const sliced = rows.slice(0, effective)
						return { rows: sliced, count: sliced.length, truncated, limit: effective }
					}
					case 'link': {
						await model.link(call.key, call.relation, call.target)
						return { linked: true }
					}
					case 'unlink': {
						await model.unlink(call.key, call.relation, call.target)
						return { unlinked: true }
					}
					case 'links': {
						const effective = resolveLimit(undefined, cap)
						const keys = await model.links(call.key, call.relation)
						const truncated = keys.length > effective
						const sliced = keys.slice(0, effective)
						return { keys: sliced, count: sliced.length, truncated, limit: effective }
					}
				}
			} catch (error) {
				if (isToolboxError(error)) throw error
				const relation = inferRelationCode(error)
				if (relation !== undefined) {
					throw new ToolboxError(
						'RELATION',
						limitRefusal(isError(error) ? error.message : String(error)),
						{
							code: relation,
							operation: call.operation,
							model: call.model,
							...('relation' in call ? { relation: call.relation } : {}),
						},
					)
				}
				const database = inferDatabaseCode(error)
				if (database === undefined) throw error
				throw new ToolboxError(
					'DATABASE',
					limitRefusal(isError(error) ? error.message : String(error)),
					{
						code: database,
						operation: call.operation,
					},
				)
			}
		},
	})
}

/**
 * Builds a standalone LLM-callable tool that infers a JSON Schema from example values — the utility
 * half of the bridge from an existing API or database into an MCP tool (the other half,
 * {@link createEndpointTool}, wraps one concrete endpoint).
 *
 * @remarks
 * The universal tool-handler contract: the Tool door holds the call args to
 * {@link import('./shapers.js').inferToolShape} (`samples` non-empty, `format` / `enum` optional
 * booleans, `candidates` an optional array), refusing malformed args with a `ToolError` carrying code
 * `ARGUMENTS`. The handler infers a schema through `@orkestrel/contract`'s
 * `samplesToSchema`, wraps a non-object root as `{ value: <schema> }` through `schemaToObject` (mirrors
 * the tool-parameters convention every other `create*Tool` factory advertises), and returns the
 * resulting parameters record.
 *
 * When `candidates` is absent, the return is the bare parameters record — unchanged from before
 * this array existed. When `candidates` is present (any array, including empty), the handler
 * compiles a separate per-call contract from the raw inferred schema (through `@orkestrel/contract`'s
 * `schemaToShape`, not the `schemaToObject`-wrapped parameters — a bare-value sample checks a
 * bare-value candidate) and returns `{ parameters, checks }`, one check per candidate at the same
 * index. Every entry has a uniform shape — `{ index, valid, coercible }`, with `faults` added only
 * when `valid` is `false`: `valid` is the strict guard verdict (`checker.is(candidate)`), the
 * opposite of {@link createEndpointTool}'s enforcement, which coerces (`7` becomes `'7'` for a
 * string slot) — here a conformance report answers "does this value conform as-is": `7` against a
 * string slot is `valid: false`, full stop. `coercible` answers a separate question — "would the
 * normalizing parse accept this value", that is would {@link createEndpointTool}'s default enforcement
 * admit it (`checker.parse(candidate) !== undefined`) — computed for every candidate regardless of
 * `valid`; by the house parse/guard round-trip, a `valid: true` entry is
 * always also `coercible: true`. `faults` is `checker.audit(candidate)`, which reports against `is`'s
 * strictness: a strictly-invalid but coercible candidate (`7` against a string slot) yields
 * `{ valid: false, coercible: true, faults: [{ reason: 'type', ... }] }`, so every invalid candidate
 * names why, an undeclared key included. `checker.is` / `.parse` / `.audit` are all total over
 * JSON-safe input — a JSON-safe hostile candidate (a `__proto__`-carrying object, deeply nested data) reaches each of them
 * and yields a bounded, non-throwing per-candidate verdict; a non-JSON-safe candidate (for example a
 * throwing-getter `Proxy`) never reaches the checker at all — the Tool door refuses the whole call
 * with the same `ToolError` a malformed `samples`/`format`/`enum` throws,
 * with no per-candidate verdict produced.
 *
 * @param options - Advertised `name` / `description` overrides (see
 *   {@link import('./types.js').InferToolOptions})
 * @returns A `ToolInterface` (named {@link import('./constants.js').INFER_TOOL_NAME} by default)
 *
 * @example
 * ```ts
 * import { createInferTool } from '@src/core'
 * import { createToolManager } from '@orkestrel/tool'
 *
 * const tool = createInferTool()
 * const tools = createToolManager()
 * tools.add(tool)
 *
 * const result = await tools.execute({
 * 	id: 'call-1',
 * 	name: 'infer',
 * 	arguments: { samples: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Bob' }] },
 * })
 * // result.value -> { type: 'object', properties: { id: {...}, name: {...} }, ... }
 *
 * // with candidates, the result is wrapped with per-candidate verdicts
 * const checked = await tools.execute({
 * 	id: 'call-2',
 * 	name: 'infer',
 * 	arguments: {
 * 		samples: [{ id: 1, name: 'Ada' }],
 * 		candidates: [{ id: 2, name: 'Bob' }, { id: 'x', name: 'Cy' }],
 * 	},
 * })
 * // checked.value -> { parameters: {...}, checks: [
 * //   { index: 0, valid: true, coercible: true },
 * //   { index: 1, valid: false, coercible: false, faults: [...] },
 * // ] }
 * ```
 */
export function createInferTool(options?: InferToolOptions): ToolInterface {
	const contract = createContract(inferToolShape)
	return createTool({
		name: options?.name ?? INFER_TOOL_NAME,
		description: options?.description ?? INFER_TOOL_DESCRIPTION,
		summary: INFER_TOOL_SUMMARY,
		contract: inferToolShape,
		async execute(args) {
			const parsed = requireToolCall(contract, args)
			const schema = samplesToSchema(parsed.samples, {
				format: parsed.format ?? false,
				enum: parsed.enum ?? false,
			})
			const result = schemaToParameters(schemaToObject(schema))
			if (result === undefined) {
				throw new ToolboxError(
					'TOOL',
					'could not infer a schema; send samples that are JSON values of one shape',
					{ args },
				)
			}
			if (parsed.candidates === undefined) {
				return result
			}
			const checker = createContract(schemaToShape(schema))
			const checks = parsed.candidates.map((candidate, index) => {
				const valid = checker.is(candidate)
				const coercible = checker.parse(candidate) !== undefined
				return valid
					? { index, valid, coercible }
					: { index, valid, coercible, faults: checker.audit(candidate) }
			})
			return { parameters: result, checks }
		},
	})
}

/**
 * Wraps one concrete endpoint ({@link import('./types.js').EndpointDefinition}) as an LLM-callable
 * `ToolInterface` — the endpoint half of the bridge from an existing API or database into an MCP
 * tool (the other half, {@link createInferTool}, is a standalone inference utility).
 *
 * @remarks
 * `parameters` is inferred once at construction from `definition.samples` through
 * `@orkestrel/contract`'s `samplesToSchema` (tuned by {@link import('./types.js').EndpointToolOptions}'s
 * `format` / `enum`), wrapping a non-object root as `{ value: <schema> }` through `schemaToObject` —
 * the same object-rooted schema is both the advertised `parameters` and, by default
 * ({@link import('./types.js').EndpointToolOptions.strict} `true`), the enforced contract: the Tool
 * door converts it through `@orkestrel/contract`'s lenient `schemaToShape` and compiles it on the
 * first call, then runs on every call's `args` before `definition.execute` — a
 * normalizing parse, not a strict type check: a scalar is coerced to its inferred type where the
 * house parsers coerce (a number to/from a numeric string, a boolean from `'1'`/`'0'`/`'true'`/
 * `'false'`/`1`/`0`), so `definition.execute` receives the coerced value (for example `7` sent for a
 * string slot arrives as `'7'`), not the raw call value. A call whose `args` carries a key outside
 * the closed inferred schema, misses a required key, or holds a value not coercible to its slot's
 * type throws a `ToolError` with code `ARGUMENTS` (`@orkestrel/tool`) carrying `context.faults`, and
 * `definition.execute` is never called. `format` annotations are never asserted (see
 * {@link import('./types.js').EndpointToolOptions.strict}). With
 * `strict: false`, the tool's `execute` passes through the model-supplied `args` to
 * `definition.execute` without validation — the raw-passthrough opt-out. The execution context
 * the tool's `execute` receives reaches `definition.execute` unchanged whichever way `args` are
 * handled, so a handler that reads `context.signal` observes the caller's cancellation. Either way,
 * the definition's return flows back as the tool call's plain result; a throw propagates uncaught,
 * isolated by the `ToolManagerInterface` (`@orkestrel/tool`) into the canonical error envelope
 * — never caught or re-wrapped here.
 *
 * @param definition - The endpoint's identity, non-empty samples, and local handler (see
 *   {@link import('./types.js').EndpointDefinition})
 * @param options - Construction-time inference tuning and the strict opt-out (see
 *   {@link import('./types.js').EndpointToolOptions})
 * @returns A `ToolInterface` named `definition.name`
 *
 * @example
 * ```ts
 * import { createEndpointTool } from '@src/core'
 * import { createToolManager } from '@orkestrel/tool'
 *
 * const tool = createEndpointTool({
 * 	name: 'lookupUser',
 * 	description: 'Look up a user by id.',
 * 	samples: [{ id: '1', name: 'Ada' }, { id: '2', name: 'Bob' }],
 * 	execute: (args) => ({ id: args.id, name: 'Ada' }),
 * })
 * const tools = createToolManager()
 * tools.add(tool)
 *
 * // conforming args (all required keys present) parse and reach the definition's `execute`
 * const result = await tools.execute({
 * 	id: 'call-1',
 * 	name: 'lookupUser',
 * 	arguments: { id: '1', name: 'Ada' },
 * })
 * // result.value -> { id: '1', name: 'Ada' }
 *
 * // a nonconforming call (id is not coercible to the required string) is rejected before
 * // the definition's `execute` runs
 * const rejected = await tools.execute({
 * 	id: 'call-2',
 * 	name: 'lookupUser',
 * 	arguments: { id: true, name: 'Ada' },
 * })
 * // rejected.error -> the ARGUMENTS ToolError message, which names `id`
 * ```
 */
export function createEndpointTool(
	definition: EndpointDefinition,
	options?: EndpointToolOptions,
): ToolInterface {
	if (definition.samples.length === 0) {
		throw new ToolboxError('TOOL', 'endpoint requires at least one sample', {
			name: definition.name,
		})
	}
	const objectSchema = schemaToObject(
		samplesToSchema(definition.samples, {
			format: options?.format ?? false,
			enum: options?.enum ?? false,
		}),
	)
	const parameters = schemaToParameters(objectSchema)
	return createTool({
		name: definition.name,
		description: definition.description,
		...(parameters === undefined ? {} : { parameters }),
		...(options?.strict === undefined ? {} : { strict: options.strict }),
		execute(args, context) {
			return definition.execute(args, context)
		},
	})
}
