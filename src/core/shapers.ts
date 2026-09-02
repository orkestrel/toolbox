import {
	arrayShape,
	booleanShape,
	integerShape,
	jsonShape,
	literalShape,
	numberShape,
	objectShape,
	optionalShape,
	recordShape,
	stringShape,
	unionShape,
} from '@orkestrel/contract'
import { MAX_TIMER_MS } from '@orkestrel/workflow'

// === Prompt / answer shapes (createPromptTool / createAnswerTool call args)

/**
 * Describes the shape of {@link import('./factories.js').createPromptTool}'s call arguments — `to` names the
 * terminal identity and `schema` carries the complete multi-field form document.
 *
 * @remarks
 * The contract first requires exact JSON. The handler then delegates schema parsing and semantic
 * validation to `@orkestrel/form`'s `parseForm`, so Toolbox does not duplicate the form schema.
 */
export const promptToolShape = objectShape({
	to: stringShape({ min: 1, description: 'The terminal identity to address the form to.' }),
	schema: jsonShape({
		description:
			'The @orkestrel/form schema to ask, with form metadata and one or more typed fields.',
	}),
})

/**
 * Describes the shape of {@link import('./factories.js').createAnswerTool}'s call arguments — discriminated
 * by `operation`: `'pending'` lists the forms addressed to this tool's terminal, while `'answer'`
 * resolves one by `id` with a complete `values` record.
 *
 * @remarks
 * `values` is first bounded to exact JSON. The handler then narrows it with the originating Form
 * package's `isFormValues` guard before the terminal manager applies it to the parked live form.
 */
export const answerToolShape = unionShape(
	objectShape({
		operation: literalShape(['pending'], {
			description: 'List the forms currently addressed to this terminal.',
		}),
	}),
	objectShape({
		operation: literalShape(['answer'], { description: 'Answer one pending form by id.' }),
		id: stringShape({ min: 1, description: 'The id of the pending form to answer.' }),
		values: jsonShape({ description: 'The form answers keyed by field name.' }),
	}),
)

// Toolbox shapes — the shape VALUE each `create*Tool` factory (factories.ts) compiles into
// the lockstep guard + parser + JSON Schema outputs. `agentToolShape` MUST agree
// with the hand-written `AgentToolArguments` (types.ts), which is the source of truth.
// `workflowStepsShape` / `workflowDraftShape` are Toolbox's authoring boundary over the current
// `@orkestrel/workflow` definition contract. `workspaceToolShape` is Toolbox's operation boundary
// over the editing primitives now owned by `@orkestrel/workspace`.

/**
 * Describes the shape of {@link import('./types.js').AgentToolArguments} —
 * {@link import('./factories.js').createAgentTool}'s advertised `parameters`.
 *
 * @remarks
 * `task` is the only required field (a non-empty string); `provider` / `tools` / `system`
 * are per-call overrides of the tool's own configured defaults.
 */
export const agentToolShape = objectShape({
	task: stringShape({
		min: 1,
		description: 'The instructions the sub-agent carries out.',
	}),
	provider: optionalShape(
		stringShape({
			min: 1,
			description:
				'Registry key of the provider to run the sub-agent against (overrides the default).',
		}),
	),
	tools: optionalShape(
		arrayShape(stringShape({ min: 1 }), {
			description:
				'Registry keys of the tools loaded into the sub-agent (replaces the default list).',
		}),
	),
	system: optionalShape(
		stringShape({
			description: "A system prompt seeding the sub-agent's context (overrides the default).",
		}),
	),
})

/**
 * Describes the shape of {@link import('./types.js').DescribeToolArguments} —
 * {@link import('./factories.js').createDescribeTool}'s advertised `parameters`.
 *
 * @remarks
 * `name` is the only field (a non-empty string) — the registered tool name to look up.
 */
export const describeToolShape = objectShape({
	name: stringShape({
		min: 1,
		description: 'The registered name of the tool whose full description to return.',
	}),
})

// === Workflow draft / flat-steps shapes

/**
 * Describes the shape of a {@link import('./types.js').TaskDraft} — identical to a strict task shape
 * EXCEPT `id` and `name` are OPTIONAL.
 */
