import type { JsonSchemaObject } from './types.js'
import {
	arrayShape,
	booleanShape,
	literalShape,
	numberShape,
	objectShape,
	oneOfShape,
	optionalShape,
	rawShape,
	recordShape,
	stringShape,
} from './shapers.js'
import { compileSchema } from './compilers.js'

// === MCP Tool Parameters

/** JSON Schema for the ReasonTool parameters */
export const REASON_TOOL_PARAMETERS: JsonSchemaObject = compileSchema(
	objectShape({
		definitionId: optionalShape(stringShape({ description: 'ID of a pre-loaded definition' })),
		definition: optionalShape(
			objectShape(
				{
					type: literalShape('quantitative', 'logical', 'symbolic', 'inferential'),
					id: stringShape({ description: 'Unique definition identifier' }),
					name: stringShape({ description: 'Human-readable name' }),
					groups: optionalShape(
						arrayShape(
							objectShape(
								{},
								{ additionalProperties: true, description: 'Factor groups (quantitative).' },
							),
						),
					),
					aggregation: optionalShape(
						literalShape('sum', 'product', 'average', 'minimum', 'maximum'),
					),
					rules: optionalShape(
						arrayShape(
							objectShape({}, { additionalProperties: true, description: 'Logical rules.' }),
						),
					),
					strategy: optionalShape(literalShape('forward', 'backward')),
					equations: optionalShape(
						arrayShape(
							objectShape(
								{},
								{ additionalProperties: true, description: 'Equations to solve (symbolic).' },
							),
						),
					),
					variables: optionalShape(
						recordShape(numberShape(), {
							description: 'Known variable bindings as {name: number} (symbolic)',
						}),
					),
					facts: optionalShape(
						arrayShape(
							objectShape(
								{},
								{ additionalProperties: true, description: 'Initial facts (inferential).' },
							),
						),
					),
					inferences: optionalShape(
						arrayShape(
							objectShape(
								{},
								{ additionalProperties: true, description: 'Inference rules (inferential).' },
							),
						),
					),
					precision: optionalShape(
						numberShape({ description: 'Decimal places for rounding results (default: 2)' }),
					),
					depth: optionalShape(
						numberShape({
							description: 'Maximum chaining depth (logical/inferential, default: 10)',
						}),
					),
					bounds: optionalShape(
						objectShape(
							{
								minimum: optionalShape(numberShape()),
								maximum: optionalShape(numberShape()),
							},
							{ description: 'Numeric clamp: {minimum?: number, maximum?: number}' },
						),
					),
				},
				{ description: 'Inline reasoning definition' },
			),
		),
		subject: optionalShape(
			objectShape({}, { additionalProperties: true, description: 'Data to reason about.' }),
		),
		subjects: optionalShape(
			arrayShape(objectShape({}, { additionalProperties: true }), {
				description: 'Array of subjects to reason about in batch.',
			}),
		),
		memory: optionalShape(
			booleanShape({ description: 'Store this definition in memory for reuse.' }),
		),
		persist: optionalShape(
			booleanShape({ description: 'Save this definition to disk. Implies memory: true.' }),
		),
		forget: optionalShape(oneOfShape(stringShape(), booleanShape())),
		list: optionalShape(
			booleanShape({ description: 'When true, returns a summary of all stored definitions.' }),
		),
		import: optionalShape(
			stringShape({ description: 'Path to a definition file to import and store.' }),
		),
	}),
)

