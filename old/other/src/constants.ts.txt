import type { ReconnectionOptions } from './types.js'

// === Transport

/** HTTP header name for MCP session identification */
export const MCP_SESSION_HEADER = 'mcp-session-id'

/** HTTP header name for MCP protocol version negotiation */
export const MCP_PROTOCOL_VERSION_HEADER = 'mcp-protocol-version'

/** WebSocket subprotocol identifier for MCP */
export const WEBSOCKET_SUBPROTOCOL = 'mcp'

/** Default reconnection configuration for client transports */
export const DEFAULT_RECONNECTION: ReconnectionOptions = {
	delay: 1000,
	ceiling: 30_000,
	factor: 1.5,
	retries: 2,
}

// === EventStore

/** Default EventStore capacity (max events retained) */
export const DEFAULT_EVENT_STORE_CAPACITY = 1000

/** Default EventStore TTL in milliseconds (5 minutes) */
export const DEFAULT_EVENT_STORE_TTL = 300_000

// === Store

/** Default directory for persisted definitions (relative to cwd) */
export const DEFAULT_REASON_DEFINITIONS_DIR = '.orkestrel/definitions/reason'

/** Default directory for persisted snapshots (relative to cwd) */
export const DEFAULT_FILESYSTEM_SNAPSHOTS_DIR = '.orkestrel/snapshots/filesystem'

/** Default directory for persisted interpret templates (relative to cwd) */
export const DEFAULT_INTERPRET_TEMPLATES_DIR = '.orkestrel/templates/interpret'

/** Default directory for persisted prompt templates (relative to cwd) */
export const DEFAULT_PROMPT_TEMPLATES_DIR = '.orkestrel/templates/prompt'

/** Default directory for persisted workflow snapshots (relative to cwd) */
export const DEFAULT_WORKFLOW_SNAPSHOTS_DIR = '.orkestrel/snapshots/workflow'

/** File extension for persisted definition files */
export const DEFINITION_FILE_EXTENSION = '.json'

/** File extensions for script-based definition files (loaded via dynamic import) */
export const DEFINITION_SCRIPT_EXTENSIONS: readonly string[] = ['.js', '.mjs', '.ts', '.mts']

export const ALLOWED_MESSAGE_ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'tool'])

