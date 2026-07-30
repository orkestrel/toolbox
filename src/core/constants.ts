import type { WorkflowDefinition } from '@orkestrel/workflow'
import type { WorkflowSteps, WorkspaceOperation } from './types.js'

// Tool-package constants — UPPER_SNAKE, `Object.freeze`d, every member exported (AGENTS §5).
// The workflow tool's name/description/examples/depth-bound and the workspace tool's
// name/description are OWNED here now — ported byte-faithfully from `@orkestrel/workflow` /
// `@orkestrel/agent` ahead of the upstream cleanup that drops the authoring surface from those
// packages (this package becomes the defining home). Only the net-new agent tool's constants
// were already net-new to this package.

/**
 * The name {@link import('./factories.js').createAgentTool} advertises by default — the key a
 * model calls and the `ToolManagerInterface` (`@orkestrel/agent`) registers under.
 */
export const AGENT_TOOL_NAME = 'agent'

/**
 * The maximum nesting depth a delegation chain (agent tool → sub-agent → agent tool → …) may
 * reach — the bound {@link import('./factories.js').createAgentTool}'s depth/cycle guard
 * enforces.
 *
 * @remarks
 * Deliberately a SEPARATE constant from {@link MAX_WORKFLOW_DEPTH} (rather than the two guards
 * sharing one reference): the two guards bound DIFFERENT chains (workflow nesting vs. agent
 * delegation) that happen to share a value today, and keeping this bound decoupled means a
 * future change to one never silently shifts the other. Same numeric value by convention, not
 * by shared reference.
 */
export const AGENT_TOOL_DEPTH = 8

/**
 * The DESCRIPTION {@link import('./factories.js').createAgentTool} advertises — a short guide
 * that teaches a model how to delegate a task to a sub-agent.
 *
 * @remarks
 * Mirrors {@link WORKFLOW_TOOL_DESCRIPTION} / `WORKSPACE_TOOL_DESCRIPTION`'s teaching style: names
 * the required `task` field, and documents the optional per-call `provider` / `tools` /
 * `system` overrides.
 */
/**
 * The lean {@link import('@orkestrel/agent').ToolInterface.summary} {@link import('./factories.js').createAgentTool}
 * advertises in place of {@link AGENT_TOOL_DESCRIPTION} — a `ToolManagerInterface.definitions()`
 * (`@orkestrel/agent`) advertises `summary ?? description`, so this one-sentence text stands in
 * for the full teaching description; the full text stays retrievable via
 * {@link import('./factories.js').createDescribeTool}.
 */
export const AGENT_TOOL_SUMMARY =
	"Delegate a task to a sub-agent and return its result; each call runs one sub-agent turn to completion. Call describe('agent') for the optional provider/tools/system overrides."

export const AGENT_TOOL_DESCRIPTION = [
	'Delegate a task to a sub-agent and return its result. Every call runs ONE sub-agent turn to completion.',
	'',
	'Required:',
	'  task     - the instructions the sub-agent should carry out.',
	'Optional overrides (default to the values this tool was configured with):',
	'  provider - the registry key of the model/provider the sub-agent runs against.',
	'  tools    - registry keys of the tools loaded into the sub-agent (replaces the default list, not merged).',
	"  system   - a system prompt seeding the sub-agent's context (replaces the default).",
	'Example:',
	JSON.stringify({
		task: 'Summarize the attached notes in three bullet points.',
	}),
].join('\n')

/**
 * The maximum nesting depth a workflow → agent → workflow chain may reach — the bound
 * {@link import('./factories.js').createAgentFunction} and
 * {@link import('./factories.js').createWorkflowTool}'s depth/cycle guards enforce.
 *
 * @remarks
 * OWNED here now (ported from `@orkestrel/workflow`, whose engine no longer uses it — only the
 * tool-authoring guards this package now owns consume it). The limit lives in ONE place: an
 * agent-function-wrapped agent running at this depth can no longer author + run a NESTED
 * workflow through its bound workflow tool (that would be depth `MAX_WORKFLOW_DEPTH + 1`), so
 * the over-deep invocation is REJECTED (a typed `DEPTH` `WorkflowError` throw, `@orkestrel/workflow`).
 */
export const MAX_WORKFLOW_DEPTH = 8