/** JSON Schema for SandboxTool parameters (includes filesystem workspace operations) */
export const SANDBOX_TOOL_PARAMETERS: JsonSchemaObject = compileSchema(
	objectShape({
		operation: literalShape(
			'create',
			'write',
			'read',
			'scan',
			'entries',
			'ensure',
			'remove',
			'stat',
			'has',
			'execute',
			'destroy',
			'list',
			'search',
			'replace',
			'open',
			'prepend',
			'append',
			'move',
			'revert',
			'persist',
			'snapshot',
			'restore',
		),
		target: optionalShape(literalShape('workspace')),
		id: optionalShape(
			stringShape({
				description: 'Sandbox id (required for sandbox operations, not for workspace).',
			}),
		),
		path: optionalShape(oneOfShape(stringShape(), arrayShape(stringShape()))),
		content: optionalShape(
			stringShape({
				description: 'File content for write, prepend, append, or replacement string.',
			}),
		),
		query: optionalShape(
			stringShape({ description: 'Search query string for search and replace (workspace only).' }),
		),
		from: optionalShape(stringShape({ description: 'Source path for move (workspace only).' })),
		to: optionalShape(stringShape({ description: 'Target path for move (workspace only).' })),
		range: optionalShape(
			objectShape(
				{
					start: objectShape({
						line: numberShape(),
						column: numberShape(),
					}),
					end: objectShape({
						line: numberShape(),
						column: numberShape(),
					}),
				},
				{ description: 'Line/column range for read and write (workspace only).' },
			),
		),
		pattern: optionalShape(stringShape({ description: 'Glob pattern for filtering.' })),
		exclude: optionalShape(arrayShape(stringShape(), { description: 'Glob patterns to exclude.' })),
		depth: optionalShape(numberShape({ description: 'Maximum directory depth for scan.' })),
		size: optionalShape(numberShape({ description: 'Maximum file size in bytes.' })),
		paths: optionalShape(
			arrayShape(stringShape(), { description: 'Root directories to search (workspace only).' }),
		),
		regex: optionalShape(booleanShape({ description: 'Treat query as regex.' })),
		exact: optionalShape(booleanShape({ description: 'Match case exactly. Default: true.' })),
		limit: optionalShape(numberShape({ description: 'Maximum number of matches.' })),
		context: optionalShape(numberShape({ description: 'Surrounding lines per match.' })),
		force: optionalShape(booleanShape({ description: 'Override size limit or force remove.' })),
		encoding: optionalShape(stringShape({ description: 'Character encoding override.' })),
		snapshot: optionalShape(
			oneOfShape(stringShape(), objectShape({}, { additionalProperties: true })),
		),
		recursive: optionalShape(
			booleanShape({ description: 'Remove recursively (sandbox only). Default: false.' }),
		),
		label: optionalShape(stringShape({ description: 'Optional label for the sandbox.' })),
		symlinkNodeModules: optionalShape(
			booleanShape({ description: 'Symlink node_modules from cwd. Default: true.' }),
		),
		command: optionalShape(stringShape({ description: 'Command to execute (sandbox only).' })),
		args: optionalShape(arrayShape(stringShape(), { description: 'Command arguments.' })),
		timeout: optionalShape(
			numberShape({ description: 'Max execution time in ms. Default: 30000.' }),
		),
		shell: optionalShape(booleanShape({ description: 'Run in shell. Default: true.' })),
		environment: optionalShape(
			recordShape(stringShape(), { description: 'Extra environment variables.' }),
		),
	}),
)
export const INTERPRET_TOOL_PARAMETERS: JsonSchemaObject = compileSchema(
	objectShape({
		operation: optionalShape(
			literalShape('interpret', 'describe', 'normalize', 'parse', 'templates'),
		),
		input: optionalShape(
			stringShape({ description: 'Natural language input for interpret, normalize, or parse.' }),
		),
		subject: optionalShape(
			objectShape(
				{},
				{ additionalProperties: true, description: 'Subject data for the describe operation.' },
			),
		),
		definition: optionalShape(
			objectShape(
				{},
				{
					additionalProperties: true,
					description: 'Reason definition for the describe operation.',
				},
			),
		),
		forget: optionalShape(oneOfShape(stringShape(), booleanShape())),
		import: optionalShape(stringShape({ description: 'Path to a template file to import.' })),
	}),
)