export const taskDraftShape = objectShape({
	id: optionalShape(stringShape({ min: 1, description: 'Task id; auto-filled when omitted.' })),
	name: optionalShape(
		stringShape({ min: 1, description: 'Task name; defaults to the id when omitted.' }),
	),
	description: optionalShape(stringShape({ description: 'Optional task description.' })),
	behavior: optionalShape(
		stringShape({
			min: 1,
			description:
				'The registered behavior name to invoke (a registry key, not a label); omitted completes with JSON null.',
		}),
	),
	retries: optionalShape(
		integerShape({
			min: 0,
			description:
				'Extra attempts after the first on failure; overrides the phase default. Omitted means none.',
		}),
	),
	timeout: optionalShape(
		integerShape({
			min: 0,
			max: MAX_TIMER_MS,
			description:
				'Persisted per-attempt deadline in milliseconds (0 disables it); omitted means no deadline.',
		}),
	),
})

/**
 * Describes the shape of a PHASE in a draft workflow — identical to a strict phase shape EXCEPT `id` and
 * `name` are OPTIONAL, and its tasks are {@link taskDraftShape}s.
 */
export const phaseDraftShape = objectShape({
	id: optionalShape(stringShape({ min: 1, description: 'Phase id; auto-filled when omitted.' })),
	name: optionalShape(
		stringShape({ min: 1, description: 'Phase name; defaults to the id when omitted.' }),
	),
	description: optionalShape(stringShape({ description: 'Optional phase description.' })),
	tasks: arrayShape(taskDraftShape, { description: 'The phase tasks; they run CONCURRENTLY.' }),
	concurrency: optionalShape(
		integerShape({
			min: 1,
			description: 'Max tasks in flight at once (a resource throttle); omitted means unbounded.',
		}),
	),
	bail: optionalShape(
		literalShape([true, false], {
			description: 'Per-phase failure-policy override; omitted inherits the workflow bail.',
		}),
	),
})

/**
 * Describes the shape of a DRAFT workflow — identical to a strict workflow shape EXCEPT `id` and `name`
 * are OPTIONAL at all three levels (workflow / phase / task), so a small model can omit the six
 * identity strings and let the tool synthesize them positionally.
 *
 * @remarks
 * The lenient counterpart {@link import('./factories.js').createWorkflowDraftContract} compiles.
 * `behavior` stays optional like the strict form; omission is the deliberate JSON `null` no-op. A
 * provided `id` / `name` still has `minLength: 1` (so
 * an explicitly-empty `id: ''` is REJECTED, not auto-filled). After
 * {@link import('./helpers.js').completeDraft} fills the missing ids/names, the result is
 * validated against the STRICT `createWorkflowContract` (`@orkestrel/workflow`) gate before
 * running.
 */
export const workflowDraftShape = objectShape({
	id: optionalShape(stringShape({ min: 1, description: 'Workflow id; auto-filled when omitted.' })),
	name: optionalShape(
		stringShape({ min: 1, description: 'Workflow name; defaults to the id when omitted.' }),
	),
	description: optionalShape(stringShape({ description: 'Optional workflow description.' })),
	phases: arrayShape(phaseDraftShape, {
		description: 'The workflow phases; they run SEQUENTIALLY, in order.',
	}),
	bail: optionalShape(
		literalShape([true, false], {
			description:
				'Failure policy: false (default) continues gracefully, true halts on the first failure.',
		}),
	),
})

/**
 * Describes the shape of ONE flat step — `{ name }` — the building block of {@link workflowStepsShape}.
 *
 * @remarks
 * `name` is the REGISTERED behavior name the step runs (it becomes the task's `behavior`). The tool
 * expands each step into a one-task phase, in order ({@link import('./helpers.js').expandSteps}).
 */
export const stepShape = objectShape({
	name: stringShape({
		min: 1,
		description: 'The registered behavior name this step runs (becomes the task behavior).',
	}),
})