// JSON Schema describing the tool input for model consumption
export const REASON_TOOL_PARAMETERS: Record<string, unknown> = {
	type: 'object',
	properties: {
		definitionId: {
			type: 'string',
			description: 'ID of a pre-loaded definition',
		},
		definition: {
			type: 'object',
			description: 'Inline reasoning definition',
			required: ['type', 'id', 'name'],
			properties: {
				type: {
					type: 'string',
					enum: ['quantitative', 'logical', 'symbolic', 'inferential'],
					description: 'Reasoning type discriminator',
				},
				id: { type: 'string', description: 'Unique definition identifier' },
				name: { type: 'string', description: 'Human-readable name' },
				// quantitative
				groups: {
					type: 'array',
					description:
						'Factor groups (quantitative). Each group has id, label, aggregation (sum|product|average|minimum|maximum), and factors[].',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							label: { type: 'string' },
							aggregation: {
								type: 'string',
								enum: ['sum', 'product', 'average', 'minimum', 'maximum'],
							},
							base: {
								type: 'number',
								description: 'Base value added before aggregation (default: 0)',
							},
							strict: {
								type: 'boolean',
								description: 'When true, all factors must apply or the group value is 0',
							},
							enabled: { type: 'boolean', description: 'When false, the group is skipped' },
							bounds: {
								type: 'object',
								properties: {
									minimum: { type: 'number' },
									maximum: { type: 'number' },
								},
							},
							factors: {
								type: 'array',
								description:
									'Factors in the group. Each factor has id, label, source (Source object), weight, and optional conditions, transforms, bounds, fallback, priority, enabled, required.',
								items: {
									type: 'object',
									properties: {
										id: { type: 'string' },
										label: { type: 'string' },
										source: {
											type: 'object',
											description:
												"How to obtain the numeric value. Use {kind:'field', field:'fieldName'} to read from subject, {kind:'static', value:N} for a constant, {kind:'lookup', field:'fieldName', table:{key:value}} for key-value mapping, or {kind:'range', field:'fieldName', ranges:[{bounds:{minimum,maximum}, value}]} for range bands.",
											properties: {
												kind: {
													type: 'string',
													enum: ['static', 'field', 'lookup', 'range'],
												},
												field: { type: 'string' },
												value: { type: 'number' },
												table: {
													type: 'object',
													additionalProperties: { type: 'number' },
												},
												ranges: {
													type: 'array',
													items: {
														type: 'object',
														properties: {
															bounds: {
																type: 'object',
																properties: {
																	minimum: { type: 'number' },
																	maximum: { type: 'number' },
																},
															},
															value: { type: 'number' },
														},
													},
												},
											},
											required: ['kind'],
										},
										weight: { type: 'number' },
										fallback: { type: 'number' },
										priority: { type: 'number' },
										enabled: { type: 'boolean' },
										required: { type: 'boolean' },
										conditions: {
											type: 'array',
											items: {
												type: 'object',
												properties: {
													field: { type: 'string' },
													operator: {
														type: 'string',
														enum: [
															'equals',
															'notEquals',
															'greaterThan',
															'greaterThanOrEqual',
															'lessThan',
															'lessThanOrEqual',
															'in',
															'notIn',
															'between',
															'notBetween',
														],
													},
													value: {},
												},
											},
										},
										transforms: {
											type: 'array',
											items: {
												type: 'object',
												properties: {
													operation: {
														type: 'string',
														enum: [
															'add',
															'subtract',
															'multiply',
															'divide',
															'percentage',
															'minimum',
															'maximum',
															'average',
															'power',
															'round',
															'ceil',
															'floor',
															'abs',
														],
													},
													operand: { type: 'number' },
												},
											},
										},
										bounds: {
											type: 'object',
											properties: {
												minimum: { type: 'number' },
												maximum: { type: 'number' },
											},
										},
									},
								},
							},
						},
					},
				},
				aggregation: {
					type: 'string',
					enum: ['sum', 'product', 'average', 'minimum', 'maximum'],
					description: 'How to combine group values (quantitative, default: sum)',
				},
				// logical
				rules: {
					type: 'array',
					description:
						"Logical rules. Each rule has id, label, premises (Expression[]), and conclusion (Expression). Expressions are {type:'atom', condition:{field, operator, value}} or {type:'compound', operator:'and'|'or'|'not'|'implies'|'xor', operands:[]}. Valid condition operators: equals, notEquals, greaterThan, greaterThanOrEqual, lessThan, lessThanOrEqual, in, notIn, between, notBetween.",
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							label: { type: 'string' },
							premises: {
								type: 'array',
								items: { type: 'object', additionalProperties: true },
							},
							conclusion: { type: 'object', additionalProperties: true },
						},
					},
				},
				strategy: {
					type: 'string',
					enum: ['forward', 'backward'],
					description: 'Rule evaluation direction (logical/inferential, default: forward)',
				},
				// symbolic
				equations: {
					type: 'array',
					description:
						"Equations to solve. Each equation has id, label, left (SymbolicExpression), right (SymbolicExpression), and target (variable name to solve for). SymbolicExpressions are {type:'variable', name} or {type:'constant', value} or {type:'operation', operator, left, right}. Valid operators: add, subtract, multiply, divide, power, minimum, maximum, average, percentage, round, ceil, floor, abs. For square root use power with exponent 0.5.",
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							label: { type: 'string' },
							left: { type: 'object', additionalProperties: true },
							right: { type: 'object', additionalProperties: true },
							target: { type: 'string' },
						},
					},
				},
				variables: {
					type: 'object',
					description: 'Known variable bindings as {name: number} (symbolic)',
					additionalProperties: { type: 'number' },
				},
				// inferential
				facts: {
					type: 'array',
					description:
						'Initial facts. Each fact has id, predicate, arguments[], and optional confidence (0-1).',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							predicate: { type: 'string' },
							arguments: { type: 'array', items: { type: 'string' } },
							confidence: { type: 'number' },
						},
					},
				},
				inferences: {
					type: 'array',
					description:
						"Inference rules. Each has id, label, premises (Fact[]), conclusion (Fact), and optional confidence. Use '?varName' in arguments for variable binding.",
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							label: { type: 'string' },
							premises: {
								type: 'array',
								items: { type: 'object', additionalProperties: true },
							},
							conclusion: { type: 'object', additionalProperties: true },
							confidence: { type: 'number' },
						},
					},
				},
				// shared
				precision: {
					type: 'number',
					description: 'Decimal places for rounding results (default: 2)',
				},
				depth: {
					type: 'number',
					description: 'Maximum chaining depth (logical/inferential, default: 10)',
				},
				bounds: {
					type: 'object',
					description: 'Numeric clamp: {minimum?: number, maximum?: number}',
					properties: {
						minimum: { type: 'number' },
						maximum: { type: 'number' },
					},
				},
			},
		},
		subject: {
			type: 'object',
			description:
				'Data to reason about. Any key-value object. Fields are referenced by name in conditions, sources, and variable bindings.',
			additionalProperties: true,
		},
		subjects: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: true,
			},
			description:
				'Array of subjects to reason about in batch. Each element is a key-value object like subject. When provided, returns an array of results.',
		},
		memory: {
			type: 'boolean',
			description:
				'Store this definition in memory for reuse by definitionId in subsequent calls. Default depends on tool configuration.',
		},
		persist: {
			type: 'boolean',
			description:
				'Save this definition to disk so it survives server restarts. Implies memory: true.',
		},
		forget: {
			description:
				'Remove a stored definition by id (string), or remove all stored definitions (true). Returns confirmation without reasoning.',
			oneOf: [{ type: 'string' }, { type: 'boolean' }],
		},
		list: {
			type: 'boolean',
			description:
				'When true, returns a summary of all stored definitions (id, name, type) without reasoning.',
		},
		import: {
			type: 'string',
			description:
				'Absolute or relative path to a definition file (.json, .js, .mjs, .ts, .mts) to import and store. The file must export a valid ReasonDefinition. Returns the imported definition id.',
		},
	},
}