/**
 * The name {@link import('./factories.js').createWorkflowTool} advertises by default — the key a
 * model calls and the `ToolManagerInterface` (`@orkestrel/agent`) registers under, and the name
 * {@link import('./factories.js').createAgentFunction} binds the depth/cycle-aware workflow tool
 * under onto a wrapped agent's `context.tools`.
 *
 * @remarks
 * OWNED here now (ported from `@orkestrel/workflow`). The propagation seam's well-known key: when
 * `createAgentFunction`'s `runner` option is supplied, it adds a `createWorkflowTool`-built tool
 * under this name to the agent's `context.tools`, so it can author + run a NESTED workflow
 * (bounded by {@link MAX_WORKFLOW_DEPTH}).
 */
export const WORKFLOW_TOOL_NAME = 'workflow'

/**
 * A complete FLAT authoring example — the PRIMARY way a small model authors a workflow through
 * {@link import('./factories.js').createWorkflowTool}: `{ name, steps: [{ name }] }`.
 *
 * @remarks
 * OWNED here now (ported from `@orkestrel/workflow`). Each step becomes a one-task phase, in
 * order; a step's `name` is a REGISTERED behavior name (not a label) — the registry key its
 * task's `run` resolves against. The tool expands this
 * ({@link import('./helpers.js').expandSteps}) into a valid `WorkflowDefinition`
 * (`@orkestrel/workflow`). It is embedded VERBATIM in {@link WORKFLOW_TOOL_DESCRIPTION}.
 */
export const WORKFLOW_TOOL_FLAT_EXAMPLE: WorkflowSteps = Object.freeze({
	name: 'release',
	steps: Object.freeze([Object.freeze({ name: 'compile' }), Object.freeze({ name: 'publish' })]),
})

/**
 * A minimal NESTED authoring example — the ADVANCED escape-hatch form a model may use instead of
 * the flat shape: a full `WorkflowDefinition` (`@orkestrel/workflow`).
 *
 * @remarks
 * OWNED here now (ported from `@orkestrel/workflow`). The full four-level form, documented in
 * {@link WORKFLOW_TOOL_DESCRIPTION} as the advanced alternative. It is embedded VERBATIM.
 */
export const WORKFLOW_TOOL_NESTED_EXAMPLE: WorkflowDefinition = Object.freeze({
	id: 'release',
	name: 'Release',
	phases: Object.freeze([
		Object.freeze({
			id: 'build',
			name: 'Build',
			tasks: Object.freeze([
				Object.freeze({
					id: 'compile',
					name: 'Compile',
					run: 'compile',
				}),
			]),
		}),
	]),
})

/**
 * The DESCRIPTION {@link import('./factories.js').createWorkflowTool} advertises — a multi-line
 * guide that teaches a small model how to author a complete workflow tree.
 *
 * @remarks
 * OWNED here now (ported from `@orkestrel/workflow`). Presents the SIMPLE flat shape
 * (`{ name, steps: [{ name }] }`) as the PRIMARY way with one complete worked example
 * ({@link WORKFLOW_TOOL_FLAT_EXAMPLE}), names that a step's `name` is a REGISTERED name (not a
 * human label), and documents the full nested `WorkflowDefinition` as the ADVANCED form with a
 * minimal example ({@link WORKFLOW_TOOL_NESTED_EXAMPLE}). The `parameters` the tool advertises
 * are the FLAT shape's schema; the nested form is the documented escape-hatch (the tool accepts
 * both).
 */
/**
 * The lean {@link import('@orkestrel/agent').ToolInterface.summary} {@link import('./factories.js').createWorkflowTool}
 * advertises in place of {@link WORKFLOW_TOOL_DESCRIPTION} — a `ToolManagerInterface.definitions()`
 * (`@orkestrel/agent`) advertises `summary ?? description`, so this one-sentence text stands in
 * for the full teaching description; the full text stays retrievable via
 * {@link import('./factories.js').createDescribeTool}.
 */
export const WORKFLOW_TOOL_SUMMARY =
	"Author and run a multi-phase workflow in one call — phases run in sequence, tasks within a phase run concurrently. Call describe('workflow') for the full authoring schema and examples."

