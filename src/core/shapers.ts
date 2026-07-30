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

// === Prompt / answer shapes (createPromptTool / createAnswerTool call args)
//
// `validate` is DECLARATIVE-ONLY here — a `Validator` is a function and cannot cross a JSON
// Schema / contract boundary, so `promptToolShape`'s inline `validate` field keeps only the
// primitive (`boolean` / `number` / `string`) rule fields `ValidationRules`
// (`@orkestrel/terminal`) accepts; `custom` (a bare `Validator`) is DROPPED — mirrors
// `serializeValidationRules`'s own function-stripping (`@orkestrel/terminal`).

/**
 * The shape of {@link import('./factories.js').createPromptTool}'s call arguments — `to` (the
 * terminal identity to address), `form` (which of the six {@link import('@orkestrel/terminal').PromptType}
 * forms to ask), `message`, an optional `timeout` override, and every per-form optional field
 * FLATTENED onto one object (mirrors `workspaceToolShape`'s flat-arm style, but a single shared
 * shape rather than a discriminated union — `form` alone does not vary the REQUIRED fields, only
 * which of the optional ones apply, so a flat shape stays faithful without duplicating `to` /
 * `message` / `timeout` across six near-identical arms).
 *
 * @remarks
 * `choices` backs `'select'` / `'checkbox'`; `default` backs `'input'` / `'confirm'` / `'select'`
 * (a string for the first two forms' text default, `'true'`/`'false'` string for confirm — the
 * contract layer cannot vary a field's type by a sibling field's value, so `default` stays a
 * string and the handler coerces per form); `mask` backs `'password'`; `min` / `max` backs
 * `'checkbox'`; `validate` (declarative only) backs the four text-shaped forms
 * (`'input'` / `'password'` / `'confirm'` / `'editor'`).
 */
export const promptToolShape = objectShape({
	to: stringShape({ min: 1, description: 'The terminal identity to address the prompt to.' }),
	form: literalShape(['input', 'password', 'confirm', 'select', 'checkbox', 'editor'], {
		description: 'Which prompt form to ask.',
	}),
	message: stringShape({ min: 1, description: "The prompt's question." }),
	default: optionalShape(
		stringShape({
			description:
				"The default answer if the responder submits blank — 'input' / 'editor' text, 'confirm' 'true'/'false', or a 'select' choice value.",
		}),
	),
	choices: optionalShape(
		arrayShape(
			objectShape({
				name: stringShape({
					min: 1,
					description: 'The choice label shown to the answering party.',
				}),
				value: stringShape({
					min: 1,
					description: 'The value submitted when this choice is picked.',
				}),
				description: optionalShape(
					stringShape({ description: 'An optional one-line elaboration.' }),
				),
			}),
			{ description: "The selectable choices for 'select' / 'checkbox'." },
		),
	),
	mask: optionalShape(
		stringShape({
			min: 1,
			description: "The mask character 'password' renders in place of input.",
		}),
	),
	min: optionalShape(
		integerShape({ min: 0, description: "The minimum number of 'checkbox' selections required." }),
	),
	max: optionalShape(
		integerShape({ min: 0, description: "The maximum number of 'checkbox' selections allowed." }),
	),
	validate: optionalShape(
		objectShape({
			required: optionalShape(booleanShape({ description: 'Reject an empty (trimmed) input.' })),
			minimum: optionalShape(
				integerShape({
					min: 0,
					description: 'Reject an input shorter than this many characters.',
				}),
			),
			maximum: optionalShape(
				integerShape({
					min: 0,
					description: 'Reject an input longer than this many characters.',
				}),
			),
			pattern: optionalShape(
				stringShape({
					description: 'Reject an input that fails this regular-expression source.',
				}),
			),
			email: optionalShape(booleanShape({ description: 'Require a valid email-address shape.' })),
			url: optionalShape(booleanShape({ description: 'Require a valid URL shape.' })),
			numeric: optionalShape(booleanShape({ description: 'Require a numeric value.' })),
			integer: optionalShape(booleanShape({ description: 'Require an integer value.' })),
			alphanumeric: optionalShape(
				booleanShape({ description: 'Require letters and digits only.' }),
			),
		}),
	),
	timeout: optionalShape(
		integerShape({ min: 0, description: 'Milliseconds to wait before the prompt expires.' }),
	),
})