/** Latest MCP protocol version for the initialize handshake */
export const MCP_PROTOCOL_VERSION = '2025-03-26'

/**
 * All MCP protocol versions this implementation supports, newest first.
 *
 * @remarks
 * Used during the initialize handshake to negotiate a version the client
 * also supports. The server picks the newest version present in both
 * this list and the client's supported set.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-03-26', '2024-11-05']

/** Default MCP client name sent during initialize */
export const DEFAULT_MCP_CLIENT_NAME = 'atelier'

/** Default MCP client version sent during initialize */
export const DEFAULT_MCP_CLIENT_VERSION = '0.0.1'

/** Default request timeout in milliseconds (60 seconds) */
export const DEFAULT_TIMEOUT_MS = 60_000

/** JSON Schema for the FileSystemTool parameters */
export const FILESYSTEM_TOOL_PARAMETERS: Readonly<Record<string, unknown>> = {
	type: 'object',
	properties: {
		operation: {
			type: 'string',
			description: 'The filesystem operation to perform.',
			enum: [
				'scan',
				'stat',
				'search',
				'replace',
				'open',
				'read',
				'write',
				'prepend',
				'append',
				'remove',
				'move',
				'list',
				'revert',
				'persist',
				'snapshot',
				'restore',
			],
		},
		path: {
			description:
				'File or directory path. Required for scan, stat, open, read, write, prepend, append. String for single, array for batch (open, remove, revert, persist).',
			oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
		},
		content: {
			type: 'string',
			description:
				'File content. Required for write, prepend, and append operations. For replace, this is the replacement string.',
		},
		query: {
			type: 'string',
			description: 'Search query string. Required for the search and replace operations.',
		},
		from: {
			type: 'string',
			description: 'Source path. Required for the move operation.',
		},
		to: {
			type: 'string',
			description: 'Target path. Required for the move operation.',
		},
		range: {
			type: 'object',
			description: 'Line/column range for read and write operations.',
			properties: {
				start: {
					type: 'object',
					properties: {
						line: { type: 'number', description: '1-based line number.' },
						column: { type: 'number', description: '1-based column number.' },
					},
					required: ['line', 'column'],
				},
				end: {
					type: 'object',
					properties: {
						line: { type: 'number', description: '1-based line number.' },
						column: { type: 'number', description: '1-based column number.' },
					},
					required: ['line', 'column'],
				},
			},
			required: ['start', 'end'],
		},
		pattern: {
			type: 'string',
			description: 'Glob pattern for filtering scan or search results.',
		},
		exclude: {
			type: 'array',
			items: { type: 'string' },
			description: 'Glob patterns for paths to exclude from scan or search.',
		},
		depth: {
			type: 'number',
			description: 'Maximum directory depth for scan.',
		},
		size: {
			type: 'number',
			description: 'Maximum file size in bytes for scan filtering.',
		},
		paths: {
			type: 'array',
			items: { type: 'string' },
			description: 'Root directories or file paths to search.',
		},
		regex: {
			type: 'boolean',
			description: 'Treat the search query as a regular expression.',
		},
		exact: {
			type: 'boolean',
			description: 'Match case exactly. Default: true. Set to false for case-insensitive matching.',
		},
		limit: {
			type: 'number',
			description: 'Maximum number of search matches to return.',
		},
		context: {
			type: 'number',
			description: 'Number of surrounding lines to include per search match.',
		},
		force: {
			type: 'boolean',
			description: 'Override size limit when opening a file.',
		},
		encoding: {
			type: 'string',
			description: 'Character encoding override for open.',
		},
		snapshot: {
			description:
				'A Snapshot for the restore operation. Pass a snapshot id string to restore from stored snapshots, or a full snapshot object.',
			oneOf: [
				{ type: 'string' },
				{
					type: 'object',
					properties: {
						id: { type: 'string' },
						created: { type: 'number' },
						files: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									path: { type: 'string' },
									content: { type: 'string' },
									encoding: { type: 'string' },
									state: { type: 'string' },
									persisted: { type: 'boolean' },
								},
								required: ['path', 'content', 'encoding', 'state', 'persisted'],
							},
						},
					},
					required: ['id', 'created', 'files'],
				},
			],
		},
	},
	required: ['operation'],
}