/** JSON Schema for the AgentTool parameters */
export const AGENT_TOOL_PARAMETERS: JsonSchemaObject = compileSchema(
	objectShape({
		task: optionalShape(
			stringShape({ description: 'A detailed description of the task for the agent.' }),
		),
		model: optionalShape(stringShape({ description: 'Optional model name override.' })),
		system: optionalShape(
			stringShape({ description: 'Optional system prompt override for the child agent.' }),
		),
		instructions: optionalShape(
			arrayShape(
				objectShape({
					name: stringShape(),
					content: stringShape(),
					priority: optionalShape(numberShape()),
				}),
				{ description: 'Optional instructions for the child agent.' },
			),
		),
		documents: optionalShape(
			arrayShape(
				objectShape({
					path: stringShape(),
					content: stringShape(),
					language: optionalShape(stringShape()),
				}),
				{ description: 'Optional reference documents.' },
			),
		),
		images: optionalShape(
			arrayShape(
				objectShape({
					name: stringShape(),
					data: stringShape(),
					mime: optionalShape(literalShape('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
				}),
				{ description: 'Optional base64-encoded images for multimodal inference.' },
			),
		),
		tools: optionalShape(
			arrayShape(stringShape(), { description: 'Tool names the child agent is allowed to use.' }),
		),
		messages: optionalShape(
			arrayShape(
				objectShape({
					role: literalShape('user', 'assistant', 'tool'),
					content: stringShape(),
				}),
				{ description: 'Optional conversation messages for prior context.' },
			),
		),
		scope: optionalShape(
			objectShape(
				{
					instructions: optionalShape(arrayShape(stringShape())),
					documents: optionalShape(arrayShape(stringShape())),
					images: optionalShape(arrayShape(stringShape())),
					tools: optionalShape(arrayShape(stringShape())),
					messages: optionalShape(arrayShape(stringShape())),
				},
				{ description: 'Optional scope restriction for child agent context.' },
			),
		),
		timeout: optionalShape(numberShape({ description: 'Timeout in ms for execution.' })),
		budget: optionalShape(
			objectShape(
				{
					max: numberShape(),
					scope: optionalShape(literalShape('completion', 'total')),
				},
				{ description: 'Optional token budget.' },
			),
		),
		models: optionalShape(
			booleanShape({
				description: 'When true, returns available models instead of running an agent.',
			}),
		),
	}),
)

/** JSON Schema for PromptTool parameters */
export const PROMPT_TOOL_PARAMETERS: JsonSchemaObject = compileSchema(
	objectShape({
		operation: literalShape(
			'input',
			'password',
			'confirm',
			'select',
			'checkbox',
			'editor',
			'form',
			'register',
			'fill',
			'validate',
			'templates',
			'remove',
			'launch',
			'status',
		),
		message: optionalShape(stringShape({ description: 'Question displayed to the user.' })),
		default: optionalShape(
			rawShape({ description: 'Default value when user submits empty input.' }),
		),
		mask: optionalShape(stringShape({ description: 'Mask character for password.' })),
		validate: optionalShape(
			objectShape(
				{
					required: optionalShape(booleanShape()),
					minimum: optionalShape(numberShape()),
					maximum: optionalShape(numberShape()),
					pattern: optionalShape(stringShape()),
					email: optionalShape(booleanShape()),
					url: optionalShape(booleanShape()),
					numeric: optionalShape(booleanShape()),
					integer: optionalShape(booleanShape()),
					alphanumeric: optionalShape(booleanShape()),
				},
				{ description: 'Declarative validation rules.' },
			),
		),
		choices: optionalShape(
			arrayShape(
				oneOfShape(
					stringShape(),
					objectShape({
						name: stringShape(),
						value: stringShape(),
						description: optionalShape(stringShape()),
						checked: optionalShape(booleanShape()),
					}),
				),
				{ description: 'Options for select and checkbox.' },
			),
		),
		min: optionalShape(numberShape({ description: 'Minimum selections for checkbox.' })),
		max: optionalShape(numberShape({ description: 'Maximum selections for checkbox.' })),
		fields: optionalShape(
			arrayShape(
				objectShape({
					name: stringShape(),
					type: literalShape('input', 'password', 'confirm', 'select', 'checkbox', 'editor'),
					message: stringShape(),
					default: optionalShape(rawShape({ description: 'Default value.' })),
					validate: optionalShape(objectShape({}, { additionalProperties: true })),
					choices: optionalShape(
						arrayShape(oneOfShape(stringShape(), objectShape({}, { additionalProperties: true }))),
					),
					mask: optionalShape(stringShape()),
					min: optionalShape(numberShape()),
					max: optionalShape(numberShape()),
				}),
				{ description: 'Field definitions for the form operation.' },
			),
		),
		id: optionalShape(stringShape({ description: 'Template id for fill, validate, remove.' })),
		template: optionalShape(
			objectShape(
				{
					id: stringShape(),
					name: stringShape(),
					content: stringShape(),
					placeholders: arrayShape(
						objectShape({
							name: stringShape(),
							required: optionalShape(booleanShape()),
							value: optionalShape(stringShape()),
							description: optionalShape(stringShape()),
						}),
					),
					summary: optionalShape(stringShape()),
					description: optionalShape(stringShape()),
					category: optionalShape(stringShape()),
					tags: optionalShape(arrayShape(stringShape())),
				},
				{ description: 'Template definition for register.' },
			),
		),
		values: optionalShape(
			recordShape(stringShape(), { description: 'Placeholder values for fill and validate.' }),
		),
	}),
)

/** JSON Schema for WorkflowTool parameters */
export const WORKFLOW_TOOL_PARAMETERS: JsonSchemaObject = compileSchema(
	objectShape({
		operation: literalShape(
			'create',
			'status',
			'advance',
			'snapshot',
			'restore',
			'list',
			'remove',
			'addPhase',
			'addTask',
		),
		id: optionalShape(stringShape({ description: 'Workflow id.' })),
		name: optionalShape(stringShape({ description: 'Human-readable name.' })),
		description: optionalShape(stringShape({ description: 'Description text.' })),
		phases: optionalShape(
			arrayShape(
				objectShape({
					name: optionalShape(stringShape({ description: 'Phase name.' })),
					description: optionalShape(stringShape({ description: 'Phase description.' })),
					tasks: optionalShape(
						arrayShape(
							objectShape({
								name: optionalShape(stringShape({ description: 'Task name.' })),
								description: optionalShape(stringShape({ description: 'Task description.' })),
								metadata: optionalShape(objectShape({}, { additionalProperties: true })),
							}),
							{ description: 'Task definitions for the phase.' },
						),
					),
				}),
				{ description: 'Phase definitions for create.' },
			),
		),
		phaseId: optionalShape(stringShape({ description: 'Phase id for addTask.' })),
		taskId: optionalShape(stringShape({ description: 'Task id for advance.' })),
		action: optionalShape(
			literalShape('start', 'complete', 'skip', 'block', 'unblock', 'fail', 'pause', 'resume'),
		),
		value: optionalShape(rawShape({ description: 'Result value for complete action.' })),
		error: optionalShape(stringShape({ description: 'Error or block reason.' })),
		snapshot: optionalShape(rawShape({ description: 'Snapshot id or object for restore.' })),
		steps: optionalShape(
			arrayShape(
				objectShape(
					{},
					{
						additionalProperties: true,
						description: 'Operation step.',
					},
				),
				{
					description:
						'Array of operations to execute sequentially as a batch. Each element is an object with `operation` plus operation-specific fields.',
				},
			),
		),
		tasks: optionalShape(
			arrayShape(
				objectShape({
					name: optionalShape(stringShape({ description: 'Task name.' })),
					description: optionalShape(stringShape({ description: 'Task description.' })),
					metadata: optionalShape(objectShape({}, { additionalProperties: true })),
				}),
				{ description: 'Task definitions for addPhase.' },
			),
		),
		metadata: optionalShape(
			objectShape(
				{},
				{
					additionalProperties: true,
					description: 'Task metadata for addTask.',
				},
			),
		),
	}),
)

/** JSON Schema for BrowserTool input parameters. */
export const BROWSER_TOOL_PARAMETERS: JsonSchemaObject = compileSchema(
	objectShape({
		operation: optionalShape(
			literalShape(
				'launch',
				'create',
				'navigate',
				'content',
				'screenshot',
				'click',
				'fill',
				'select',
				'evaluate',
				'wait',
				'scroll',
				'hover',
				'pages',
				'close',
				'disconnect',
				'reconnect',
				'status',
			),
		),
		url: optionalShape(stringShape({ description: 'URL for navigate or create operation.' })),
		selector: optionalShape(
			stringShape({
				description: 'CSS selector for click, fill, select, wait, scroll, hover.',
			}),
		),
		value: optionalShape(stringShape({ description: 'Value for fill operation.' })),
		values: optionalShape(
			arrayShape(stringShape(), { description: 'Values for select operation.' }),
		),
		expression: optionalShape(stringShape({ description: 'JavaScript expression for evaluate.' })),
		condition: optionalShape(literalShape('load', 'domcontentloaded', 'networkidle')),
		full: optionalShape(booleanShape({ description: 'Full-page screenshot. Default: false.' })),
		format: optionalShape(literalShape('png', 'jpeg')),
		quality: optionalShape(numberShape({ description: 'JPEG quality 0-100.' })),
		timeout: optionalShape(numberShape({ description: 'Operation timeout in ms.' })),
		page: optionalShape(numberShape({ description: 'Page index. Default: 0.' })),
		x: optionalShape(numberShape({ description: 'X coordinate for scroll.' })),
		y: optionalShape(numberShape({ description: 'Y coordinate for scroll.' })),
		steps: optionalShape(
			arrayShape(
				objectShape(
					{},
					{
						additionalProperties: true,
						description: 'Operation step with operation + args.',
					},
				),
				{
					description:
						'Array of operations to execute sequentially as a batch. Each element is an object with `operation` plus operation-specific fields.',
				},
			),
		),
		macro: optionalShape(
			objectShape(
				{
					id: stringShape({ description: 'Unique macro identifier for storage and retrieval.' }),
					name: stringShape({ description: 'Human-readable name describing the macro.' }),
					steps: arrayShape(
						objectShape(
							{},
							{
								additionalProperties: true,
								description: 'Operation step with operation + args.',
							},
						),
						{ description: 'Ordered sequence of operation-args records to execute.' },
					),
				},
				{
					description:
						'Define a reusable macro — a named sequence of browser operations. Use with `memory` or `persist` to store.',
				},
			),
		),
		macroId: optionalShape(stringShape({ description: 'ID of a stored macro to replay.' })),
		memory: optionalShape(booleanShape({ description: 'Store this macro in memory for reuse.' })),
		persist: optionalShape(
			booleanShape({ description: 'Save this macro to disk. Implies memory: true.' }),
		),
		forget: optionalShape(oneOfShape(stringShape(), booleanShape())),
		macros: optionalShape(
			booleanShape({
				description: 'When true, returns a list of all stored macros.',
			}),
		),
	}),
)