/**
 * The shape of {@link import('./factories.js').createAnswerTool}'s call arguments — discriminated
 * by `operation`: `'pending'` lists the prompts addressed to this tool's terminal, `'answer'`
 * resolves one by `id` with a `value`.
 *
 * @remarks
 * `value`'s type varies by the ORIGINAL prompt's form (`string` for `'input'` / `'password'` /
 * `'select'` / `'editor'`, `boolean` for `'confirm'`, `readonly string[]` for `'checkbox'`) —
 * `unionShape(stringShape(), booleanShape(), arrayShape(stringShape()))` expresses that
 * union directly, so `value` is typed as the full `string | boolean | readonly string[]` union
 * here (no lossy string-only fallback needed).
 */
export const answerToolShape = unionShape(
	objectShape({
		operation: literalShape(['pending'], {
			description: 'List the prompts currently addressed to this terminal.',
		}),
	}),
	objectShape({
		operation: literalShape(['answer'], { description: 'Answer one pending prompt by id.' }),
		id: stringShape({ min: 1, description: 'The id of the pending prompt to answer.' }),
		value: unionShape(
			stringShape({ description: 'A text / select / editor answer.' }),
			booleanShape({ description: 'A confirm answer.' }),
			arrayShape(stringShape(), { description: 'A checkbox answer — the checked values.' }),
		),
	}),
)

// Tool-package shapes — the shape VALUE each `create*Tool` factory (factories.ts) compiles into
// the lockstep guard + parser + JSON Schema outputs (AGENTS §14). `agentToolShape` MUST agree
// with the hand-written `AgentToolArguments` (types.ts), which is the source of truth.
// `workflowStepsShape` / `workflowDraftShape` / `workspaceToolShape` are OWNED here now — ported
// byte-faithfully from `@orkestrel/workflow` / `@orkestrel/agent` ahead of the upstream cleanup
// that drops the authoring surface from those packages (this package becomes the defining home).

/**
 * The shape of {@link import('./types.js').AgentToolArguments} —
 * {@link import('./factories.js').createAgentTool}'s advertised `parameters`.
 *
 * @remarks
 * `task` is the only required field (a non-empty string); `provider` / `tools` / `system`
 * are per-call overrides of the tool's own configured defaults.
 */