/** JSON Schema for the InterpretTool parameters */
export const INTERPRET_TOOL_PARAMETERS: Readonly<Record<string, unknown>> = {
	type: 'object',
	properties: {
		operation: {
			type: 'string',
			description: 'The interpret operation to perform.',
			enum: ['interpret', 'describe', 'normalize', 'parse', 'templates'],
		},
		input: {
			type: 'string',
			description: 'Natural language input for interpret, normalize, or parse operations.',
		},
		subject: {
			type: 'object',
			description:
				'Subject data for the describe operation. A key-value object representing structured inputs.',
			additionalProperties: true,
		},
		definition: {
			type: 'object',
			description: 'Reason definition for the describe operation. Must include type, id, and name.',
			additionalProperties: true,
		},
		forget: {
			description:
				'Remove a stored template by id (string), or remove all stored templates (true). Returns confirmation without interpretation.',
			oneOf: [{ type: 'string' }, { type: 'boolean' }],
		},
		import: {
			type: 'string',
			description:
				'Absolute or relative path to a template file (.json, .js, .mjs, .ts, .mts) to import and register. The file must export a valid InterpretTemplate. Returns the imported template id.',
		},
	},
}

/** JSON Schema for the AgentTool parameters */
export const AGENT_TOOL_PARAMETERS: Readonly<Record<string, unknown>> = {
	type: 'object',
	properties: {
		task: {
			type: 'string',
			description:
				'A detailed description of the task for the agent to perform. Should be clear and specific about what the agent should accomplish.',
		},
		model: {
			type: 'string',
			description:
				'Optional model name to use for this invocation. Overrides the default model. Use the models() query to discover available models.',
		},
		system: {
			type: 'string',
			description:
				'Optional system prompt override for the child agent. When omitted, the agent uses its default system prompt.',
		},
		instructions: {
			type: 'array',
			items: {
				type: 'object',
				required: ['name', 'content'],
				properties: {
					name: { type: 'string', description: 'Unique name for the instruction.' },
					content: { type: 'string', description: 'The instruction text the agent must follow.' },
					priority: {
						type: 'number',
						description: 'Higher priority instructions are presented first. Default: 0.',
					},
				},
			},
			description: "Optional instructions to guide the child agent's behavior.",
		},
		documents: {
			type: 'array',
			items: {
				type: 'object',
				required: ['path', 'content'],
				properties: {
					path: { type: 'string', description: 'File path or identifier for the document.' },
					content: { type: 'string', description: 'The document content.' },
					language: { type: 'string', description: 'Programming language or format hint.' },
				},
			},
			description: 'Optional reference documents to provide as context to the child agent.',
		},
		images: {
			type: 'array',
			items: {
				type: 'object',
				required: ['name', 'data'],
				properties: {
					name: { type: 'string', description: 'Unique name for the image.' },
					data: { type: 'string', description: 'Base64-encoded image data.' },
					mime: {
						type: 'string',
						enum: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
						description: 'MIME type of the image. Inferred from the name extension when omitted.',
					},
				},
			},
			description: 'Optional base64-encoded images to provide for multimodal inference.',
		},
		tools: {
			type: 'array',
			items: { type: 'string' },
			description:
				'Optional list of tool names the child agent is allowed to use. When omitted, all pre-configured tools are available. When provided, only the named tools are visible (scope restriction).',
		},
		messages: {
			type: 'array',
			items: {
				type: 'object',
				required: ['role', 'content'],
				properties: {
					role: {
						type: 'string',
						enum: ['user', 'assistant', 'tool'],
						description: 'The role of the message sender.',
					},
					content: { type: 'string', description: 'The message content.' },
				},
			},
			description:
				'Optional conversation messages to seed the child agent with prior context. Messages are added before the task message.',
		},
		scope: {
			type: 'object',
			properties: {
				instructions: {
					type: 'array',
					items: { type: 'string' },
					description: 'Instruction names to include. When omitted, all instructions are visible.',
				},
				documents: {
					type: 'array',
					items: { type: 'string' },
					description: 'Document paths to include. When omitted, all documents are visible.',
				},
				images: {
					type: 'array',
					items: { type: 'string' },
					description: 'Image names to include. When omitted, all images are visible.',
				},
				messages: {
					type: 'array',
					items: { type: 'string' },
					description:
						'Message IDs to include. When omitted, all messages are visible. Use this to constrain which conversation history the child agent sees.',
				},
			},
			description:
				"Optional scope restriction for the child agent's context. Controls which instructions, documents, images, and messages are visible. Tool scoping is controlled via the top-level 'tools' parameter.",
		},
		timeout: {
			type: 'number',
			description:
				"Optional timeout in milliseconds for the child agent's execution. When the timeout expires, the agent is aborted.",
		},
		budget: {
			type: 'object',
			required: ['max'],
			properties: {
				max: {
					type: 'number',
					description: 'Maximum token count the child agent may consume.',
				},
				scope: {
					type: 'string',
					enum: ['completion', 'total'],
					description:
						'Whether the budget tracks completion tokens only (default) or total (prompt + completion).',
				},
			},
			description:
				'Optional token budget for the child agent. Aborts execution when the budget is exhausted.',
		},
		models: {
			type: 'boolean',
			description:
				'When true, returns a list of available models from the provider instead of running an agent. No task is required.',
		},
	},
}