export const WORKFLOW_TOOL_DESCRIPTION = [
	'Author and run a workflow (phases run sequentially, the tasks within a phase run concurrently) in one call.',
	'',
	'SIMPLEST way — a flat list of steps. Each step runs one registered behavior; steps run one after another:',
	'  { "name": "<workflow name>", "steps": [ { "name": "<registered name>" }, ... ] }',
	'- a step\'s "name" is a REGISTERED behavior name (a registry key), NOT a human label.',
	'- the top-level "name" (the workflow name) is optional. Ids are filled in for you.',
	'Example:',
	JSON.stringify(WORKFLOW_TOOL_FLAT_EXAMPLE),
	'',
	'ADVANCED — the full nested form, for multi-task phases or explicit ids. A workflow has phases; a phase has tasks; a task has a "run" (a registered behavior name):',
	JSON.stringify(WORKFLOW_TOOL_NESTED_EXAMPLE),
	'In the nested form you may omit any "id"/"name" and they are filled in positionally; a provided one is kept.',
].join('\n')

/**
 * The name {@link import('./factories.js').createWorkspaceTool} advertises by default — the key a
 * model calls and the `ToolManagerInterface` (`@orkestrel/agent`) registers under.
 *
 * @remarks
 * OWNED here now (ported from `@orkestrel/agent`).
 */
export const WORKSPACE_TOOL_NAME = 'workspace'

/**
 * A valid `WorkspaceOperation` (`@orkestrel/agent`) object — the canonical example embedded
 * VERBATIM in {@link WORKSPACE_TOOL_DESCRIPTION}.
 *
 * @remarks
 * OWNED here now (ported from `@orkestrel/agent`). A `'write'` op (the most common authoring
 * action): create or overwrite `notes.txt` with `hello`. Frozen so it cannot be mutated in
 * place.
 */
export const WORKSPACE_TOOL_EXAMPLE: WorkspaceOperation = Object.freeze({
	operation: 'write',
	path: 'notes.txt',
	content: 'hello',
})

/**
 * The DESCRIPTION {@link import('./factories.js').createWorkspaceTool} advertises — a multi-line
 * guide that teaches a small model how to drive a workspace through the single
 * `operation`-keyed tool.
 *
 * @remarks
 * OWNED here now (ported from `@orkestrel/agent`). Mirrors {@link WORKFLOW_TOOL_DESCRIPTION}'s
 * teaching style: names the `operation` discriminant field, enumerates all 13 operations with
 * their FLAT fields, gives a worked example for the common ones, and embeds
 * {@link WORKSPACE_TOOL_EXAMPLE} verbatim.
 */
/**
 * The lean {@link import('@orkestrel/agent').ToolInterface.summary} {@link import('./factories.js').createWorkspaceTool}
 * advertises in place of {@link WORKSPACE_TOOL_DESCRIPTION} — a `ToolManagerInterface.definitions()`
 * (`@orkestrel/agent`) advertises `summary ?? description`, so this one-sentence text stands in
 * for the full teaching description; the full text stays retrievable via
 * {@link import('./factories.js').createDescribeTool}.
 */
export const WORKSPACE_TOOL_SUMMARY =
	"Read and edit files in a workspace — one operation per call (read, write, list, search, replace, splice, move, remove, plus workspace switching), chosen by the 'operation' field. Call describe('workspace') for the full operation list and fields."

export const WORKSPACE_TOOL_DESCRIPTION = [
	'Read and edit files in a workspace. Every call is ONE operation, chosen by the "operation" field.',
	'All file operations act on the ACTIVE workspace; use "workspaces" then "switch" to move between workspaces.',
	'',
	'Operations (each takes the fields listed):',
	'- read     { "operation": "read", "path": "<file>" } — return the file\'s text.',
	'- list     { "operation": "list" } — list every file in the active workspace (path, state, size, lines, kind).',
	'- has      { "operation": "has", "path": "<file>" } — whether the file exists.',
	'- search   { "operation": "search", "query": "<text>", "regex"?: bool, "exact"?: bool, "limit"?: int } — find lines matching the query across all files.',
	'- replace  { "operation": "replace", "query": "<text>", "replacement": "<text>", "regex"?: bool, "exact"?: bool, "limit"?: int } — replace matches across all files.',
	'- write    { "operation": "write", "path": "<file>", "content": "<text>" } — create or overwrite the whole file.',
	'- splice   { "operation": "splice", "path": "<file>", "content": "<text>", "fromLine": int, "fromColumn": int, "toLine": int, "toColumn": int } — replace a 1-based range (from inclusive, to exclusive) with content.',
	'- prepend  { "operation": "prepend", "path": "<file>", "content": "<text>" } — add content to the start of the file.',
	'- append   { "operation": "append", "path": "<file>", "content": "<text>" } — add content to the end of the file.',
	'- move     { "operation": "move", "from": "<file>", "to": "<file>" } — rename / move a file.',
	'- remove   { "operation": "remove", "path": "<file>" } — delete a file.',
	'- workspaces { "operation": "workspaces" } — list the workspaces you can switch between (each id, file count, active).',
	'- switch   { "operation": "switch", "id": "<id>" } — make the workspace with that id active (ids come from "workspaces").',
	'',
	'Notes: lines and columns are 1-based (column 1 is the first character). "regex" defaults to false (a literal substring), "exact" defaults to true (case-sensitive). "search"/"replace"/"splice" act only on text files. Editing with no active workspace auto-creates one.',
	'',
	'Example — write a file:',
	JSON.stringify(WORKSPACE_TOOL_EXAMPLE),
].join('\n')

