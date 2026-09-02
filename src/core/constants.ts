import type { WorkflowDefinition } from '@orkestrel/workflow'
import type { WorkflowSteps, WorkspaceOperation } from './types.js'

// Toolbox constants — UPPER_SNAKE, `Object.freeze`d, every member exported.
// Toolbox owns the workflow tool's authoring text/examples/depth bound and the workspace tool's
// name/description. The current workflow text describes Toolbox's authoring layer over
// `@orkestrel/workflow`'s named-function and runner-owned persistence APIs; the workspace text
// describes the editing surface Toolbox composes over `@orkestrel/workspace`.

/**
 * Holds the name {@link import('./factories.js').createAgentTool} advertises by default — the key a
 * model calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under.
 */
export const AGENT_TOOL_NAME = 'agent'

/**
 * Holds the maximum nesting depth a delegation chain (agent tool → sub-agent → agent tool → …) may
 * reach — the bound {@link import('./factories.js').createAgentTool}'s depth/cycle guard
 * enforces.
 *
 * @remarks
 * Deliberately a SEPARATE constant from {@link MAX_WORKFLOW_CHAIN} (rather than the two guards
 * sharing one reference): the two guards bound DIFFERENT chains (workflow nesting vs. agent
 * delegation) that happen to share a value today, and keeping this bound decoupled means a
 * future change to one never silently shifts the other. Same numeric value by convention, not
 * by shared reference.
 */
export const AGENT_TOOL_DEPTH = 8

/**
 * Holds the lean {@link import('@orkestrel/tool').ToolInterface.summary} {@link import('./factories.js').createAgentTool}
 * advertises in place of {@link AGENT_TOOL_DESCRIPTION} — a `ToolManagerInterface.definitions()`
 * (`@orkestrel/tool`) advertises `summary ?? description`, so this one-sentence text stands in
 * for the full teaching description; the full text stays retrievable via
 * {@link import('./factories.js').createDescribeTool}.
 */
export const AGENT_TOOL_SUMMARY =
	"Delegate a task to a sub-agent and return its result; each call runs one sub-agent turn to completion. Call describe('agent') for the optional provider/tools/system overrides."

/**
 * Holds the description {@link import('./factories.js').createAgentTool} advertises — a short guide
 * covering the required task and optional provider, tools, and system overrides.
 */