export const agentToolShape = objectShape({
	task: stringShape({
		min: 1,
		description: 'The instructions the sub-agent should carry out.',
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
 * The shape of {@link import('./types.js').DescribeToolArguments} —
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

// === Workflow draft / flat-steps shapes (OWNED here now, ported from `@orkestrel/workflow`)

/**
 * The shape of a {@link import('./types.js').TaskDraft} — identical to a strict task shape
 * EXCEPT `id` and `name` are OPTIONAL.
 */
export const taskDraftShape = objectShape({
	id: optionalShape(stringShape({ min: 1, description: 'Task id; auto-filled when omitted.' })),
	name: optionalShape(
		stringShape({ min: 1, description: 'Task name; defaults to the id when omitted.' }),
	),
	description: optionalShape(stringShape({ description: 'Optional task description.' })),
	run: optionalShape(
		stringShape({
			min: 1,
			description:
				'The registered behavior name to invoke (a registry key, not a label); omitted has no handler.',
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
			description:
				'Per-attempt deadline in milliseconds; overrides the phase default. Omitted means no deadline.',
		}),
	),
})

/**
 * The shape of a PHASE in a draft workflow — identical to a strict phase shape EXCEPT `id` and
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
 * The shape of a DRAFT workflow — identical to a strict workflow shape EXCEPT `id` and `name`
 * are OPTIONAL at all three levels (workflow / phase / task), so a small model can omit the six
 * identity strings and let the tool synthesize them positionally.
 *
 * @remarks
 * The lenient counterpart {@link import('./factories.js').createWorkflowDraftContract} compiles.
 * `run` stays required on the strict form; a provided `id` / `name` still has `minLength: 1` (so
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
 * The shape of ONE flat step — `{ name }` — the building block of {@link workflowStepsShape}.
 *
 * @remarks
 * `name` is the REGISTERED behavior name the step runs (it becomes the task's `run`). The tool
 * expands each step into a one-task phase, in order ({@link import('./helpers.js').expandSteps}).
 */
export const stepShape = objectShape({
	name: stringShape({
		min: 1,
		description: 'The registered behavior name this step runs (becomes the task run).',
	}),
})

/**
 * The FLAT authoring shape {@link import('./factories.js').createWorkflowTool} advertises as its
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

// === Workspace operation shape (OWNED here now, ported from `@orkestrel/agent`)

/**
 * The shape of a {@link import('./types.js').WorkspaceOperation} — a descriptive tagged union
 * over the 13 workspace edit / read / navigation operations, discriminated by the `operation`
 * literal (never a bare `kind`; AGENTS §4.4). Each variant leads with its `operation`
 * discriminant then its FLAT fields, every field via `stringShape` / `optionalShape` /
 * `integerShape({ min: 1 })` / `booleanShape`, each carrying a strong field-level `description`.
 *
 * @remarks
 * The union compiles to an `anyOf` JSON Schema + a `unionOf` guard + a first-match parser
 * automatically ({@link import('./factories.js').createWorkspaceTool} types the result to the
 * hand-written {@link import('./types.js').WorkspaceOperation}). `limit` and the four `'splice'`
 * caret components are POSITIVE integers (`integerShape({ min: 1 })`); `regex` / `exact` are
 * `optionalShape(booleanShape(...))`. The two REGISTRY arms — `workspaces` (list the workspaces
 * the model can move between) and `switch` (re-point the active one by `id`) — let a model
 * DISCOVER then CHOOSE which workspace the edit / read arms target.
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
		exact: optionalShape(
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
		exact: optionalShape(
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

/** A {@link import('./types.js').ColumnKind} literal — the leaf {@link columnSpecShape} wraps. */
export const columnKindShape = literalShape(['string', 'integer', 'number', 'boolean'], {
	description: 'A column type: "string" | "integer" | "number" | "boolean".',
})

/** A {@link import('./types.js').ColumnSpec} — a bare {@link columnKindShape}, or `{ type, optional }`. */
export const columnSpecShape = unionShape(
	columnKindShape,
	objectShape({
		type: columnKindShape,
		optional: optionalShape(
			booleanShape({ description: 'Whether the column may be absent from a row.' }),
		),
	}),
)

/** A {@link import('./types.js').TableSpec} — table name to `{ columns }`, each column a {@link columnSpecShape}. */
export const tableSpecShape = recordShape(
	objectShape({
		columns: recordShape(columnSpecShape, { description: 'Column name to its type.' }),
	}),
	{ description: 'Table name to its column layout.' },
)

/** One key value — a string or number; the array form (multiple keys, positional) resolves FIRST per AGENTS §9.2. */
export const keyShape = unionShape(
	arrayShape(unionShape(stringShape(), numberShape()), {
		description: 'Multiple row keys, positional — a miss at an index is undefined there.',
	}),
	stringShape({ description: 'One row key.' }),
	numberShape({ description: 'One row key.' }),
)

/** A loose row — a flat object of column name to JSON value; the array form (multiple rows) resolves FIRST per AGENTS §9.2. */
export const rowShape = recordShape(jsonShape(), {
	description: 'A row as a flat object of column name to value.',
})

/** One or many loose rows — the array form resolves FIRST per AGENTS §9.2. */
export const rowsShape = unionShape(
	arrayShape(rowShape, { description: 'Multiple rows.' }),
	rowShape,
)

/** One SERIALIZED WHERE condition — `values` is ALWAYS an array, even for a single-value operator. */
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

/** One sort term. */
export const orderShape = objectShape({
	column: stringShape({ description: 'The column to sort by.' }),
	direction: literalShape(['ascending', 'descending'], { description: 'The sort direction.' }),
})

/** The SERIALIZED criteria form — conditions, order, and pagination. */
export const criteriaShape = objectShape({
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
 * The shape of {@link import('./factories.js').createDatabaseTool}'s call arguments —
 * discriminated by `operation` into the 12 database operations (`'create'` / `'tables'` /
 * `'get'` / `'records'` / `'count'` / `'aggregate'` / `'add'` / `'set'` / `'update'` /
 * `'remove'` / `'migrate'` / `'destroy'`).
 *
 * @remarks
 * Every arm carries `id` (the database id). `'create'` / `'migrate'` carry `tables` (the
 * {@link import('./types.js').TableSpec} column DSL, compiled via
 * {@link import('./helpers.js').expandTables}); `'get'` / `'update'` / `'remove'` carry `key`
 * (one key or an array of keys, positional); `'add'` / `'set'` carry `row` (one row or an array of
 * rows); `'update'` also carries `changes` (a loose partial row); `'records'` / `'count'` /
 * `'aggregate'` carry an optional `criteria` (the SERIALIZED form — `values` is ALWAYS an array,
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
		keys: optionalShape(
			recordShape(stringShape(), { description: 'Table name to its primary-key column.' }),
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
		operation: literalShape(['records'], { description: 'List rows matching criteria.' }),
		id: stringShape({ min: 1, description: 'The database id.' }),
		table: stringShape({ min: 1, description: 'The table name.' }),
		criteria: optionalShape(criteriaShape),
	}),
	objectShape({
		operation: literalShape(['count'], { description: 'Count rows matching criteria.' }),
		id: stringShape({ min: 1, description: 'The database id.' }),
		table: stringShape({ min: 1, description: 'The table name.' }),
		criteria: optionalShape(criteriaShape),
	}),
	objectShape({
		operation: literalShape(['aggregate'], { description: 'Compute an aggregate over a column.' }),
		id: stringShape({ min: 1, description: 'The database id.' }),
		table: stringShape({ min: 1, description: 'The table name.' }),
		function: literalShape(['count', 'sum', 'average', 'minimum', 'maximum'], {
			description: 'The aggregate function.',
		}),
		column: stringShape({ min: 1, description: 'The column to aggregate.' }),
		criteria: optionalShape(criteriaShape),
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
		operation: literalShape(['migrate'], { description: 'Replace the table layout in place.' }),
		id: stringShape({ min: 1, description: 'The database id.' }),
		tables: tableSpecShape,
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

/** One key value — a string or number; the array form (multiple keys, positional) resolves FIRST per AGENTS §9.2. */
export const relationKeyShape = unionShape(
	arrayShape(unionShape(stringShape(), numberShape()), {
		description: 'Multiple row keys, positional — a miss at an index is undefined there.',
	}),
	stringShape({ description: 'One row key.' }),
	numberShape({ description: 'One row key.' }),
)

/** A single row key (not an array) — used by `'link'` / `'unlink'` / `'links'`, which address exactly one owning row. */
export const singleKeyShape = unionShape(
	stringShape({ description: 'The owning row key.' }),
	numberShape({ description: 'The owning row key.' }),
)

/** Flat dot-path relation include list, expanded via {@link import('./helpers.js').expandInclude}. */
export const includeShape = optionalShape(
	arrayShape(
		stringShape({
			description: 'A dot-separated chain of relation names, e.g. "contacts.account".',
		}),
		{ description: 'Which relations to attach, as flat dot-paths.' },
	),
)

/** Which registered relation manager to address — omitted resolves to the sole registered manager. */
export const managerShape = optionalShape(
	stringShape({ min: 1, description: 'Which registered relation manager to address.' }),
)

/**
 * The shape of {@link import('./factories.js').createRelationTool}'s call arguments —
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
 * The shape of {@link import('./factories.js').createInferTool}'s call arguments — one or more
 * example `samples` to infer a JSON Schema from, plus per-call `format` / `enum` toggles and an
 * optional `candidates` array to check against the inferred schema.
 *
 * @remarks
 * `samples` requires at least one element (`min: 1`) — an empty array parses to `undefined`,
 * surfaced by the handler as a typed `TOOL` {@link import('./errors.js').AgentToolError}. When
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