/**
 * Describes the FLAT authoring shape {@link import('./factories.js').createWorkflowTool} advertises as its
 * `parameters` — the simplest surface a small model can fill: `{ name?, steps: [{ name }] }`.
 *
 * @remarks
 * A deliberately-reduced surface: a flat ordered list of steps, each a `{ name }`. The tool
 * EXPANDS it ({@link import('./helpers.js').expandSteps}) into a full
 * {@link import('./types.js').WorkflowDefinition} — one one-task phase per step, in order —
 * then validates against the STRICT `createWorkflowContract` (`@orkestrel/workflow`) gate. The
 * full nested form is STILL accepted by the tool (it branches on the args' shape) and is
 * documented as the advanced escape-hatch in the tool's description — but THIS is what
 * `parameters` advertises.
 */
export const workflowStepsShape = objectShape({
	name: optionalShape(stringShape({ min: 1, description: 'Optional workflow name.' })),
	steps: arrayShape(stepShape, {
		description: 'The ordered steps to run, one after another (each becomes a one-task phase).',
	}),
})

// === Workspace operation shape

/**
 * Describes the shape of a {@link import('./types.js').WorkspaceOperation} — a descriptive tagged union
 * over the workspace edit, read, and navigation operations, discriminated by the `operation`
 * literal (never a bare `kind`). Each variant leads with its `operation`
 * discriminant then its FLAT fields, every field via `stringShape` / `optionalShape` /
 * `integerShape({ min: 1 })` / `booleanShape`, each carrying a strong field-level `description`.
 *
 * @remarks
 * The union compiles to an `anyOf` JSON Schema + a `unionOf` guard + a first-match parser
 * automatically ({@link import('./factories.js').createWorkspaceTool} types the result to the
 * hand-written {@link import('./types.js').WorkspaceOperation}). `limit` and the four `'splice'`
 * caret components are POSITIVE integers (`integerShape({ min: 1 })`); `regex` / `sensitive`
 * are `optionalShape(booleanShape(...))`. The two REGISTRY arms — `workspaces` (list the
 * workspaces the model can move between) and `switch` (re-point the active one by `id`) — let a
 * model DISCOVER then CHOOSE which workspace the edit / read arms target.
 */