/** JSON Schema for SandboxTool execute arguments */
export const SANDBOX_TOOL_PARAMETERS: Readonly<Record<string, unknown>> = {
	type: 'object',
	properties: {
		operation: {
			type: 'string',
			description: 'The sandbox operation to perform.',
			enum: [
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
			],
		},
		id: {
			type: 'string',
			description:
				"Sandbox id. Required for all operations except 'create' and 'list'. Returned by 'create'.",
		},
		path: {
			type: 'string',
			description:
				'File or directory path relative to the sandbox root. Required for write, read, ensure, remove, stat, has. Optional for scan and entries.',
		},
		content: {
			type: 'string',
			description:
				'File content. Required for write. Optional for ensure — when provided, creates the file with this content.',
		},
		pattern: {
			type: 'string',
			description: 'Glob pattern for filtering scan results. Used with scan.',
		},
		exclude: {
			type: 'array',
			items: { type: 'string' },
			description: 'Glob patterns for paths to exclude from scan. Used with scan.',
		},
		depth: {
			type: 'number',
			description: 'Maximum directory depth for scan. Used with scan.',
		},
		size: {
			type: 'number',
			description: 'Maximum file size in bytes for scan filtering. Used with scan.',
		},
		recursive: {
			type: 'boolean',
			description: 'Remove directories and contents recursively. Used with remove. Default: false.',
		},
		force: {
			type: 'boolean',
			description: 'Ignore errors if path does not exist. Used with remove. Default: false.',
		},
		label: {
			type: 'string',
			description: 'Optional label for the sandbox directory name. Used with create.',
		},
		symlinkNodeModules: {
			type: 'boolean',
			description:
				'Create a node_modules symlink from process.cwd(). Used with create. Default: true.',
		},
		command: {
			type: 'string',
			description: 'Command to execute within the sandbox. Required for execute.',
		},
		args: {
			type: 'array',
			items: { type: 'string' },
			description: 'Arguments passed to the command. Used with execute.',
		},
		timeout: {
			type: 'number',
			description:
				'Maximum time in milliseconds before the process is killed. Used with execute. Default: 30000.',
		},
		shell: {
			type: 'boolean',
			description: 'Run the command inside a shell. Used with execute. Default: true.',
		},
		environment: {
			type: 'object',
			additionalProperties: { type: 'string' },
			description: 'Additional environment variables for the child process. Used with execute.',
		},
	},
	required: ['operation'],
}