/**
 * The name {@link import('./factories.js').createDescribeTool} advertises by default — the key a
 * model calls and the `ToolManagerInterface` (`@orkestrel/agent`) registers under.
 *
 * @remarks
 * Net-new: pairs with the other three tools' lean {@link AGENT_TOOL_SUMMARY} /
 * {@link WORKFLOW_TOOL_SUMMARY} / {@link WORKSPACE_TOOL_SUMMARY} — a model that reads only the
 * advertised summary can call `describe` with that tool's registered name to get its full
 * teaching description back.
 */
export const DESCRIBE_TOOL_NAME = 'describe'

/**
 * The lean {@link import('@orkestrel/agent').ToolInterface.summary} {@link import('./factories.js').createDescribeTool}
 * advertises — this tool needs no teaching of its own, so its summary and description are both
 * short.
 */
export const DESCRIBE_TOOL_SUMMARY = 'Return the full description of a named registered tool.'

/**
 * The DESCRIPTION {@link import('./factories.js').createDescribeTool} advertises.
 *
 * @remarks
 * Deliberately short — unlike the workflow / workspace / agent tools, this one has no authoring
 * schema or multi-step protocol to teach.
 */
export const DESCRIBE_TOOL_DESCRIPTION =
	'Return the full description of a registered tool by its name. Required: name - the registered tool name (see another tool listing for available names).'

/**
 * The name {@link import('./factories.js').createPromptTool} advertises by default — the key a
 * model calls and the `ToolManagerInterface` (`@orkestrel/agent`) registers under.
 */
export const PROMPT_TOOL_NAME = 'ask'

/**
 * The lean {@link import('@orkestrel/agent').ToolInterface.summary} {@link import('./factories.js').createPromptTool}
 * advertises in place of {@link PROMPT_TOOL_DESCRIPTION} — a `ToolManagerInterface.definitions()`
 * (`@orkestrel/agent`) advertises `summary ?? description`, so this one-sentence text stands in
 * for the full teaching description; the full text stays retrievable via
 * {@link import('./factories.js').createDescribeTool}.
 */
export const PROMPT_TOOL_SUMMARY =
	"Ask another terminal a question and BLOCK until it answers; the call resolves with the answered value. Call describe('ask') for the required fields."

export const PROMPT_TOOL_DESCRIPTION = [
	'Ask another terminal a question and block until it answers. This call does not return until the addressed terminal answers, or the prompt fails.',
	'',
	'Required:',
	'  to      - the terminal name to ask.',
	'  form    - the prompt kind: one of "input", "password", "confirm", "select", "checkbox", "editor".',
	'  message - the question shown to the answering terminal.',
	'Optional:',
	'  options - form-specific options (e.g. choices for "select"/"checkbox").',
	'A cycle (two terminals asking each other) or an expired prompt fails the call with a typed error.',
	'Example:',
	JSON.stringify({ to: 'reviewer', form: 'confirm', message: 'Approve the release?' }),
].join('\n')

/**
 * The name {@link import('./factories.js').createAnswerTool} advertises by default — the key a
 * model calls and the `ToolManagerInterface` (`@orkestrel/agent`) registers under.
 */
export const ANSWER_TOOL_NAME = 'answer'