export const workspaceToolShape = unionShape(
	objectShape({
		operation: literalShape(['read'], { description: "Read a whole text file's text by path." }),
		path: stringShape({ description: 'The path of the file to read.' }),
	}),
	objectShape({
		operation: literalShape(['list'], { description: 'List every file in the workspace.' }),
	}),
	objectShape({
		operation: literalShape(['has'], { description: 'Check whether a file exists at the path.' }),
		path: stringShape({ description: 'The path to check for.' }),
	}),
	objectShape({
		operation: literalShape(['search'], {
			description: 'Search every text file for a query, returning each hit.',
		}),
		query: stringShape({ description: 'The text (or regular-expression source) to search for.' }),
		regex: optionalShape(
			booleanShape({
				description:
					'Treat the query as a regular expression. Defaults to false (a literal substring).',
			}),
		),
		sensitive: optionalShape(
			booleanShape({
				description: 'Match case-sensitively. Defaults to true (set false for case-insensitive).',
			}),
		),
		limit: optionalShape(
			integerShape({
				min: 1,
				description: 'Stop after this many matches across all files. Omitted means unlimited.',
			}),
		),
	}),
	objectShape({
		operation: literalShape(['replace'], {
			description: 'Replace a query with a replacement across every text file.',
		}),
		query: stringShape({ description: 'The text (or regular-expression source) to replace.' }),
		replacement: stringShape({ description: 'The text to substitute for each match.' }),
		regex: optionalShape(
			booleanShape({
				description:
					'Treat the query as a regular expression. Defaults to false (a literal substring).',
			}),
		),
		sensitive: optionalShape(
			booleanShape({
				description: 'Match case-sensitively. Defaults to true (set false for case-insensitive).',
			}),
		),
		limit: optionalShape(
			integerShape({
				min: 1,
				description: 'Stop after this many replacements across all files. Omitted means unlimited.',
			}),
		),
	}),
	objectShape({
		operation: literalShape(['write'], {
			description: 'Create or overwrite a whole file with content.',
		}),
		path: stringShape({ description: 'The path of the file to write.' }),
		content: stringShape({ description: 'The full new contents of the file.' }),
	}),
	objectShape({
		operation: literalShape(['splice'], {
			description:
				'Replace a 1-based range of an existing text file (from inclusive, to exclusive) with content.',
		}),
		path: stringShape({ description: 'The path of the text file to edit.' }),
		content: stringShape({ description: 'The text to splice in place of the range.' }),
		fromLine: integerShape({
			min: 1,
			description: 'The 1-based start line of the range (inclusive).',
		}),
		fromColumn: integerShape({
			min: 1,
			description:
				'The 1-based start column of the range (inclusive; column 1 is the first character).',
		}),
		toLine: integerShape({ min: 1, description: 'The 1-based end line of the range (exclusive).' }),
		toColumn: integerShape({
			min: 1,
			description: 'The 1-based end column of the range (exclusive).',
		}),
	}),
	objectShape({
		operation: literalShape(['prepend'], {
			description: 'Add content to the start of a file (creating it when absent).',
		}),
		path: stringShape({ description: 'The path of the file to prepend to.' }),
		content: stringShape({ description: 'The text to add at the start of the file.' }),
	}),
	objectShape({
		operation: literalShape(['append'], {
			description: 'Add content to the end of a file (creating it when absent).',
		}),
		path: stringShape({ description: 'The path of the file to append to.' }),
		content: stringShape({ description: 'The text to add at the end of the file.' }),
	}),
	objectShape({
		operation: literalShape(['move'], {
			description: 'Rename or move a file (overwriting an occupied target).',
		}),
		from: stringShape({ description: 'The current path of the file.' }),
		to: stringShape({ description: 'The new path for the file.' }),
	}),
	objectShape({
		operation: literalShape(['remove'], { description: 'Delete a file from the workspace.' }),
		path: stringShape({ description: 'The path of the file to remove.' }),
	}),
	objectShape({
		operation: literalShape(['workspaces'], {
			description:
				'List the workspaces you can move between (each id, file count, and whether it is active), so you can pick an id to switch to.',
		}),
	}),
	objectShape({
		operation: literalShape(['switch'], {
			description:
				'Switch the active workspace to the one with this id (get ids from the "workspaces" operation). Edit and read operations then target it.',
		}),
		id: stringShape({
			description: 'The id of the workspace to make active (from the "workspaces" listing).',
		}),
	}),
)

// === Database tool shape (SRC-2 — the tool factory itself; SRC-1 landed the persistence + the
// TableSpec DSL this shape's `tables` field compiles the SAME way `expandTables` does)

/** Describes a {@link import('./types.js').ColumnKind} literal — the leaf {@link columnSpecShape} wraps. */
export const columnKindShape = literalShape(['string', 'integer', 'number', 'boolean'], {
	description: 'A column type: "string" | "integer" | "number" | "boolean".',
})

/** Describes a {@link import('./types.js').ColumnSpec} — a bare {@link columnKindShape}, or `{ type, optional }`. */
export const columnSpecShape = unionShape(
	columnKindShape,
	objectShape({
		type: columnKindShape,
		optional: optionalShape(
			booleanShape({ description: 'Whether the column may be absent from a row.' }),
		),
	}),
)

/** Describes a {@link import('./types.js').TableSpec} — table name to `{ columns }`, each column a {@link columnSpecShape}. */
export const tableSpecShape = recordShape(
	objectShape({
		columns: recordShape(columnSpecShape, { description: 'Column name to its type.' }),
	}),
	{ description: 'Table name to its column layout.' },
)

/** Describes one key value — a string or number; the array form (multiple keys, positional) resolves FIRST, so an array argument is read as many keys rather than one. */
export const keyShape = unionShape(
	arrayShape(unionShape(stringShape(), numberShape()), {
		description: 'Multiple row keys, positional — a miss at an index is undefined there.',
	}),
	stringShape({ description: 'One row key.' }),
	numberShape({ description: 'One row key.' }),
)

/** Describes a loose row — a flat object of column name to JSON value; the array form (multiple rows) resolves FIRST, so an array argument is read as many rows rather than one. */
export const rowShape = recordShape(jsonShape(), {
	description: 'A row as a flat object of column name to value.',
})