export const AGENT_TOOL_DESCRIPTION = [
	'Delegate a task to a sub-agent and return its result. Every call runs ONE sub-agent turn to completion.',
	'',
	'Required:',
	'  task     - the instructions the sub-agent carries out.',
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
 * Holds the maximum nesting depth a workflow → agent → workflow chain may reach — the bound
 * {@link import('./factories.js').createAgentFunction} and
 * {@link import('./factories.js').createWorkflowTool}'s depth/cycle guards enforce.
 *
 * @remarks
 * Depth is zero-based and counts workflow tags after the root: the root plus eight nested
 * workflows is allowed, while a ninth nested workflow is rejected with this package's typed
 * `DEPTH` `ToolboxError`.
 */
export const MAX_WORKFLOW_CHAIN = 8

/**
 * Holds the name {@link import('./factories.js').createWorkflowTool} advertises by default — the key a
 * model calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under, and the name
 * {@link import('./factories.js').createAgentFunction} binds the depth/cycle-aware workflow tool
 * under onto a wrapped agent's `context.tools`.
 *
 * @remarks
 * The propagation seam's well-known key: when
 * `createAgentFunction`'s `runner` option is supplied, it adds a `createWorkflowTool`-built tool
 * under this name to the agent's `context.tools`, so it can author + run a NESTED workflow
 * (bounded by {@link MAX_WORKFLOW_CHAIN}).
 */
export const WORKFLOW_TOOL_NAME = 'workflow'

/**
 * Holds a complete FLAT authoring example — the PRIMARY way a small model authors a workflow through
 * {@link import('./factories.js').createWorkflowTool}: `{ name, steps: [{ name }] }`.
 *
 * @remarks
 * Each step becomes a one-task phase, in
 * order; a step's `name` is a REGISTERED behavior name (not a label) — the registry key its
 * task's `behavior` resolves against. The tool expands this
 * ({@link import('./helpers.js').expandSteps}) into a valid `WorkflowDefinition`
 * (`@orkestrel/workflow`). It is embedded VERBATIM in {@link WORKFLOW_TOOL_DESCRIPTION}.
 */
export const WORKFLOW_TOOL_FLAT_EXAMPLE: WorkflowSteps = Object.freeze({
	name: 'release',
	steps: Object.freeze([Object.freeze({ name: 'compile' }), Object.freeze({ name: 'publish' })]),
})

/**
 * Holds a minimal NESTED authoring example — the ADVANCED escape-hatch form a model may use instead of
 * the flat shape: a full `WorkflowDefinition` (`@orkestrel/workflow`).
 *
 * @remarks
 * The full four-level form, documented in
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
					behavior: 'compile',
				}),
			]),
		}),
	]),
})

/**
 * Holds the lean {@link import('@orkestrel/tool').ToolInterface.summary} {@link import('./factories.js').createWorkflowTool}
 * advertises in place of {@link WORKFLOW_TOOL_DESCRIPTION} — a `ToolManagerInterface.definitions()`
 * (`@orkestrel/tool`) advertises `summary ?? description`, so this one-sentence text stands in
 * for the full teaching description; the full text stays retrievable via
 * {@link import('./factories.js').createDescribeTool}.
 */
export const WORKFLOW_TOOL_SUMMARY =
	"Author and run a multi-phase workflow in one call — phases run in sequence, tasks within a phase run concurrently. Call describe('workflow') for the full authoring schema and examples."

/**
 * Holds the description {@link import('./factories.js').createWorkflowTool} advertises — the flat
 * authoring form, its worked example, and the advanced nested definition form.
 */
export const WORKFLOW_TOOL_DESCRIPTION = [
	'Author and run a workflow (phases run sequentially, the tasks within a phase run concurrently) in one call.',
	'',
	'SIMPLEST way — a flat list of steps. Each step runs one registered behavior; steps run one after another:',
	'  { "name": "<workflow name>", "steps": [ { "name": "<registered name>" }, ... ] }',
	'- a step\'s "name" is a REGISTERED behavior name (a registry key), NOT a human label.',
	'- every step name must exist in the host-supplied functions registry; an unknown name is rejected.',
	'- the top-level "name" is optional; when present it is also the workflow persistence id. Other ids are filled in for you.',
	'Example:',
	JSON.stringify(WORKFLOW_TOOL_FLAT_EXAMPLE),
	'',
	'ADVANCED — the full nested form, for multi-task phases or explicit ids. A workflow has phases; a phase has tasks; a task may have a "behavior" (a registered behavior name); omitting it creates a JSON-null no-op:',
	JSON.stringify(WORKFLOW_TOOL_NESTED_EXAMPLE),
	'In the nested form you may omit any "id"/"name" and they are filled in positionally; a provided one is kept.',
].join('\n')

/**
 * Holds the name {@link import('./factories.js').createWorkspaceTool} advertises by default — the key a
 * model calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under.
 */
export const WORKSPACE_TOOL_NAME = 'workspace'

/**
 * Holds a valid {@link import('./types.js').WorkspaceOperation} object — the canonical example embedded
 * VERBATIM in {@link WORKSPACE_TOOL_DESCRIPTION}.
 *
 * @remarks
 * A `'write'` op (the most common authoring
 * action): create or overwrite `notes.txt` with `hello`. Frozen so it cannot be mutated in
 * place.
 */
export const WORKSPACE_TOOL_EXAMPLE: WorkspaceOperation = Object.freeze({
	operation: 'write',
	path: 'notes.txt',
	content: 'hello',
})

/**
 * Holds the lean {@link import('@orkestrel/tool').ToolInterface.summary} {@link import('./factories.js').createWorkspaceTool}
 * advertises in place of {@link WORKSPACE_TOOL_DESCRIPTION} — a `ToolManagerInterface.definitions()`
 * (`@orkestrel/tool`) advertises `summary ?? description`, so this one-sentence text stands in
 * for the full teaching description; the full text stays retrievable via
 * {@link import('./factories.js').createDescribeTool}.
 */
export const WORKSPACE_TOOL_SUMMARY =
	"Read and edit files in a workspace — one operation per call (read, write, list, search, replace, splice, move, remove, plus workspace switching), chosen by the 'operation' field. Call describe('workspace') for the full operation list and fields."

/**
 * Holds the description {@link import('./factories.js').createWorkspaceTool} advertises — the
 * operation-keyed workspace protocol, all supported operations, and worked examples.
 *
 * @remarks
 * Mirrors {@link WORKFLOW_TOOL_DESCRIPTION}'s teaching style and embeds
 * {@link WORKSPACE_TOOL_EXAMPLE} verbatim.
 */
export const WORKSPACE_TOOL_DESCRIPTION = [
	'Read and edit files in a workspace. Every call is ONE operation, chosen by the "operation" field.',
	'All file operations act on the ACTIVE workspace; use "workspaces" then "switch" to move between workspaces.',
	'',
	'Operations (each takes the fields listed):',
	'- read     { "operation": "read", "path": "<file>" } — return the file\'s text.',
	'- list     { "operation": "list" } — list every file in the active workspace (path, state, size, lines, kind).',
	'- has      { "operation": "has", "path": "<file>" } — whether the file exists.',
	'- search   { "operation": "search", "query": "<text>", "regex"?: bool, "sensitive"?: bool, "limit"?: int } — find lines matching the query across all files.',
	'- replace  { "operation": "replace", "query": "<text>", "replacement": "<text>", "regex"?: bool, "sensitive"?: bool, "limit"?: int } — replace matches across all files.',
	'- write    { "operation": "write", "path": "<file>", "content": "<text>" } — create or overwrite the whole file.',
	'- splice   { "operation": "splice", "path": "<file>", "content": "<text>", "fromLine": int, "fromColumn": int, "toLine": int, "toColumn": int } — replace a 1-based range (from inclusive, to exclusive) with content.',
	'- prepend  { "operation": "prepend", "path": "<file>", "content": "<text>" } — add content to the start of the file.',
	'- append   { "operation": "append", "path": "<file>", "content": "<text>" } — add content to the end of the file.',
	'- move     { "operation": "move", "from": "<file>", "to": "<file>" } — rename / move a file.',
	'- remove   { "operation": "remove", "path": "<file>" } — delete a file.',
	'- workspaces { "operation": "workspaces" } — list the workspaces you can switch between (each id, file count, active).',
	'- switch   { "operation": "switch", "id": "<id>" } — make the workspace with that id active (ids come from "workspaces").',
	'',
	'Notes: lines and columns are 1-based (column 1 is the first character). "regex" defaults to false (a literal substring), "sensitive" defaults to true (case-sensitive). "search"/"replace"/"splice" act only on text files. Editing with no active workspace auto-creates one.',
	'',
	'Example — write a file:',
	JSON.stringify(WORKSPACE_TOOL_EXAMPLE),
].join('\n')

/**
 * Holds the name {@link import('./factories.js').createDescribeTool} advertises by default — the key a
 * model calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under.
 *
 * @remarks
 * Net-new: pairs with the other three tools' lean {@link AGENT_TOOL_SUMMARY} /
 * {@link WORKFLOW_TOOL_SUMMARY} / {@link WORKSPACE_TOOL_SUMMARY} — a model that reads only the
 * advertised summary can call `describe` with that tool's registered name to get its full
 * teaching description back.
 */
export const DESCRIBE_TOOL_NAME = 'describe'

/**
 * Holds the lean {@link import('@orkestrel/tool').ToolInterface.summary} {@link import('./factories.js').createDescribeTool}
 * advertises — this tool needs no teaching of its own, so its summary and description are both
 * short.
 */
export const DESCRIBE_TOOL_SUMMARY = 'Return the full description of a named registered tool.'

/**
 * Holds the DESCRIPTION {@link import('./factories.js').createDescribeTool} advertises.
 *
 * @remarks
 * Deliberately short — unlike the workflow / workspace / agent tools, this one has no authoring
 * schema or multi-step protocol to teach.
 */
export const DESCRIBE_TOOL_DESCRIPTION =
	'Return the full description of a registered tool by its name. Required: name - the registered tool name (see another tool listing for available names).'

/**
 * Holds the name {@link import('./factories.js').createPromptTool} advertises by default — the key a
 * model calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under.
 */
export const PROMPT_TOOL_NAME = 'ask'

/**
 * Holds the lean {@link import('@orkestrel/tool').ToolInterface.summary} {@link import('./factories.js').createPromptTool}
 * advertises in place of {@link PROMPT_TOOL_DESCRIPTION} — a `ToolManagerInterface.definitions()`
 * (`@orkestrel/tool`) advertises `summary ?? description`, so this one-sentence text stands in
 * for the full teaching description; the full text stays retrievable via
 * {@link import('./factories.js').createDescribeTool}.
 */
export const PROMPT_TOOL_SUMMARY =
	"Ask another terminal a multi-field form and BLOCK until it answers; the call resolves with the values record. Call describe('ask') for the schema."

/** Holds the full form protocol {@link import('./factories.js').createPromptTool} advertises. */
export const PROMPT_TOOL_DESCRIPTION = [
	'Ask another terminal a multi-field form and block until it answers. This call does not return until the addressed terminal answers, or the form expires.',
	'',
	'Required:',
	'  to     - the terminal name to ask.',
	'  schema - an @orkestrel/form schema: each field declares `control` and `name`, plus optional `label`, `rule`, `default`, and `choices`; `fields` is an ordered array and each `name` must be unique.',
	'The result is one values object keyed by those field names. A cycle or expired form fails with a typed error.',
	'Example:',
	JSON.stringify({
		to: 'reviewer',
		schema: {
			label: 'Release review',
			fields: [
				{ control: 'confirm', name: 'approved', label: 'Approve the release?' },
				{ control: 'editor', name: 'notes', label: 'Review notes' },
			],
		},
	}),
].join('\n')

/**
 * Holds the name {@link import('./factories.js').createAnswerTool} advertises by default — the key a
 * model calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under.
 */
export const ANSWER_TOOL_NAME = 'answer'

/**
 * Holds the lean {@link import('@orkestrel/tool').ToolInterface.summary} {@link import('./factories.js').createAnswerTool}
 * advertises in place of {@link ANSWER_TOOL_DESCRIPTION} — a `ToolManagerInterface.definitions()`
 * (`@orkestrel/tool`) advertises `summary ?? description`, so this one-sentence text stands in
 * for the full teaching description; the full text stays retrievable via
 * {@link import('./factories.js').createDescribeTool}.
 */
export const ANSWER_TOOL_SUMMARY =
	"List forms addressed to this terminal, or answer one by id with a values record. Call describe('answer') for the required fields."

/** Holds the pending/answer protocol {@link import('./factories.js').createAnswerTool} advertises. */
export const ANSWER_TOOL_DESCRIPTION = [
	'List the forms currently addressed to this terminal, or answer one of them by id. Every call is ONE operation, chosen by the "operation" field.',
	'',
	'Operations:',
	'- pending { "operation": "pending" } — list every form currently addressed to this terminal (id, from, schema).',
	'- answer  { "operation": "answer", "id": "<form id>", "values": { "<field name>": <field value> } } — answer every required field with the value its control accepts.',
	'Example — list pending forms:',
	JSON.stringify({ operation: 'pending' }),
	'Example — answer one:',
	JSON.stringify({ operation: 'answer', id: 'abc123', values: { approved: true, notes: 'Ready' } }),
].join('\n')

/**
 * Holds the name the upcoming `createDatabaseTool` factory will advertise by default — the key a model
 * calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under.
 *
 * @remarks
 * SRC-1 of a 3-unit spine: this unit lands the persistence + schema foundation
 * ({@link import('./types.js').DatabaseDefinition}, {@link import('./types.js').DefinitionStoreInterface},
 * {@link import('./compilers.js').expandTables}); `createDatabaseTool` itself is built in a later unit.
 */
export const DATABASE_TOOL_NAME = 'database'

/**
 * Holds the lean {@link import('@orkestrel/tool').ToolInterface.summary} the upcoming database tool
 * will advertise in place of {@link DATABASE_TOOL_DESCRIPTION}.
 */
export const DATABASE_TOOL_SUMMARY =
	"Create and query a database — one operation per call (create, tables, get, records, count, aggregate, add, set, update, remove, destroy), chosen by the 'operation' field. Call describe('database') for the full operation list, the query form, and the column DSL."

/**
 * Holds the DESCRIPTION the upcoming database tool will advertise — a multi-line guide that teaches a
 * small model the operation list, the SERIALIZED query form, and the {@link import('./types.js').TableSpec}
 * column DSL.
 *
 * @remarks
 * The query form is deliberately SERIALIZED (never fluent) — every condition is a flat object
 * `{ column, operator, values, connector? }` where `values` is ALWAYS an array, even for a
 * single-value operator (`{ column: 'age', operator: 'from', values: [18] }`), so a small model
 * never has to chain method calls or guess whether a value is scalar or a list.
 */
export const DATABASE_TOOL_DESCRIPTION = [
	'Create and query a database. Every call is ONE operation, chosen by the "operation" field.',
	'',
	'Operations (each takes the fields listed):',
	'- create    { "operation": "create", "id": "<database id>", "tables": { "<table>": { "columns": { "<column>": "string" | "integer" | "number" | "boolean" | { "type": "string", "optional": true } } } }, "primary"?: { "<table>": "<column>" }, "indexes"?: { "<table>": [["<column>"]] }, "version"?: <number> } — define a new database.',
	'- tables    { "operation": "tables", "id": "<database id>" } — list a database\'s table names.',
	'- get       { "operation": "get", "id": "<database id>", "table": "<table>", "key": "<row key>" } — fetch one row by its primary key.',
	'- records   { "operation": "records", "id": "<database id>", "table": "<table>", "query"?: <Query> } — list rows matching a query.',
	'- count     { "operation": "count", "id": "<database id>", "table": "<table>", "query"?: <Query> } — count rows matching a query.',
	'- aggregate { "operation": "aggregate", "id": "<database id>", "table": "<table>", "column": "<column>", "function": "count" | "sum" | "average" | "minimum" | "maximum", "query"?: <Query> } — compute an aggregate.',
	'- add       { "operation": "add", "id": "<database id>", "table": "<table>", "row": { ... } } — insert a row (fails on a duplicate key).',
	'- set       { "operation": "set", "id": "<database id>", "table": "<table>", "row": { ... } } — upsert a row.',
	'- update    { "operation": "update", "id": "<database id>", "table": "<table>", "key": "<row key>", "changes": { ... } } — patch an existing row.',
	'- remove    { "operation": "remove", "id": "<database id>", "table": "<table>", "key": "<row key>" } — delete a row by key.',
	'- destroy   { "operation": "destroy", "id": "<database id>" } — drop a database entirely.',
	'',
	'Query form — SERIALIZED, never fluent. A condition is a flat object; "values" is ALWAYS an array, even for one value:',
	'  { "conditions": [ { "column": "age", "operator": "from", "values": [18], "connector": "and" } ], "order"?: [...], "offset"?: 0, "limit"?: 100 }',
	'  operators: equals, not, above, below, from, to, between, like, glob, starts, ends, any, none, absent, present.',
	'  "connector" joins this condition to the next ("and" | "or"); omit on the last condition.',
	'',
	'Column DSL (used by "create" "tables"): a column is either a bare type string ("string" | "integer" | "number" | "boolean"), or { "type": "<type>", "optional": true } when the column may be absent from a row.',
	'Schema configuration is creation-time only. Evolve a schema by opening a newly configured target-version database over a versioned persistent driver; reconciliation requires paired metadata/stamp capabilities.',
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
	'Example — query records:',
	JSON.stringify({
		operation: 'records',
		id: 'shop',
		table: 'products',
		query: { conditions: [{ column: 'price', operator: 'below', values: [50] }] },
	}),
].join('\n')

/** Holds the default cap on rows a `records` call returns when the caller omits `query.limit` — the upcoming database tool's default row ceiling. */
export const DATABASE_TOOL_LIMIT = 1000

/** Lists the runtime-frozen database-tool mutation names disabled by `DatabaseToolOptions.readonly`. */
export const DATABASE_TOOL_MUTATIONS: readonly string[] = Object.freeze([
	'create',
	'add',
	'set',
	'update',
	'remove',
	'destroy',
])

/**
 * Holds the name `createRelationTool` advertises by default — the key a model calls and the
 * `ToolManagerInterface` (`@orkestrel/tool`) registers under.
 */
export const RELATION_TOOL_NAME = 'relation'

/**
 * Holds the lean {@link import('@orkestrel/tool').ToolInterface.summary} the relation tool advertises
 * in place of {@link RELATION_TOOL_DESCRIPTION}.
 */
export const RELATION_TOOL_SUMMARY =
	"Traverse and edit relationships between database rows — one operation per call (load, find, link, unlink, links), chosen by the 'operation' field. Call describe('relation') for the include-path syntax."

/**
 * Holds the DESCRIPTION the relation tool advertises — a multi-line guide that teaches a small model
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

/** Holds the default cap on rows a `find` / `links` call returns when the caller omits `limit` — the relation tool's default row ceiling. */
export const RELATION_TOOL_LIMIT = 1000

/** Holds the default cap on how many `include` path segments deep a `load` / `find` call may traverse — the relation tool's default include-depth ceiling. */
export const RELATION_TOOL_DEPTH = 3

/**
 * Holds the name {@link import('./factories.js').createInferTool} advertises by default — the key a
 * model calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under.
 */
export const INFER_TOOL_NAME = 'infer'

/**
 * Holds the lean {@link import('@orkestrel/tool').ToolInterface.summary} {@link import('./factories.js').createInferTool}
 * advertises in place of {@link INFER_TOOL_DESCRIPTION} — a `ToolManagerInterface.definitions()`
 * (`@orkestrel/tool`) advertises `summary ?? description`, so this one-sentence text stands in
 * for the full teaching description; the full text stays retrievable via
 * {@link import('./factories.js').createDescribeTool}.
 */
export const INFER_TOOL_SUMMARY =
	"Infer a JSON Schema (as advertised tool parameters) from one or more example values. Call describe('infer') for the required fields."

/** Holds the schema-inference protocol {@link import('./factories.js').createInferTool} advertises. */
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