/**
 * The lean {@link import('@orkestrel/agent').ToolInterface.summary} {@link import('./factories.js').createAnswerTool}
 * advertises in place of {@link ANSWER_TOOL_DESCRIPTION} — a `ToolManagerInterface.definitions()`
 * (`@orkestrel/agent`) advertises `summary ?? description`, so this one-sentence text stands in
 * for the full teaching description; the full text stays retrievable via
 * {@link import('./factories.js').createDescribeTool}.
 */
export const ANSWER_TOOL_SUMMARY =
	"List prompts addressed to this terminal, or answer one by id. Call describe('answer') for the required fields."

export const ANSWER_TOOL_DESCRIPTION = [
	'List the prompts currently addressed to this terminal, or answer one of them by id. Every call is ONE operation, chosen by the "operation" field.',
	'',
	'Operations:',
	'- pending { "operation": "pending" } — list every prompt currently addressed to this terminal (id, form, message, options, time).',
	'- answer  { "operation": "answer", "id": "<prompt id>", "value": <answer value> } — answer the prompt with that id; "value" must match the prompt\'s form (a string for "input"/"password"/"editor", a boolean for "confirm", a choice for "select", an array of choices for "checkbox").',
	'Example — list pending prompts:',
	JSON.stringify({ operation: 'pending' }),
	'Example — answer one:',
	JSON.stringify({ operation: 'answer', id: 'abc123', value: true }),
].join('\n')

/**
 * The name the upcoming `createDatabaseTool` factory will advertise by default — the key a model
 * calls and the `ToolManagerInterface` (`@orkestrel/agent`) registers under.
 *
 * @remarks
 * SRC-1 of a 3-unit spine: this unit lands the persistence + schema foundation
 * ({@link import('./types.js').DatabaseDefinition}, {@link import('./types.js').DefinitionStoreInterface},
 * {@link import('./helpers.js').expandTables}); `createDatabaseTool` itself is built in a later unit.
 */
export const DATABASE_TOOL_NAME = 'database'

/**
 * The lean {@link import('@orkestrel/agent').ToolInterface.summary} the upcoming database tool
 * will advertise in place of {@link DATABASE_TOOL_DESCRIPTION}.
 */
export const DATABASE_TOOL_SUMMARY =
	"Create and query a database — one operation per call (create, tables, get, records, count, aggregate, add, set, update, remove, migrate, destroy), chosen by the 'operation' field. Call describe('database') for the full operation list, the criteria form, and the column DSL."

/**
 * The DESCRIPTION the upcoming database tool will advertise — a multi-line guide that teaches a
 * small model the operation list, the SERIALIZED criteria form, and the {@link import('./types.js').TableSpec}
 * column DSL.
 *
 * @remarks
 * The criteria form is deliberately SERIALIZED (never fluent) — every condition is a flat object
 * `{ column, operator, values, connector? }` where `values` is ALWAYS an array, even for a
 * single-value operator (`{ column: 'age', operator: 'from', values: [18] }`), so a small model
 * never has to chain method calls or guess whether a value is scalar or a list.
 */