/** Describes one or many loose rows — the array form resolves FIRST, so an array argument is read as many rows rather than one. */
export const rowsShape = unionShape(
	arrayShape(rowShape, { description: 'Multiple rows.' }),
	rowShape,
)

/** Describes one SERIALIZED WHERE condition — `values` is ALWAYS an array, even for a single-value operator. */
export const conditionShape = objectShape({
	column: stringShape({ description: 'The column this condition applies to.' }),
	operator: literalShape(
		[
			'equals',
			'not',
			'above',
			'below',
			'from',
			'to',
			'between',
			'like',
			'glob',
			'starts',
			'ends',
			'any',
			'none',
			'absent',
			'present',
		],
		{ description: 'The comparison operator.' },
	),
	values: arrayShape(jsonShape(), {
		description: 'The operand values the operator needs (always an array, even for one value).',
	}),
	connector: optionalShape(
		literalShape(['and', 'or'], {
			description: 'Joins this condition to the next; omit on the last condition.',
		}),
	),
})

/** Describes one sort term. */
export const orderShape = objectShape({
	column: stringShape({ description: 'The column to sort by.' }),
	direction: literalShape(['ascending', 'descending'], { description: 'The sort direction.' }),
})

/** Describes the SERIALIZED query form — conditions, order, and pagination. */
export const queryShape = objectShape({
	conditions: optionalShape(
		arrayShape(conditionShape, { description: 'The WHERE conditions, folded left to right.' }),
	),
	order: optionalShape(
		arrayShape(orderShape, { description: 'The sort terms, applied in order.' }),
	),
	limit: optionalShape(integerShape({ min: 0, description: 'Max rows to return.' })),
	offset: optionalShape(integerShape({ min: 0, description: 'Rows to skip before returning.' })),
})

/**
 * Describes the shape of {@link import('./factories.js').createDatabaseTool}'s call arguments —
 * discriminated by `operation` into the 11 database operations (`'create'` / `'tables'` /
 * `'get'` / `'records'` / `'count'` / `'aggregate'` / `'add'` / `'set'` / `'update'` /
 * `'remove'` / `'destroy'`).
 *
 * @remarks
 * Every arm carries `id` (the database id). `'create'` carries `tables` (the
 * {@link import('./types.js').TableSpec} column DSL, compiled via
 * {@link import('./compilers.js').expandTables}); `'get'` / `'update'` / `'remove'` carry `key`
 * (one key or an array of keys, positional); `'add'` / `'set'` carry `row` (one row or an array of
 * rows); `'update'` also carries `changes` (a loose partial row); `'records'` / `'count'` /
 * `'aggregate'` carry an optional `query` (the SERIALIZED form — `values` is ALWAYS an array,
 * even for a single-value operator, so a caller never chains method calls or guesses arity).
 */