/** JSON Schema for PromptTool execute arguments */
export const PROMPT_TOOL_PARAMETERS: Readonly<Record<string, unknown>> = {
	type: 'object',
	properties: {
		operation: {
			type: 'string',
			description: 'The prompt operation to perform.',
			enum: [
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
			],
		},
		message: {
			type: 'string',
			description:
				'Question displayed to the user. Required for input, password, confirm, select, checkbox, editor.',
		},
		default: {
			description:
				'Default value when user submits empty input. String for input/editor, boolean for confirm, string for select, string[] for checkbox.',
		},
		mask: {
			type: 'string',
			description:
				"Character shown in place of typed characters. Used with password. Default: '*'.",
		},
		validate: {
			type: 'object',
			description:
				'Declarative validation rules. Multiple rules compose in order: required → minimum → maximum → pattern → email → url → numeric → integer → alphanumeric. The first failing rule short-circuits. Used with input, password, editor.',
			properties: {
				required: {
					type: 'boolean',
					description: 'When true, input must be non-empty after trimming.',
				},
				minimum: {
					type: 'number',
					description: 'Minimum character count (inclusive).',
				},
				maximum: {
					type: 'number',
					description: 'Maximum character count (inclusive).',
				},
				pattern: {
					type: 'string',
					description: 'Regex pattern the input must match.',
				},
				email: {
					type: 'boolean',
					description: 'When true, input must be a valid email address.',
				},
				url: {
					type: 'boolean',
					description: 'When true, input must be a valid HTTP(S) URL.',
				},
				numeric: {
					type: 'boolean',
					description: 'When true, input must be a numeric value (integer or decimal).',
				},
				integer: {
					type: 'boolean',
					description: 'When true, input must be an integer.',
				},
				alphanumeric: {
					type: 'boolean',
					description: 'When true, input must contain only letters and digits.',
				},
			},
		},
		choices: {
			type: 'array',
			items: {
				oneOf: [
					{ type: 'string' },
					{
						type: 'object',
						required: ['name', 'value'],
						properties: {
							name: { type: 'string', description: 'Display label' },
							value: { type: 'string', description: 'Value returned when chosen' },
							description: { type: 'string', description: 'Optional hint' },
							checked: { type: 'boolean', description: 'Pre-checked state for checkbox' },
						},
					},
				],
			},
			description: 'List of options. Required for select and checkbox.',
		},
		min: {
			type: 'number',
			description: 'Minimum number of selections. Used with checkbox.',
		},
		max: {
			type: 'number',
			description: 'Maximum number of selections. Used with checkbox.',
		},
		fields: {
			type: 'array',
			description:
				'Ordered list of field definitions for the form operation. Each field is prompted sequentially and results are collected into a keyed record.',
			items: {
				type: 'object',
				required: ['name', 'type', 'message'],
				properties: {
					name: {
						type: 'string',
						description: 'Key for the collected value in the result record.',
					},
					type: {
						type: 'string',
						enum: ['input', 'password', 'confirm', 'select', 'checkbox', 'editor'],
						description: 'Which prompt method to invoke for this field.',
					},
					message: { type: 'string', description: 'Question displayed to the user.' },
					default: {
						description:
							'Default value. String for input/editor, boolean for confirm, string for select, string[] for checkbox.',
					},
					validate: {
						type: 'object',
						description: 'Declarative validation rules for input, password, or editor fields.',
						properties: {
							required: { type: 'boolean' },
							minimum: { type: 'number' },
							maximum: { type: 'number' },
							pattern: { type: 'string' },
							email: { type: 'boolean' },
							url: { type: 'boolean' },
							numeric: { type: 'boolean' },
							integer: { type: 'boolean' },
							alphanumeric: { type: 'boolean' },
						},
					},
					choices: {
						type: 'array',
						items: {
							oneOf: [
								{ type: 'string' },
								{
									type: 'object',
									required: ['name', 'value'],
									properties: {
										name: { type: 'string' },
										value: { type: 'string' },
										description: { type: 'string' },
										checked: { type: 'boolean' },
									},
								},
							],
						},
						description: 'Selection options for select/checkbox fields.',
					},
					mask: { type: 'string', description: 'Mask character for password fields.' },
					min: { type: 'number', description: 'Minimum selections for checkbox fields.' },
					max: { type: 'number', description: 'Maximum selections for checkbox fields.' },
				},
			},
		},
		id: {
			type: 'string',
			description: 'Template id. Required for fill, validate, and remove.',
		},
		template: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Unique template identifier' },
				name: { type: 'string', description: 'Human-readable display name' },
				content: { type: 'string', description: 'Template body with {{placeholder}} markers' },
				placeholders: {
					type: 'array',
					items: {
						type: 'object',
						required: ['name'],
						properties: {
							name: { type: 'string', description: 'Placeholder identifier' },
							required: {
								type: 'boolean',
								description: 'Whether filling requires this value. Default: true',
							},
							value: { type: 'string', description: 'Fallback value' },
							description: { type: 'string', description: 'Hint about expected content' },
						},
					},
					description: 'Declared placeholders',
				},
				summary: { type: 'string', description: 'Short description' },
				description: { type: 'string', description: 'Extended description' },
				category: { type: 'string', description: 'Grouping label' },
				tags: { type: 'array', items: { type: 'string' }, description: 'Searchable keywords' },
			},
			required: ['id', 'name', 'content', 'placeholders'],
			description: 'Template definition. Required for register.',
		},
		values: {
			type: 'object',
			additionalProperties: { type: 'string' },
			description: 'Placeholder values keyed by name. Required for fill, optional for validate.',
		},
	},
	required: ['operation'],
}