export const DATABASE_TOOL_DESCRIPTION = [
	'Create and query a database. Every call is ONE operation, chosen by the "operation" field.',
	'',
	'Operations (each takes the fields listed):',
	'- create    { "operation": "create", "id": "<database id>", "tables": { "<table>": { "columns": { "<column>": "string" | "integer" | "number" | "boolean" | { "type": "string", "optional": true } } } } } — define a new database.',
	'- tables    { "operation": "tables", "id": "<database id>" } — list a database\'s table names.',
	'- get       { "operation": "get", "id": "<database id>", "table": "<table>", "key": "<row key>" } — fetch one row by its primary key.',
	'- records   { "operation": "records", "id": "<database id>", "table": "<table>", "criteria"?: <Criteria> } — list rows matching criteria.',
	'- count     { "operation": "count", "id": "<database id>", "table": "<table>", "criteria"?: <Criteria> } — count rows matching criteria.',
	'- aggregate { "operation": "aggregate", "id": "<database id>", "table": "<table>", "column": "<column>", "function": "count" | "sum" | "average" | "minimum" | "maximum", "criteria"?: <Criteria> } — compute an aggregate.',
	'- add       { "operation": "add", "id": "<database id>", "table": "<table>", "row": { ... } } — insert a row (fails on a duplicate key).',
	'- set       { "operation": "set", "id": "<database id>", "table": "<table>", "row": { ... } } — upsert a row.',
	'- update    { "operation": "update", "id": "<database id>", "table": "<table>", "key": "<row key>", "row": { ... } } — patch an existing row.',
	'- remove    { "operation": "remove", "id": "<database id>", "table": "<table>", "key": "<row key>" } — delete a row by key.',
	'- migrate   { "operation": "migrate", "id": "<database id>", "tables": { ... } } — replace the table layout in place.',
	'- destroy   { "operation": "destroy", "id": "<database id>" } — drop a database entirely.',
	'',
	'Criteria form — SERIALIZED, never fluent. A condition is a flat object; "values" is ALWAYS an array, even for one value:',
	'  { "conditions": [ { "column": "age", "operator": "from", "values": [18], "connector": "and" } ], "order"?: [...], "offset"?: 0, "limit"?: 100 }',
	'  operators: equals, not, above, below, from, to, between, like, glob, starts, ends, any, none, absent, present.',
	'  "connector" joins this condition to the next ("and" | "or"); omit on the last condition.',
	'',
	'Column DSL (used by "create"/"migrate" "tables"): a column is either a bare type string ("string" | "integer" | "number" | "boolean"), or { "type": "<type>", "optional": true } when the column may be absent from a row.',
	'Example — create a database:',
	JSON.stringify({
		operation: 'create',
		id: 'shop',
		tables: {
			products: {
				columns: { name: 'string', price: 'number', notes: { type: 'string', optional: true } },
			},
		},
	}),
	'Example — query with criteria:',
	JSON.stringify({
		operation: 'records',
		id: 'shop',
		table: 'products',
		criteria: { conditions: [{ column: 'price', operator: 'below', values: [50] }] },
	}),
].join('\n')

/** The default cap on rows a `records` / `remove` call returns (or acts on) when the caller omits `criteria.limit` — the upcoming database tool's default row ceiling. */
export const DATABASE_TOOL_LIMIT = 1000

/** The database tool's mutating operations — disabled by `DatabaseToolOptions.readonly`. */
export const DATABASE_TOOL_MUTATIONS = new Set([
	'create',
	'add',
	'set',
	'update',
	'remove',
	'migrate',
	'destroy',
])

/**
 * The name `createRelationTool` advertises by default — the key a model calls and the
 * `ToolManagerInterface` (`@orkestrel/agent`) registers under.
 */
export const RELATION_TOOL_NAME = 'relation'

/**
 * The lean {@link import('@orkestrel/agent').ToolInterface.summary} the relation tool advertises
 * in place of {@link RELATION_TOOL_DESCRIPTION}.
 */
export const RELATION_TOOL_SUMMARY =
	"Traverse and edit relationships between database rows — one operation per call (load, find, link, unlink, links), chosen by the 'operation' field. Call describe('relation') for the include-path syntax."

/**
 * The DESCRIPTION the relation tool advertises — a multi-line guide that teaches a small model
 * the operation list and the flat dot-path `include` syntax.
 *
 * @remarks
 * An include path is a FLAT dot-separated string (`'contacts.account'`), never a nested object —
 * the same small-model ergonomic lever the other tools in this package use for flat args.
 */
export const RELATION_TOOL_DESCRIPTION = [
	'Traverse and edit relationships between database rows. Every call is ONE operation, chosen by the "operation" field. "manager" is optional (omit it when only one relation manager is registered).',
	'',
	'Operations (each takes the fields listed):',
	'- load   { "operation": "load", "model": "<model>", "key": "<row key>", "include"?: ["<path>", ...] } — fetch one (or, with an array key, several) row(s) with related rows attached.',
	'- find   { "operation": "find", "model": "<model>", "include"?: ["<path>", ...], "limit"?: <n>, "offset"?: <n>, "sort"?: "<column>", "direction"?: "ascending"|"descending" } — list rows, each with related rows attached.',
	'- link   { "operation": "link", "model": "<model>", "key": "<row key>", "relation": "<relation>", "target": "<related row key>" } — connect two rows through a "through" relation.',
	'- unlink { "operation": "unlink", "model": "<model>", "key": "<row key>", "relation": "<relation>", "target": "<related row key>" } — disconnect two rows.',
	'- links  { "operation": "links", "model": "<model>", "key": "<row key>", "relation": "<relation>" } — list every key linked to a row through a "through" relation.',
	'',
	'"include" is a FLAT dot-path array (not nested objects) — each string names a chain of relations to attach, up to the configured depth cap. Example: "contacts.account" attaches each row\'s contacts, and each contact\'s account.',
	'Example — load a row with two levels of relations:',
	JSON.stringify({ operation: 'load', model: 'orders', key: '1', include: ['contacts.account'] }),
].join('\n')