export const databaseToolShape = unionShape(
	objectShape({
		operation: literalShape(['create'], { description: 'Define a new database.' }),
		id: stringShape({ min: 1, description: 'The database id.' }),
		tables: tableSpecShape,
		driver: optionalShape(
			stringShape({ min: 1, description: 'The registered driver key. Defaults to "memory".' }),
		),
		primary: optionalShape(
			recordShape(stringShape({ min: 1 }), {
				description: 'Table name to its primary-key column.',
			}),
		),
		indexes: optionalShape(
			recordShape(
				arrayShape(
					arrayShape(stringShape({ min: 1 }), {
						min: 1,
						description: 'One nonempty index group of column names.',
					}),
					{ description: 'Zero or more index groups declared for the table.' },
				),
				{ description: 'Table name to its index column groups.' },
			),
		),
		version: optionalShape(
			numberShape({ description: 'The schema version for open-time reconciliation.' }),
		),
	}),
	objectShape({
		operation: literalShape(['tables'], { description: "List a database's table names." }),
		id: stringShape({ min: 1, description: 'The database id.' }),
	}),
	objectShape({
		operation: literalShape(['get'], { description: 'Fetch one or more rows by primary key.' }),
		id: stringShape({ min: 1, description: 'The database id.' }),
		table: stringShape({ min: 1, description: 'The table name.' }),
		key: keyShape,
	}),
	objectShape({
		operation: literalShape(['records'], { description: 'List rows matching a query.' }),
		id: stringShape({ min: 1, description: 'The database id.' }),
		table: stringShape({ min: 1, description: 'The table name.' }),
		query: optionalShape(queryShape),
	}),
	objectShape({
		operation: literalShape(['count'], { description: 'Count rows matching a query.' }),
		id: stringShape({ min: 1, description: 'The database id.' }),
		table: stringShape({ min: 1, description: 'The table name.' }),
		query: optionalShape(queryShape),
	}),
	objectShape({
		operation: literalShape(['aggregate'], { description: 'Compute an aggregate over a column.' }),
		id: stringShape({ min: 1, description: 'The database id.' }),
		table: stringShape({ min: 1, description: 'The table name.' }),
		function: literalShape(['count', 'sum', 'average', 'minimum', 'maximum'], {
			description: 'The aggregate function.',
		}),
		column: stringShape({ min: 1, description: 'The column to aggregate.' }),
		query: optionalShape(queryShape),
	}),
	objectShape({
		operation: literalShape(['add'], {
			description: 'Insert one or more rows (fails on a duplicate key).',
		}),
		id: stringShape({ min: 1, description: 'The database id.' }),
		table: stringShape({ min: 1, description: 'The table name.' }),
		row: rowsShape,
	}),
	objectShape({
		operation: literalShape(['set'], { description: 'Upsert one or more rows.' }),
		id: stringShape({ min: 1, description: 'The database id.' }),
		table: stringShape({ min: 1, description: 'The table name.' }),
		row: rowsShape,
	}),
	objectShape({
		operation: literalShape(['update'], { description: 'Patch one or more existing rows.' }),
		id: stringShape({ min: 1, description: 'The database id.' }),
		table: stringShape({ min: 1, description: 'The table name.' }),
		key: keyShape,
		changes: rowShape,
	}),
	objectShape({
		operation: literalShape(['remove'], { description: 'Delete one or more rows by key.' }),
		id: stringShape({ min: 1, description: 'The database id.' }),
		table: stringShape({ min: 1, description: 'The table name.' }),
		key: keyShape,
	}),
	objectShape({
		operation: literalShape(['destroy'], { description: 'Drop a database entirely.' }),
		id: stringShape({ min: 1, description: 'The database id.' }),
	}),
)

// === Relation tool shape (createRelationTool call args, SRC-3)
//
// Every arm carries an optional `manager` (which registered `RelationManagerInterface` to
// address — omitted resolves to the sole registered manager) and a required `model` (the table
// name on that manager). `include` is a flat array of dot-paths (mirrors `databaseToolShape`'s
// flat-args ergonomic lever), expanded into a live `Include` by
// {@link import('./helpers.js').expandInclude}.

/** Describes one key value — a string or number; the array form (multiple keys, positional) resolves FIRST, so an array argument is read as many keys rather than one. */
export const relationKeyShape = unionShape(
	arrayShape(unionShape(stringShape(), numberShape()), {
		description: 'Multiple row keys, positional — a miss at an index is undefined there.',
	}),
	stringShape({ description: 'One row key.' }),
	numberShape({ description: 'One row key.' }),
)

/** Describes a single row key (not an array) — used by `'link'` / `'unlink'` / `'links'`, which address exactly one owning row. */
export const singleKeyShape = unionShape(
	stringShape({ description: 'The owning row key.' }),
	numberShape({ description: 'The owning row key.' }),
)

/** Describes the flat dot-path relation include list, expanded via {@link import('./helpers.js').expandInclude}. */
export const includeShape = optionalShape(
	arrayShape(
		stringShape({
			description: 'A dot-separated chain of relation names, e.g. "contacts.account".',
		}),
		{ description: 'Which relations to attach, as flat dot-paths.' },
	),
)

/** Describes which registered relation manager to address — omitted resolves to the sole registered manager. */
export const managerShape = optionalShape(
	stringShape({ min: 1, description: 'Which registered relation manager to address.' }),
)

