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
import { createWorkspaceManager, isText, rangeOf } from '@orkestrel/workspace'
import { createTool } from '@orkestrel/tool'
import {
	attempt,
	cloneJSONRecord,
	createContract,
	isRecord,
	parseJSONValue,
	rawShape,
	samplesToSchema,
	schemaToObject,
	schemaToParameters,
	schemaToShape,
	stringShape,
} from '@orkestrel/contract'
import { isTerminalError } from '@orkestrel/terminal'
import { createForm, isFormError, isFormValues, parseForm } from '@orkestrel/form'
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
	WORKFLOW_TOOL_NAME,
	WORKFLOW_TOOL_SUMMARY,
	WORKSPACE_TOOL_DESCRIPTION,
	WORKSPACE_TOOL_NAME,
	WORKSPACE_TOOL_SUMMARY,
} from './constants.js'
import { ToolboxError, isToolboxError } from './errors.js'
import {
	clampQuery,
	completeDraft,
	deriveWorkflowDepth,
	expandInclude,
	expandSteps,
	extendLineage,
	inferDatabaseCode,
	inferRelationCode,
	inferTerminalCode,
	normalizeLineage,
	normalizeQuery,
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
 * Wraps a registered tool as a {@link WorkflowFunction} (`@orkestrel/workflow`) — the OPT-IN
 * adapter that lets a `function`-form task run a `@orkestrel/tool` tool BY NAME.
 *
 * @remarks
 * Composes into a caller's `WorkflowOptions.functions` registry like any other behavior
 * (`{ publish: createToolFunction(tools, 'publish') }`); the pure workflow runner has no
 * knowledge of tools itself. The returned function executes `name` against `tools` with the
 * task's `controller.input` as the call arguments. The adapter resolves the live tool, calls its
 * `execute` method directly, and deep-gates the returned unknown through `parseJSONValue`.
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
		const result = parseJSONValue(await tool.execute(controller.input))
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
 * `context.tools`, propagating opaque leaves, raw agents, lineage, and the native store. The
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
		if (typeof fn !== 'function') {
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
 * Compiles the lenient workflow draft contract used by {@link createWorkflowTool}.
 *
 * @returns The compiled {@link import('./types.js').WorkflowDraft} contract
 */
export function createWorkflowDraftContract(): ContractInterface<WorkflowDraft> {
	return createContract(workflowDraftShape)
}

/**
 * Wraps a {@link WorkflowDefinition} as an LLM-callable tool — it ADVERTISES the SIMPLE flat
 * authoring shape (`{ name?, steps: [{ name }] }`) as its `parameters` so even a small model can
 * author a complete tree, and its handler EXPANDS / COMPLETES the authored blob, validates it
 * against the STRICT contract, and runs it through `runner`, forwarding the caller's optional
 * named functions and native checkpoint store.
 *
 * @remarks
 * A plain `ToolManagerInterface`-compatible tool (`@orkestrel/tool`), reproducing
 * Toolbox's flat / draft / full authoring contract, strict soundness gate, and lineage guard.
 * It is ALSO the propagation carrier
 * {@link createAgentFunction} binds onto a wrapped agent's `context.tools`: because a tool
 * handler receives only the model-supplied `args`, the immutable lineage is closed over at bind
 * time. The authored target is appended and its zero-based depth derived from workflow tags.
 *
 * **Widened authoring surface (additive — the canonical contract + runner stay STRICT and
 * unchanged).** A 2B model reliably CALLS the tool but cannot reliably emit the full four-level
 * nested {@link WorkflowDefinition} (six required `id`/`name` strings, an all-or-nothing tree).
 * So the tool ACCEPTS three authoring forms and converges them on the SAME strict
 * `createWorkflowContract` gate before running (soundness preserved):
 * - the FLAT shape `{ name?, steps: [{ name }] }` — the ADVERTISED `parameters` (the simplest
 *   form, {@link import('./helpers.js').expandSteps}'d into one one-task phase per step);
 * - a nested DRAFT with any `id`/`name` OMITTED — {@link createWorkflowDraftContract}-parsed then
 *   {@link import('./helpers.js').completeDraft}'d (missing ids synthesized positionally);
 * - the full nested {@link WorkflowDefinition} — the advanced escape-hatch, accepted as the draft
 *   super-set.
 *
 * The universal tool-handler contract: returns the plain run summary
 * (`{ status, count, durable?, fault? }`) on success, THROWS a typed `ToolboxError` on Toolbox
 * boundary failures — malformed authored args (`TOOL`), or an over-deep / cyclic nested run
 * (`DEPTH`) — and preserves genuine runner `WorkflowError`s. The `ToolManagerInterface` isolates every throw into the canonical tool result's
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
		async execute(args) {
			const cloned = attempt(() => cloneJSONRecord(args))
			if (!cloned.success) {
				throw new ToolboxError('TOOL', 'malformed workflow definition', {
					workflow: definition.id,
				})
			}
			const owned = cloned.value
			// Branch on the owned args snapshot's SHAPE (no ambient context — a tool handler gets only
			// `args`): empty ⇒ the wrapped definition; a `steps` array ⇒ the FLAT form, parsed +
			// expanded; otherwise the nested DRAFT form, parsed + completed. A parse failure leaves
			// `target` undefined ⇒ the strict gate below throws `TOOL`.
			let target: WorkflowDefinition | undefined
			if (Object.keys(owned).length === 0) {
				target = definition
			} else if (Array.isArray(owned.steps)) {
				const flat = steps.parse(owned)
				target = flat === undefined ? undefined : expandSteps(flat)
			} else {
				const parsed = draft.parse(owned)
				target = parsed === undefined ? undefined : completeDraft(parsed)
			}
			// The SOUNDNESS gate: whatever authoring form produced `target`, it must satisfy the
			// STRICT canonical contract before it runs — the leniency never reaches the runner.
			if (target === undefined || !strict.is(target)) {
				throw new ToolboxError('TOOL', 'malformed workflow definition', {
					workflow: definition.id,
				})
			}
			const tag = tagWorkflow(target.id)
			if (lineage.includes(tag)) {
				throw new ToolboxError('DEPTH', `workflow '${target.id}' is already an ancestor (cycle)`, {
					workflow: target.id,
					lineage: [...lineage],
				})
			}
			const targetLineage = extendLineage(lineage, tag)
			const depth = deriveWorkflowDepth(targetLineage)
			if (depth > MAX_WORKFLOW_CHAIN) {
				throw new ToolboxError('DEPTH', `nested workflow exceeds max depth ${MAX_WORKFLOW_CHAIN}`, {
					workflow: target.id,
					depth,
					max: MAX_WORKFLOW_CHAIN,
				})
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
 * Builds an LLM-callable workspace-editing tool — it ADVERTISES the `operation`-discriminated
 * union ({@link import('./shapers.js').workspaceToolShape}) as its `parameters`, and its
 * handler PARSES the model-supplied args against that contract and DISPATCHES the matched
 * operation against the manager's ACTIVE workspace (the registry ops drive the manager itself),
 * returning the plain result. A malformed operation throws this package's `ToolboxError`; a
 * genuine workspace-domain failure propagates `@orkestrel/workspace`'s typed `WorkspaceError`.
 * EITHER drives a caller-supplied {@link WorkspaceToolOptions.manager} directly, OR
 * constructs a fresh `WorkspaceManagerInterface` (`@orkestrel/workspace`) over
 * {@link import('./types.js').WorkspaceToolOptions.store} (via `@orkestrel/workspace`'s
 * `createWorkspaceManager`); neither given constructs a manager backed by
 * `@orkestrel/workspace`'s in-memory store default.
 *
 * @remarks
 * MANAGER-DRIVEN: every edit / read op (read / list / has / search / replace / write / splice /
 * prepend / append / move / remove) targets `manager.active`, so the model edits whichever
 * workspace is active and a host can re-point it (`WorkspaceManagerInterface.switch`) between
 * turns. Two REGISTRY ops make the model self-sufficient: `workspaces` LISTS the registered
 * workspaces (each `{ id, files, active }`) so it can discover an id, and `switch` re-points the
 * active workspace by id (lenient — an unknown id is a no-op reporting `switched: false`, never a
 * throw).
 *
 * NO-ACTIVE RULE (the ergonomic seam): a WRITING op (write / splice / prepend / append / move /
 * remove / replace) run when `manager.active` is `undefined` AUTO-CREATES + activates a default
 * workspace (`manager.add()`) so the model can start writing; a pure-READ op (read / list /
 * has / search) against no active workspace returns the EMPTY result (`undefined` / `[]` /
 * `false`), never creating one and never throwing.
 *
 * The handler conforms to the universal tool-handler contract: it `contract.parse`s
 * the args, THROWS a `TOOL` `ToolboxError` when no operation arm matched (a malformed / unknown
 * operation), else `switch`es on `op.operation` and RETURNS the plain result — letting a
 * `WorkspaceError` raised by the live workspace (`MISSING` / `MODALITY` / `PATTERN` / `RANGE`)
 * PROPAGATE uncaught. The range edit is the FLAT `'splice'` op: its four flat caret integers are
 * reassembled into a `Range` (`@orkestrel/workspace`) by `rangeOf` and fed to the workspace's
 * ranged `write`.
 *
 * @param options - `manager` (drive directly) OR `store` (build a manager over it); neither ⇒
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
	const parameters = schemaToParameters(contract.schema)
	return createTool({
		name: options?.name ?? WORKSPACE_TOOL_NAME,
		description: options?.description ?? WORKSPACE_TOOL_DESCRIPTION,
		summary: WORKSPACE_TOOL_SUMMARY,
		...(parameters === undefined ? {} : { parameters }),
		execute(args) {
			const op = contract.parse(args)
			if (op === undefined) {
				throw new ToolboxError('TOOL', 'unknown or malformed operation', { args })
			}
			// Registry ops act on the MANAGER, not a workspace — handle them first.
			if (op.operation === 'workspaces') {
				const activeId = manager.active?.id
				return manager.workspaces().map((workspace) => ({
					id: workspace.id,
					files: workspace.count,
					active: workspace.id === activeId,
				}))
			}
			if (op.operation === 'switch') {
				const switched = manager.switch(op.id)
				// Lenient: an unknown id leaves `active` unchanged and reports `switched: false`.
				return switched === undefined
					? { id: op.id, switched: false }
					: { id: switched.id, switched: true, files: switched.count }
			}
			// Edit / read ops target the ACTIVE workspace. A WRITING op ensures a target — auto-creating
			// + activating a default workspace when none is active (the no-active ergonomic seam) — while
			// a pure-READ op returns the empty result against no active workspace rather than creating one.
			const active = manager.active
			switch (op.operation) {
				case 'read':
					return active?.read(op.path)
				case 'list':
					return (active?.files() ?? []).map((file) => ({
						path: file.path,
						state: file.state,
						size: file.size,
						lines: file.lines,
						kind: isText(file.content) ? 'text' : 'binary',
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
					const workspace = active ?? manager.add()
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
					const workspace = active ?? manager.add()
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
					const workspace = active ?? manager.add()
					return { from: op.from, to: op.to, moved: workspace.move(op.from, op.to) }
				}
				case 'remove': {
					const workspace = active ?? manager.add()
					return { path: op.path, removed: workspace.remove(op.path) }
				}
			}
		},
	})
}

/**
 * Builds an LLM-callable sub-agent delegation tool — resolves a live, seeded `AgentInterface`
 * from `registry` and runs it to completion for ONE delegated `task`.
 *
 * @remarks
 * The universal tool-handler contract: validates the call args against
 * {@link import('./shapers.js').agentToolShape}, assembles an `AgentJobInput` (`task` seeds the
 * sub-agent's conversation as a single `user` message; `provider` / `tools` / `system` fall
 * back to the tool's own {@link import('./types.js').AgentToolOptions} defaults), rehydrates the sub-agent via
 * `registry.build`, runs it with `agent.generate()`, and returns the settled
 * `AgentResult.content` string (the sub-agent's final text). A missing / unresolvable `provider`, or a malformed call, THROWS a typed `TOOL`
 * {@link import('./errors.js').ToolboxError}; a delegation that would exceed
 * {@link import('./constants.js').AGENT_TOOL_DEPTH}, or re-enter an already-delegated agent (a
 * cycle), THROWS a typed `DEPTH` {@link import('./errors.js').ToolboxError} — both isolated
 * by the `ToolManagerInterface` into the canonical tool result's top-level `error`.
 *
 * `AgentInterface` (`@orkestrel/agent`) exposes no teardown method — a bound sub-agent's
 * lifetime is the single `generate()` call this handler awaits; there is nothing to release
 * afterwards (unlike a store-backed resource, its state lives entirely in the resolved
 * `AgentContextInterface`, owned by the caller's registry).
 *
 * @param registry - The `AgentRegistryInterface` a delegated job resolves against (providers,
 *   tools, authorities, schedulers, and the `build` rehydration seam)
 * @param options - Delegation defaults, depth/ancestry bookkeeping, and advertised overrides
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
	options?: AgentToolOptions,
): ToolInterface {
	const contract = createContract(agentToolShape)
	const parameters = schemaToParameters(contract.schema)
	const depth = options?.depth ?? 0
	const ancestry = options?.ancestry ?? []
	return createTool({
		name: options?.name ?? AGENT_TOOL_NAME,
		description: options?.description ?? AGENT_TOOL_DESCRIPTION,
		summary: AGENT_TOOL_SUMMARY,
		...(parameters === undefined ? {} : { parameters }),
		async execute(args) {
			const call = contract.parse(args)
			if (call === undefined) {
				throw new ToolboxError('TOOL', 'malformed agent-delegation call', { args })
			}
			const provider = call.provider ?? options?.provider
			if (provider === undefined) {
				throw new ToolboxError('TOOL', 'no provider resolved for the delegated agent', {
					task: call.task,
				})
			}
			if (depth + 1 > AGENT_TOOL_DEPTH) {
				throw new ToolboxError('DEPTH', `delegation exceeds max agent depth ${AGENT_TOOL_DEPTH}`, {
					provider,
					depth,
					max: AGENT_TOOL_DEPTH,
				})
			}
			const tag = tagAgent(provider)
			if (ancestry.includes(tag)) {
				throw new ToolboxError('DEPTH', `agent '${provider}' is already an ancestor (cycle)`, {
					provider,
					ancestry: [...ancestry],
				})
			}
			const tools = call.tools ?? options?.tools
			const system = call.system ?? options?.system
			const agent = registry.build({
				provider,
				messages: [{ role: 'user', content: call.task }],
				...(system === undefined ? {} : { system }),
				...(tools === undefined ? {} : { tools }),
			})
			const result = await agent.generate()
			if (options?.store !== undefined) {
				const active = agent.context.conversations.active
				if (active !== undefined) await options.store.set(active.snapshot())
			}
			return result.content
		},
	})
}

/**
 * Builds an LLM-callable tool that returns the FULL `description` of another registered tool by
 * name — the counterpart to the lean `summary` the other tools in this package advertise
 * (`AGENT_TOOL_SUMMARY` / `WORKFLOW_TOOL_SUMMARY` / `WORKSPACE_TOOL_SUMMARY`).
 *
 * @remarks
 * `ToolManagerInterface.definitions()` (`@orkestrel/tool`) advertises `tool.summary ??
 * tool.description` — a lean one-sentence summary stands in for a tool's full teaching
 * description when `summary` is set, keeping the advertised tool list compact for a small model.
 * This tool is the on-demand expansion seam: given a registered tool's `name`, it looks the tool
 * up via `tools.tool(name)` and returns its full `description` (falling back to `summary` when a
 * tool has no `description` of its own, then a placeholder when it has neither).
 *
 * The universal tool-handler contract: validates the call args against
 * {@link import('./shapers.js').describeToolShape}, RETURNS the plain description string on
 * success, THROWS a typed `TOOL` {@link import('./errors.js').ToolboxError} on a malformed call
 * or an unknown tool name.
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
	const parameters = schemaToParameters(contract.schema)
	return createTool({
		name: DESCRIBE_TOOL_NAME,
		description: DESCRIBE_TOOL_DESCRIPTION,
		summary: DESCRIBE_TOOL_SUMMARY,
		...(parameters === undefined ? {} : { parameters }),
		async execute(args) {
			const call = contract.parse(args)
			if (call === undefined) {
				throw new ToolboxError('TOOL', 'malformed describe call', { args })
			}
			const tool = tools.tool(call.name)
			if (tool === undefined) {
				throw new ToolboxError('TOOL', `unknown tool '${call.name}'`, { name: call.name })
			}
			return tool.description ?? tool.summary ?? '<no description>'
		},
	})
}

/**
 * Builds an LLM-callable form tool — the ASK side of the terminal seam. Asks
 * a multi-field form and BLOCKS until it answers, returning the resolved values record.
 *
 * @remarks
 * The universal tool-handler contract: validates the call args against
 * {@link import('./shapers.js').promptToolShape}, parses the call's schema through
 * `@orkestrel/form`, constructs the live form, and passes it to `TerminalManagerInterface.ask`.
 * `from` is FIXED at construction
 * ({@link import('./types.js').PromptToolOptions.from}) — never read from the model-supplied
 * args — so a model cannot spoof which terminal is asking. A form CYCLE rejects with
 * `TerminalError('DEADLOCK')`, re-surfaced as a typed `DEADLOCK`
 * {@link import('./errors.js').ToolboxError}; an expired form re-surfaces as `EXPIRE`; an
 * unknown `to` (or any other `TerminalError`) re-surfaces as `TOOL`, naming the unknown terminal
 * and how many brokers the manager holds (`manager.count`).
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
	const parameters = schemaToParameters(contract.schema)
	return createTool({
		name: options.name ?? PROMPT_TOOL_NAME,
		description: options.description ?? PROMPT_TOOL_DESCRIPTION,
		summary: PROMPT_TOOL_SUMMARY,
		...(parameters === undefined ? {} : { parameters }),
		async execute(args) {
			const call = contract.parse(args)
			if (call === undefined) {
				throw new ToolboxError('TOOL', 'malformed ask call', { args })
			}
			const schema = parseForm(call.schema)
			if (schema === undefined) {
				throw new ToolboxError('TOOL', 'malformed form schema', { schema: call.schema })
			}
			for (const field of schema.fields) {
				if (
					(field.control === 'select' || field.control === 'checkbox') &&
					!field.choices.some((choice) => choice.disabled !== true)
				) {
					throw new ToolboxError(
						'TOOL',
						`${field.control} field '${field.name}' has no enabled choices`,
						{ control: field.control, field: field.name },
					)
				}
			}
			try {
				return await options.manager.ask(options.from, call.to, createForm(schema))
			} catch (error) {
				if (isFormError(error) && error.code === 'ABANDONED') {
					throw new ToolboxError('EXPIRE', `form to '${call.to}' expired before it was answered`, {
						to: call.to,
					})
				}
				const code = inferTerminalCode(error)
				if (code === undefined) throw error
				if (code === 'DEADLOCK') {
					throw new ToolboxError(
						'DEADLOCK',
						`asking '${call.to}' would create a form cycle`,
						isTerminalError(error) ? error.context : { from: options.from, to: call.to },
					)
				}
				if (code === 'EXPIRE') {
					throw new ToolboxError('EXPIRE', `form to '${call.to}' expired before it was answered`, {
						to: call.to,
					})
				}
				if (isTerminalError(error) && error.code === 'TARGET') {
					throw new ToolboxError('TOOL', `unknown terminal '${call.to}'`, {
						to: call.to,
						count: options.manager.count,
					})
				}
				throw new ToolboxError('TOOL', `asking '${call.to}' failed`, { to: call.to })
			}
		},
	})
}

/**
 * Builds an LLM-callable answer tool — the ANSWER side of the terminal seam. Lists the forms
 * currently addressed to {@link import('./types.js').AnswerToolOptions.to}, or answers one of
 * them by id.
 *
 * @remarks
 * The universal tool-handler contract: validates the call args against
 * {@link import('./shapers.js').answerToolShape} (discriminated by `operation`). `'pending'`
 * returns a compact list (`{ id, from, schema }`) of every form currently addressed to `to`.
 * `'answer'` looks the form up by `id`, narrows the supplied `values` through `@orkestrel/form`,
 * and applies it via
 * `TerminalManagerInterface.answer` — a rejected / unknown / unresolvable outcome
 * (`TerminalAnswerResult.error`) re-surfaces as a typed `ANSWER` `ToolboxError`; success returns
 * `{ answered: id }`. `to` is FIXED at construction
 * ({@link import('./types.js').AnswerToolOptions.to}) — never read from the model-supplied args —
 * so a model cannot spoof which terminal it is answering for. Concurrent answerers racing on one
 * endpoint are FIRST-WRITE-WINS — a late answer to an already-settled form returns a typed
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
	const parameters = schemaToParameters(contract.schema)
	return createTool({
		name: options.name ?? ANSWER_TOOL_NAME,
		description: options.description ?? ANSWER_TOOL_DESCRIPTION,
		summary: ANSWER_TOOL_SUMMARY,
		...(parameters === undefined ? {} : { parameters }),
		async execute(args) {
			const call = contract.parse(args)
			if (call === undefined) {
				throw new ToolboxError('TOOL', 'malformed answer call', { args })
			}
			if (call.operation === 'pending') {
				return options.manager.pending(options.to).map((form) => ({
					id: form.id,
					from: form.from,
					schema: form.schema,
				}))
			}
			const form = options.manager.pending(options.to).find((entry) => entry.id === call.id)
			if (form === undefined) {
				throw new ToolboxError('ANSWER', `unknown form '${call.id}'`, {
					id: call.id,
					reason: 'unknown',
				})
			}
			if (!isFormValues(call.values)) {
				throw new ToolboxError('TOOL', 'malformed form values', { values: call.values })
			}
			const result = options.manager.answer(options.to, call.id, call.values)
			if (!result.success) {
				throw new ToolboxError(
					'ANSWER',
					`failed to answer form '${call.id}': ${result.error.reason}`,
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
 * definitions, the DEFAULT store the database and relation tools persist their
 * `DatabaseDefinition` configs through.
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
	// The definition is stored as ONE OPAQUE JSON column (`rawShape`), so the row infers FLAT —
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
 * The universal tool-handler contract: validates the call args against
 * {@link import('./shapers.js').databaseToolShape}, dispatches to the matching operation, and
 * RETURNS a plain result on success. A database is resolved lazily and cached for the tool's
 * lifetime — `'create'` mints one from `tables` ({@link import('./compilers.js').expandTables}) and
 * a registered `driver` key ({@link import('./types.js').DatabaseToolOptions.drivers}, default
 * `{ memory: () => createMemoryDriver() }`); any other operation addressing an uncached id falls
 * back to {@link import('./types.js').DatabaseToolOptions.store} (an unknown id throws a typed
 * `TOOL` {@link import('./errors.js').ToolboxError}). When a `store` is configured, `'create'`
 * persists the new {@link import('./types.js').DatabaseDefinition} and `'destroy'` deletes it.
 *
 * `'records'` clamps its `query` to
 * {@link import('./types.js').DatabaseToolOptions.limit} (default
 * {@link import('./constants.js').DATABASE_TOOL_LIMIT}) via
 * {@link import('./helpers.js').clampQuery}, reporting `truncated` when storage held more rows
 * than the cap. Every operation's `query` is normalized via
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
 * A lazily re-minted database over the DEFAULT in-memory driver yields an EMPTY database — only
 * the {@link import('./types.js').DatabaseDefinition} schema persists in `store`, never rows;
 * durable rows need a persistent driver factory registered in
 * {@link import('./types.js').DatabaseToolOptions.drivers}. `'destroy'` closes whatever handle is
 * cached for the id, including an embedder-supplied
 * {@link import('./types.js').DatabaseToolOptions.databases} handle — the embedder relinquishes
 * that handle's lifecycle to this tool for any id it wires in. This tool assumes the
 * single-writer, non-reentrant model `@orkestrel/database` itself assumes — concurrent calls
 * against one id are NOT serialized by this tool. `'get'` is uncapped by
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
 * await tool.execute({
 * 	operation: 'create',
 * 	id: 'shop',
 * 	tables: { products: { columns: { name: 'string', price: 'number' } } },
 * })
 * ```
 */
export function createDatabaseTool(options: DatabaseToolOptions = {}): ToolInterface {
	if (
		options.timeout !== undefined &&
		(options.timeout < 0 || !Number.isSafeInteger(options.timeout))
	) {
		throw new ToolboxError('TOOL', 'database timeout must be a nonnegative safe integer', {
			timeout: options.timeout,
		})
	}
	const contract = createContract(databaseToolShape)
	const parameters = schemaToParameters(contract.schema)
	const handles = new Map<string, DatabaseInterface>(Object.entries(options.databases ?? {}))
	const drivers = options.drivers ?? { memory: createMemoryDriver }
	const generator = options.generator
	const cap = options.limit ?? DATABASE_TOOL_LIMIT
	const store = options.store
	const resolver =
		store === undefined
			? new DatabaseResolver(handles, drivers, generator)
			: new DatabaseResolver(handles, drivers, generator, store)

	return createTool({
		name: options.name ?? DATABASE_TOOL_NAME,
		description: options.description ?? DATABASE_TOOL_DESCRIPTION,
		summary: DATABASE_TOOL_SUMMARY,
		...(parameters === undefined ? {} : { parameters }),
		async execute(args) {
			const call = contract.parse(args)
			if (call === undefined) {
				throw new ToolboxError('TOOL', 'malformed database call', { args })
			}
			if (options.readonly === true && DATABASE_TOOL_MUTATIONS.includes(call.operation)) {
				throw new ToolboxError(
					'TOOL',
					`operation '${call.operation}' is disabled in readonly mode`,
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
							throw new ToolboxError('TOOL', `database '${call.id}' already exists`, {
								id: call.id,
							})
						}
						const name = call.driver ?? 'memory'
						const factory = drivers[name]
						if (factory === undefined) {
							throw new ToolboxError('TOOL', `unknown driver '${name}'`, {
								id: call.id,
								driver: name,
							})
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
						const many = Array.isArray(call.key)
						const keys = Array.isArray(call.key) ? call.key : [call.key]
						const rows = await table.get(keys)
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
						const many = Array.isArray(call.row)
						const rows = Array.isArray(call.row) ? call.row : [call.row]
						const keys = await table.add(rows, read)
						return many ? { keys } : { key: keys[0] }
					}
					case 'set': {
						const handle = await resolver.resolve(call.id)
						const table = handle.table(call.table)
						const many = Array.isArray(call.row)
						const rows = Array.isArray(call.row) ? call.row : [call.row]
						const keys = await table.set(rows, read)
						return many ? { keys } : { key: keys[0] }
					}
					case 'update': {
						const handle = await resolver.resolve(call.id)
						const table = handle.table(call.table)
						const changes = call.changes
						const many = Array.isArray(call.key)
						const keys = Array.isArray(call.key) ? call.key : [call.key]
						const updated = await table.update(keys, changes, read)
						return many ? { updated } : { updated: updated[0] }
					}
					case 'remove': {
						const handle = await resolver.resolve(call.id)
						const table = handle.table(call.table)
						const many = Array.isArray(call.key)
						const keys = Array.isArray(call.key) ? call.key : [call.key]
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
				throw new ToolboxError('DATABASE', error instanceof Error ? error.message : String(error), {
					code,
					operation: call.operation,
					id: call.id,
					...('table' in call ? { table: call.table } : {}),
				})
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
 * The universal tool-handler contract: validates the call args against
 * {@link import('./shapers.js').relationToolShape}, resolves the addressed
 * {@link import('@orkestrel/relation').RelationManagerInterface} — an explicit `manager` field
 * must match a key of {@link import('./types.js').RelationToolOptions.managers}, an OMITTED one
 * resolves to the SOLE registered manager, either miss throwing a typed `TOOL`
 * {@link import('./errors.js').ToolboxError}
 * ({@link import('./helpers.js').resolveRelationManager}) — then resolves `model` against it
 * ({@link import('./helpers.js').resolveRelationModel}, same typed-`TOOL`-on-miss shape), and
 * dispatches to the matched operation, RETURNING a plain result on success.
 *
 * `'load'` / `'find'` expand the call's FLAT dot-path `include` list into a live
 * `@orkestrel/relation` `Include` tree via {@link import('./helpers.js').expandInclude}, capped
 * at {@link import('./types.js').RelationToolOptions.depth} (default
 * {@link import('./constants.js').RELATION_TOOL_DEPTH}) — a path exceeding the cap, or carrying an
 * empty segment, throws a typed `TOOL` error. `'load'` dispatches on whether `key` is an array
 * (positional many-key form — an array key is read as many keys rather than one) or a single key.
 * `'find'` and `'links'` clamp their
 * result to {@link import('./types.js').RelationToolOptions.limit} (default
 * {@link import('./constants.js').RELATION_TOOL_LIMIT}), taken through
 * {@link import('./helpers.js').resolveLimit} — `'find'` probes one row past the effective limit to
 * report `truncated`; `'links'` (which has no upstream pagination) fetches the FULL linked-key
 * list and slices/truncates it the same way. `'link'` / `'unlink'` write / remove one `through` junction
 * row.
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
 * await tool.execute({ operation: 'load', model: 'accounts', key: 'acc1', include: ['contacts'] })
 * ```
 */
export function createRelationTool(options: RelationToolOptions): ToolInterface {
	const contract = createContract(relationToolShape)
	const parameters = schemaToParameters(contract.schema)
	const depth = options.depth ?? RELATION_TOOL_DEPTH
	const cap = options.limit ?? RELATION_TOOL_LIMIT
	return createTool({
		name: options.name ?? RELATION_TOOL_NAME,
		description: options.description ?? RELATION_TOOL_DESCRIPTION,
		summary: RELATION_TOOL_SUMMARY,
		...(parameters === undefined ? {} : { parameters }),
		async execute(args) {
			const call = contract.parse(args)
			if (call === undefined) {
				throw new ToolboxError('TOOL', 'malformed relation call', { args })
			}
			try {
				const manager = resolveRelationManager(options.managers, call.manager)
				const model = resolveRelationModel(manager, call.model)
				switch (call.operation) {
					case 'load': {
						const include = expandInclude(call.include, depth)
						if (typeof call.key === 'string' || typeof call.key === 'number') {
							const row = await model.load(call.key, include)
							return { row }
						}
						const rows = await model.load(call.key, include)
						return { rows }
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
						error instanceof Error ? error.message : String(error),
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
				throw new ToolboxError('DATABASE', error instanceof Error ? error.message : String(error), {
					code: database,
					operation: call.operation,
				})
			}
		},
	})
}

/**
 * Builds a standalone LLM-callable tool that infers a JSON Schema from example values — the
 * utility half of the "existing API/DB → MCP tool" bridge (the other half,
 * {@link createEndpointTool}, wraps one CONCRETE endpoint).
 *
 * @remarks
 * The universal tool-handler contract: validates the call args against
 * {@link import('./shapers.js').inferToolShape} (`samples` non-empty, `format` / `enum` optional
 * booleans, `candidates` an optional array), infers a schema via `@orkestrel/contract`'s
 * `samplesToSchema`, wraps a non-object root as `{ value: <schema> }` via `schemaToObject` (mirrors
 * the tool-parameters convention every other `create*Tool` factory advertises), and RETURNS the
 * resulting parameters record. An empty `samples` array fails `inferToolShape`'s `min: 1` bound —
 * `contract.parse` returns `undefined` and the handler throws a typed `TOOL`
 * {@link import('./errors.js').ToolboxError}.
 *
 * When `candidates` is ABSENT, the return is the bare parameters record — unchanged from before
 * this array existed. When `candidates` is PRESENT (any array, including empty), the handler
 * compiles a SEPARATE per-call contract from the RAW inferred schema (via `@orkestrel/contract`'s
 * `schemaToShape`, NOT the `schemaToObject`-wrapped parameters — a bare-value sample checks a
 * bare-value candidate) and returns `{ parameters, checks }`, one check per candidate at the same
 * index. Every entry has a UNIFORM shape — `{ index, valid, coercible }`, with `faults` added ONLY
 * when `valid` is `false`: `valid` is the STRICT guard verdict (`checker.is(candidate)`), the
 * OPPOSITE of {@link createEndpointTool}'s enforcement, which coerces (`7` becomes `'7'` for a
 * string slot) — here a conformance report answers "does this value conform AS-IS": `7` against a
 * string slot is `valid: false`, full stop. `coercible` answers a SEPARATE question — "would the
 * NORMALIZING parse accept this value", i.e. would {@link createEndpointTool}'s default enforcement
 * admit it (`checker.parse(candidate) !== undefined`) — computed for every candidate regardless of
 * `valid`; by the house parse/guard round-trip guarantee, a `valid: true` entry is
 * ALWAYS also `coercible: true`. `@orkestrel/contract`'s `explain` mirrors the normalizing
 * `parse`'s leniency, not `is`'s strictness — so a strictly-invalid but coercible candidate (`7`
 * against a string slot) yields `{ valid: false, coercible: true, faults: [] }`: EMPTY faults, since
 * the mismatch the normalizing parse would silently fix is not one `explain` reports. `faults`
 * therefore only ever populates for a NON-coercible mismatch — a wrong type the parse can't coerce
 * (a boolean in a string slot), a missing required key, or an out-of-enum value — where
 * `coercible: false`. `checker.is` / `.parse` / `.explain` are all total over JSON-safe input — a
 * JSON-safe hostile candidate (a `__proto__`-carrying object, deeply nested data) reaches all three
 * and yields a bounded, non-throwing per-candidate verdict; a NON-JSON-safe candidate (e.g. a
 * throwing-getter `Proxy`) never reaches the checker at all — it fails the OUTER `args` parse
 * against {@link import('./shapers.js').inferToolShape} and rejects the WHOLE call with the same
 * `TOOL` {@link import('./errors.js').ToolboxError} a malformed `samples`/`format`/`enum` throws,
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
	const parameters = schemaToParameters(contract.schema)
	return createTool({
		name: options?.name ?? INFER_TOOL_NAME,
		description: options?.description ?? INFER_TOOL_DESCRIPTION,
		summary: INFER_TOOL_SUMMARY,
		...(parameters === undefined ? {} : { parameters }),
		async execute(args) {
			const parsed = contract.parse(args)
			if (parsed === undefined) {
				throw new ToolboxError('TOOL', 'malformed infer arguments', { args })
			}
			const schema = samplesToSchema(parsed.samples, {
				format: parsed.format ?? false,
				enum: parsed.enum ?? false,
			})
			const result = schemaToParameters(schemaToObject(schema))
			if (result === undefined) {
				throw new ToolboxError('TOOL', 'could not infer a schema', { args })
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
					: { index, valid, coercible, faults: checker.explain(candidate) }
			})
			return { parameters: result, checks }
		},
	})
}

/**
 * Wraps one CONCRETE endpoint ({@link import('./types.js').EndpointDefinition}) as an LLM-callable
 * `ToolInterface` — the endpoint half of the "existing API/DB → MCP tool" bridge (the other half,
 * {@link createInferTool}, is a standalone inference utility).
 *
 * @remarks
 * `parameters` is inferred ONCE at construction from `definition.samples` via
 * `@orkestrel/contract`'s `samplesToSchema` (tuned by {@link import('./types.js').EndpointToolOptions}'s
 * `format` / `enum`), wrapping a non-object root as `{ value: <schema> }` via `schemaToObject` —
 * the SAME object-rooted schema is both the ADVERTISED `parameters` and, by default
 * ({@link import('./types.js').EndpointToolOptions.validate} `true`), the ENFORCED contract:
 * `@orkestrel/contract`'s `schemaToShape` compiles it ONCE (through `createContract`) into a
 * `ContractInterface` whose `.parse` runs on every call's `args` before `definition.execute` — a
 * NORMALIZING parse, not a strict type check: a scalar is COERCED to its inferred type where the
 * house parsers coerce (a number to/from a numeric string, a boolean from `'1'`/`'0'`/`'true'`/
 * `'false'`/`1`/`0`), so `definition.execute` receives the COERCED value (e.g. `7` sent for a
 * string slot arrives as `'7'`), not the raw call value. A call whose `args` fails to parse into
 * a record — a required key missing, or a value not coercible to its slot's type — THROWS a
 * typed `TOOL` {@link import('./errors.js').ToolboxError} carrying the compiled contract's
 * structured `explain` faults, and `definition.execute` is never called. `format` annotations are
 * NEVER asserted, and a key outside the closed inferred schema is SILENTLY DROPPED rather than
 * rejected (see {@link import('./types.js').EndpointToolOptions.validate}). With
 * `validate: false`, the tool's `execute` PASSES THROUGH the model-supplied `args` to
 * `definition.execute` WITHOUT re-validation — the raw-passthrough opt-out. Either way, the
 * definition's return flows back as the tool call's plain result; a throw PROPAGATES uncaught,
 * isolated by the `ToolManagerInterface` (`@orkestrel/tool`) into the canonical error envelope
 * — never caught or re-wrapped here.
 *
 * @param definition - The endpoint's identity, non-empty samples, and local handler (see
 *   {@link import('./types.js').EndpointDefinition})
 * @param options - Construction-time inference tuning + the validate opt-out (see
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
 * // rejected.error -> the TOOL ToolboxError message
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
	const validate = options?.validate ?? true
	if (!validate) {
		return createTool({
			name: definition.name,
			description: definition.description,
			...(parameters === undefined ? {} : { parameters }),
			execute(args) {
				return definition.execute(args)
			},
		})
	}
	const contract = createContract(schemaToShape(objectSchema))
	return createTool({
		name: definition.name,
		description: definition.description,
		...(parameters === undefined ? {} : { parameters }),
		execute(args) {
			const parsed = contract.parse(args)
			if (parsed === undefined || !isRecord(parsed)) {
				throw new ToolboxError('TOOL', 'malformed endpoint call arguments', {
					name: definition.name,
					faults: contract.explain(args),
				})
			}
			return definition.execute(parsed)
		},
	})
}