/** The default cap on rows a `find` / `links` call returns when the caller omits `limit` — the relation tool's default row ceiling. */
export const RELATION_TOOL_LIMIT = 1000

/** The default cap on how many `include` path segments deep a `load` / `find` call may traverse — the relation tool's default include-depth ceiling. */
export const RELATION_TOOL_DEPTH = 3

/**
 * The name {@link import('./factories.js').createInferTool} advertises by default — the key a
 * model calls and the `ToolManagerInterface` (`@orkestrel/agent`) registers under.
 */
export const INFER_TOOL_NAME = 'infer'

/**
 * The lean {@link import('@orkestrel/agent').ToolInterface.summary} {@link import('./factories.js').createInferTool}
 * advertises in place of {@link INFER_TOOL_DESCRIPTION} — a `ToolManagerInterface.definitions()`
 * (`@orkestrel/agent`) advertises `summary ?? description`, so this one-sentence text stands in
 * for the full teaching description; the full text stays retrievable via
 * {@link import('./factories.js').createDescribeTool}.
 */
export const INFER_TOOL_SUMMARY =
	"Infer a JSON Schema (as advertised tool parameters) from one or more example values. Call describe('infer') for the required fields."

export const INFER_TOOL_DESCRIPTION = [
	'Infer a JSON Schema from example values, returned in the same shape a tool advertises its parameters.',
	'',
	'Required:',
	'  samples    - an array of at least one example value to infer the schema from.',
	'Optional:',
	'  format     - infer string formats (date-time, email, ...) from the samples. Defaults to false.',
	'  enum       - infer enum constraints from repeated literal values across the samples. Defaults to false.',
	'  candidates - values to check against the freshly inferred schema. When present, the result',
	'               is wrapped as { parameters, checks } instead of the bare parameters record, one',
	'               check per candidate (same index). Every check has the uniform shape',
	'               { index, valid, coercible, faults? }. `valid` is a STRICT verdict (no coercion)',
	'               — e.g. the number 7 is NOT valid against a string slot. `coercible` answers a',
	'               separate question: would the SAME value be accepted by an endpoint tool call,',
	"               whose enforcement NORMALIZES args (7 coerces to '7')? So 7 against a string slot",
	'               yields { valid: false, coercible: true, faults: [] } — a strict mismatch that',
	'               normalization would silently accept, so faults is EMPTY. `faults` only ever',
	'               populates for a non-coercible mismatch (a wrong type normalization cannot fix,',
	'               a missing required key, an out-of-enum value); checks never throw, regardless of',
	'               candidate shape.',
	'Example (no candidates):',
	`  in:  ${JSON.stringify({
		samples: [
			{ id: 1, name: 'Ada' },
			{ id: 2, name: 'Bob' },
		],
	})}`,
	`  out: ${JSON.stringify({
		type: 'object',
		properties: { id: { type: 'integer' }, name: { type: 'string' } },
		required: ['id', 'name'],
		additionalProperties: false,
	})}`,
	'Example (with candidates):',
	`  in:  ${JSON.stringify({
		samples: [{ id: 1, name: 'Ada' }],
		candidates: [
			{ id: 3, name: 'Cy' },
			{ id: 'x', name: 'Cy' },
			{ id: 1, name: 7 },
		],
	})}`,
	`  out: ${JSON.stringify({
		parameters: {
			type: 'object',
			properties: { id: { type: 'integer' }, name: { type: 'string' } },
			required: ['id', 'name'],
			additionalProperties: false,
		},
		checks: [
			{ index: 0, valid: true, coercible: true },
			{ index: 1, valid: false, coercible: false, faults: '<structured faults>' },
			{ index: 2, valid: false, coercible: true, faults: [] },
		],
	})}`,
].join('\n')