/**
 * Describes the shape of {@link import('./factories.js').createRelationTool}'s call arguments —
 * discriminated by `operation` into the 5 relation operations (`'load'` / `'find'` / `'link'` /
 * `'unlink'` / `'links'`).
 *
 * @remarks
 * `'load'` fetches one or more rows (positional key/array) with `include` attached. `'find'`
 * fetches rows (pagination / sort only) with `include` attached. `'link'` / `'unlink'` write /
 * remove a `through` junction row; `'links'` lists a `through` relation's linked keys.
 */
export const relationToolShape = unionShape(
	objectShape({
		operation: literalShape(['load'], {
			description: 'Fetch one or more rows by key, with related rows attached.',
		}),
		manager: managerShape,
		model: stringShape({ min: 1, description: 'The model (table) name.' }),
		key: relationKeyShape,
		include: includeShape,
	}),
	objectShape({
		operation: literalShape(['find'], {
			description: 'List rows, with related rows attached.',
		}),
		manager: managerShape,
		model: stringShape({ min: 1, description: 'The model (table) name.' }),
		include: includeShape,
		limit: optionalShape(integerShape({ min: 0, description: 'Max rows to return.' })),
		offset: optionalShape(integerShape({ min: 0, description: 'Rows to skip before returning.' })),
		sort: optionalShape(stringShape({ min: 1, description: 'The column to sort by.' })),
		direction: optionalShape(
			literalShape(['ascending', 'descending'], { description: 'The sort direction.' }),
		),
	}),
	objectShape({
		operation: literalShape(['link'], {
			description: 'Connect two rows through a "through" relation.',
		}),
		manager: managerShape,
		model: stringShape({ min: 1, description: 'The model (table) name.' }),
		key: singleKeyShape,
		relation: stringShape({ min: 1, description: 'The "through" relation name.' }),
		target: singleKeyShape,
	}),
	objectShape({
		operation: literalShape(['unlink'], {
			description: 'Disconnect two rows previously linked through a "through" relation.',
		}),
		manager: managerShape,
		model: stringShape({ min: 1, description: 'The model (table) name.' }),
		key: singleKeyShape,
		relation: stringShape({ min: 1, description: 'The "through" relation name.' }),
		target: singleKeyShape,
	}),
	objectShape({
		operation: literalShape(['links'], {
			description: 'List every key linked to a row through a "through" relation.',
		}),
		manager: managerShape,
		model: stringShape({ min: 1, description: 'The model (table) name.' }),
		key: singleKeyShape,
		relation: stringShape({ min: 1, description: 'The "through" relation name.' }),
	}),
)

/**
 * Describes the shape of {@link import('./factories.js').createInferTool}'s call arguments — one or more
 * example `samples` to infer a JSON Schema from, plus per-call `format` / `enum` toggles and an
 * optional `candidates` array to check against the inferred schema.
 *
 * @remarks
 * `samples` requires at least one element (`min: 1`) — an empty array parses to `undefined`,
 * surfaced by the handler as a typed `TOOL` {@link import('./errors.js').ToolboxError}. When
 * `candidates` is present (any array, including empty), the handler compiles a contract from the
 * freshly inferred schema and checks each candidate against it with a STRICT guard (`.is`, no
 * coercion) — the opposite of {@link import('./factories.js').createEndpointTool}'s NORMALIZING
 * `.parse` enforcement.
 */
export const inferToolShape = objectShape({
	samples: arrayShape(jsonShape(), {
		min: 1,
		description: 'The example values to infer a JSON Schema from (at least one).',
	}),
	format: optionalShape(
		booleanShape({
			description:
				'Infer string formats (date-time, email, ...) from the samples. Defaults to false.',
		}),
	),
	enum: optionalShape(
		booleanShape({
			description: 'Infer enum constraints from repeated literal values. Defaults to false.',
		}),
	),
	candidates: optionalShape(
		arrayShape(jsonShape(), {
			description:
				'Optional values to check against the freshly inferred schema. When present, the tool ' +
				'returns a per-candidate verdict (strict — no coercion) alongside the inferred parameters.',
		}),
	),
})