/** JSON Schema for WorkflowTool execute arguments */
export const WORKFLOW_TOOL_PARAMETERS: Readonly<Record<string, unknown>> = {
	type: 'object',
	properties: {
		operation: {
			type: 'string',
			description: 'The workflow operation to perform.',
			enum: ['create', 'status', 'advance', 'snapshot', 'restore', 'list', 'remove'],
		},
		id: {
			type: 'string',
			description:
				'Workflow id. Required for status, advance, snapshot, and remove. Returned by create.',
		},
		name: {
			type: 'string',
			description: 'Human-readable workflow name. Used with create.',
		},
		description: {
			type: 'string',
			description: 'Workflow description. Used with create.',
		},
		phases: {
			type: 'array',
			description:
				'Phase definitions for the workflow. Used with create. Each phase has name, description, and tasks.',
			items: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Phase name.' },
					description: { type: 'string', description: 'Phase description.' },
					tasks: {
						type: 'array',
						description: 'Task definitions within this phase.',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string', description: 'Task name.' },
								description: { type: 'string', description: 'Task description.' },
								metadata: {
									type: 'object',
									additionalProperties: true,
									description: 'Optional consumer-specific metadata.',
								},
							},
						},
					},
				},
			},
		},
		taskId: {
			type: 'string',
			description: 'Task id within the workflow. Required for advance.',
		},
		action: {
			type: 'string',
			description:
				'Action to perform on a task. Required for advance. One of: start, complete, skip, block, unblock, fail, pause, resume.',
			enum: ['start', 'complete', 'skip', 'block', 'unblock', 'fail', 'pause', 'resume'],
		},
		value: {
			description:
				"Result value for the complete action. Used with advance when action is 'complete'.",
		},
		error: {
			type: 'string',
			description: "Error or block reason. Required for advance when action is 'block' or 'fail'.",
		},
		snapshot: {
			description:
				'A WorkflowSnapshot for the restore operation. Pass a snapshot id string to restore from stored snapshots, or a full snapshot object.',
		},
	},
	required: ['operation'],
}
