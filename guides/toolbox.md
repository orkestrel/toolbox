# Toolbox

> Concrete, LLM-callable tools for the `@orkestrel` line — workflow authoring, workspace editing, sub-agent delegation, terminal-mediated prompting, database and relation access, schema inference, and endpoint wrapping — over the `@orkestrel/tool` runtime, with pluggable stores.

The runtime supplies `ToolInterface`, registry execution, and result isolation; see [`tool.md`](tool.md). This package supplies the concrete behavior through one factory per tool.

`createWorkflowTool` and `createWorkspaceTool` own their full handler logic (the workflow authoring surface and the workspace editing surface respectively). The workflow tool composes opaque host `functions` plus raw live `agents` through `createWorkflowFunctions`, then forwards that frozen target registry and the optional `store` to `@orkestrel/workflow`, whose runner owns named-run drivability, checkpoint persistence, and `durable` / `fault`; the workspace tool retains its distinct manager/store composition. `createAgentTool` (sub-agent delegation over an `AgentRegistryInterface`) has its own `ConversationStoreInterface` persistence slot. The workflow, workspace, and agent tools additionally advertise a lean `summary` (`@orkestrel/tool`'s `ToolInterface.summary` / `ToolManagerInterface.definitions()` projection) in place of their full teaching `description`; `createDescribeTool` is the on-demand expansion seam. `createToolFunction` adapts an ordinary registered runtime tool, while `createAgentFunction` returns a frozen metadata-bearing adapter and uses Agent-owned `agentResultToJSON` for the exact result projection. The authoring umbrella (`WorkflowSteps` / `WorkflowDraft` shapes, `createWorkflowDraftContract`, lineage helpers, `expandSteps` / `completeDraft`, `summarizeWorkflow`, `MAX_WORKFLOW_CHAIN`) lets a small model author a whole recursion-safe tree in one call.

`createPromptTool` / `createAnswerTool` are the ask and answer halves of a terminal-mediated human-in-the-loop seam over a live `TerminalManagerInterface` (`@orkestrel/terminal`). One call asks a whole multi-field form, not a single question. `createPromptTool` takes `{ to, schema }` per call, parses the model-supplied `schema` with `@orkestrel/form`'s `parseForm`, constructs the live form with `createForm`, and blocks the calling agent turn until the addressed terminal answers (`from` fixed at construction) — resolving with one `FormValues` record keyed by field name, re-surfacing a prompt cycle as `DEADLOCK` and an unanswered expiry as `EXPIRE`. `createAnswerTool` lists the forms addressed to a fixed `to` terminal as `{ id, from, schema }` records and answers one by `{ id, values }`, narrowing the model-supplied `values` with `@orkestrel/form`'s `isFormValues` before applying it, re-surfacing a failed apply as `ANSWER`. `createTerminalRoutes` ([`src/server`](../src/server), the `@src/server` barrel) is the wire bridge for the same manager — structural `{ method, path, handler }` route records, a GET SSE stream and a POST answer over one shared `:name`-templated path, carrying no dependency on `@orkestrel/router`'s own `Route` type so a consumer mounts them against any router accepting that two-arg handler shape, and byte-compatible with `@orkestrel/terminal`'s own `PromptClient` (same GET url streams, same POST url answers, same `{ id, values }` body, same JSON answer `Result` body, same `x-orkestrel-token` header).

`createInferTool` / `createEndpointTool` bridge an existing API/DB surface into an LLM-callable `ToolInterface` over `@orkestrel/contract`'s sample-based schema inference — `createInferTool` a standalone utility a model calls to learn a JSON Schema from example values, `createEndpointTool` wrapping one concrete endpoint whose inferred `parameters` steer the model and, by default, are enforced at `execute` time (`EndpointToolOptions.validate`, default `true`; `validate: false` restores raw passthrough — see Contract invariant 23).

Source: [`src/core`](../src/core) (the tool factories) and [`src/server`](../src/server) (the terminal-routes wire bridge). Surfaced through the `@src/core` and `@src/server` barrels respectively.

## Surface

### Factories

| API                             | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createToolFunction`            | function | Wraps a registered tool as a `WorkflowFunction` (`@orkestrel/workflow`) — the opt-in adapter that lets a `function`-form task run a `@orkestrel/tool` tool by name.                                                                                                                                                                                    |
| `createAgentFunction`           | function | Wraps a live `AgentInterface` (`@orkestrel/agent`) as a `WorkflowFunction` (`@orkestrel/workflow`) — the opt-in adapter that runs the agent to a settled result and carries immutable lineage metadata for contextual Toolbox composition.                                                                                                             |
| `createWorkflowFunctions`       | function | Composes opaque host functions and raw agents into one immutable workflow registry.                                                                                                                                                                                                                                                                    |
| `createWorkflowDraftContract`   | function | Compiles the lenient workflow draft contract `createWorkflowTool` parses an authored tree with — a `ContractInterface` over a `WorkflowDraft`, whose `id` and `name` are optional at the workflow, phase, and task levels.                                                                                                                             |
| `createWorkflowTool`            | function | Wraps a `WorkflowDefinition` as an LLM-callable tool — it advertises the flat authoring shape (`{ name?, steps: [{ name }] }`) as its `parameters`, and its handler completes the authored blob, validates it against the strict contract, and runs it through `runner`, forwarding the caller's optional named functions and native checkpoint store. |
| `createWorkspaceTool`           | function | Builds an LLM-callable workspace-editing tool — it advertises the `operation`-discriminated union (`workspaceToolShape`) as its `parameters`, and its handler parses the model-supplied args against that contract and dispatches the matched operation against the manager's active workspace, returning the plain result.                            |
| `createAgentTool`               | function | Builds an LLM-callable sub-agent delegation tool — it resolves a live, seeded `AgentInterface` from `registry` and runs it to completion for one delegated `task`.                                                                                                                                                                                     |
| `createDescribeTool`            | function | Builds an LLM-callable tool that returns the full `description` of another registered tool by name — the counterpart to the lean `summary` the other tools in this package advertise.                                                                                                                                                                  |
| `createPromptTool`              | function | Builds an LLM-callable form tool — the ask side of the terminal seam. It asks a multi-field form and blocks until the addressed terminal answers, returning the resolved values record.                                                                                                                                                                |
| `createAnswerTool`              | function | Builds an LLM-callable answer tool — the answer side of the terminal seam. It lists the forms addressed to `AnswerToolOptions.to`, or answers one of them by id.                                                                                                                                                                                       |
| `createDatabaseTool`            | function | Builds an LLM-callable database tool — it creates, queries, and mutates `@orkestrel/database` databases through one `operation`-discriminated call (matching `createWorkspaceTool`'s single-tool-many-operations shape).                                                                                                                               |
| `createRelationTool`            | function | Builds an LLM-callable relation tool — it traverses and edits `@orkestrel/relation` relationships through one `operation`-discriminated call (matching `createDatabaseTool`'s single-tool-many-operations shape).                                                                                                                                      |
| `createMemoryDefinitionStore`   | function | Creates the in-memory `DefinitionStoreInterface` — a process-lifetime `Map` of database definitions, the default store the database and relation tools persist their `DatabaseDefinition` configs through.                                                                                                                                             |
| `createDatabaseDefinitionStore` | function | Creates a `DefinitionStoreInterface` backed by one table of the `@orkestrel/database` layer — the driver-pluggable twin of `createMemoryDefinitionStore`, storing each database's definition as one opaque JSON column.                                                                                                                                |
| `createInferTool`               | function | Builds a standalone LLM-callable tool that infers a JSON Schema from example values — the utility half of the bridge from an existing API or database into an MCP tool (the other half, `createEndpointTool`, wraps one concrete endpoint).                                                                                                            |
| `createEndpointTool`            | function | Wraps one concrete endpoint (`EndpointDefinition`) as an LLM-callable `ToolInterface` — the endpoint half of the bridge from an existing API or database into an MCP tool (the other half, `createInferTool`, is a standalone inference utility).                                                                                                      |

### Stores

Concrete `DefinitionStoreInterface` implementations (AGENTS' Stores rule, point-access mold): `MemoryDefinitionStore` the in-memory default, `DatabaseDefinitionStore` the driver-pluggable twin over one `@orkestrel/database` table. They implement the same `get` / `set` / `delete` contract over different backing storage, and differ within it: the memory store copies on write and on read, while the table-backed store narrows an untrusted stored blob and reports `undefined` for a malformed one.

| API                       | Kind  | Summary                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryDefinitionStore`   | class | Represents the in-memory `DefinitionStoreInterface` — a process-lifetime `Map` of `DatabaseDefinition`s keyed by database id, the default store `createMemoryDefinitionStore` builds. It implements the same `DefinitionStoreInterface` contract as `DatabaseDefinitionStore`: this store copies on write and on read; the table-backed store narrows an untrusted stored blob and reports `undefined` for a malformed one. |
| `DatabaseDefinitionStore` | class | Represents a `DefinitionStoreInterface` backed by one table of the `@orkestrel/database` layer — a database's durable config state is a row, so persistence reduces to keyed point-access (`get` / `set` / `delete`) over a `TableInterface`, the driver-pluggable twin of the plain-`Map` `MemoryDefinitionStore`.                                                                                                         |

### Resolvers

`DatabaseResolver` is the implementation class a consumer composes directly. The factories
`createDatabaseTool` and `createTerminalRoutes` remain the compact entry points.

| API                | Kind  | Summary                                                                                                                                                                                 |
| ------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DatabaseResolver` | class | Resolves a database definition into a cached live handle for a database tool, over the tool's live handles, its stored definitions, its driver registry, and an optional key generator. |

### Errors

| API              | Kind     | Summary                                                                                                                                                                                                                                                                          |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ToolboxError`   | class    | Represents a package-owned tool-call failure: malformed input or unresolved configuration (`TOOL`), delegation depth/cycle rejection (`DEPTH`), prompt failure (`DEADLOCK` / `EXPIRE` / `ANSWER`), or a translated upstream database/relation failure (`DATABASE` / `RELATION`). |
| `isToolboxError` | function | Narrows an unknown caught value to a `ToolboxError`.                                                                                                                                                                                                                             |

### Validators

The total `(value: unknown) => value is T` guards this package applies at its untrusted boundaries — an authored lineage, a frozen agent adapter, the small-model column DSL, and a persisted database definition read back from a store.

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`. In a guard table a `Shape` cell holds the type the guard narrows to.

| API                    | Kind     | Shape                | Summary                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | -------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isWorkflowLineage`    | function | `WorkflowLineage`    | Narrows an unknown value to a valid alternating workflow lineage.                                                                                                                                                                                                                                                                                                                               |
| `isAgentFunction`      | function | `AgentFunction`      | Narrows an unknown callable to Toolbox's frozen contextual agent adapter metadata.                                                                                                                                                                                                                                                                                                              |
| `isColumnPrimitive`    | function | `ColumnPrimitive`    | Narrows an unknown value to a `ColumnPrimitive`.                                                                                                                                                                                                                                                                                                                                                |
| `isColumnSpec`         | function | `ColumnSpec`         | Narrows an unknown value to a `ColumnSpec`.                                                                                                                                                                                                                                                                                                                                                     |
| `isDatabaseDefinition` | function | `DatabaseDefinition` | Narrows an unknown value to a `DatabaseDefinition` — a non-empty `id` and `driver`, a `tables` record whose every value is `{ columns: record of valid ColumnSpec }`, plus optional `primary`, `indexes`, and finite `version` schema configuration. The boundary guard a `DefinitionStoreInterface` applies to an untrusted persisted blob before trusting it as a definition (never an `as`). |

### Helpers

Pure, side-effect-free, exhaustively unit-tested under AGENTS' export-and-test-reusable-logic law and narrow-untrusted-input-with-guards rule — the lenient-authoring synthesis path and the ancestry tags `createAgentTool` and `createAgentFunction` share.

| API                      | Kind     | Summary                                                                                                                                                                                                                                                     |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tagWorkflow`            | function | Returns the ancestry identifier of a workflow in a run chain — `workflow:<id>`.                                                                                                                                                                             |
| `tagAgent`               | function | Returns the ancestry identifier of an agent in a run chain — `agent:<name>`.                                                                                                                                                                                |
| `summarizeWorkflow`      | function | Builds the plain success summary `createWorkflowTool` returns on a completed run — the universal tool-handler contract: return a plain value on success, appearing identically over both the agent loop and MCP.                                            |
| `extendLineage`          | function | Appends one tag to a workflow lineage and returns a frozen copy.                                                                                                                                                                                            |
| `normalizeLineage`       | function | Returns the canonical workflow lineage — validated, copied, and frozen.                                                                                                                                                                                     |
| `deriveWorkflowDepth`    | function | Derives the zero-based workflow nesting depth from a valid lineage.                                                                                                                                                                                         |
| `completeDraft`          | function | Completes a `WorkflowDraft` into a strict `WorkflowDefinition` — synthesizes a missing `id` deterministically and positionally, and defaults a missing `name` to its resolved `id`.                                                                         |
| `completePhaseDraft`     | function | Completes one `PhaseDraft` into a strict phase definition — the per-phase step of `completeDraft` (phase `index` → `phase-<index>` when its id is omitted).                                                                                                 |
| `completeTaskDraft`      | function | Completes one `TaskDraft` into a strict task definition — the per-task leaf step of `completeDraft` (task `index` of phase `<phaseId>` → `<phaseId>-task-<index>` when its id is omitted).                                                                  |
| `expandSteps`            | function | Expands a flat `WorkflowSteps` blob into a strict `WorkflowDefinition` — each step becomes a one-task phase, in order.                                                                                                                                      |
| `inferTerminalCode`      | function | Maps a caught error to the `ToolboxErrorCode` the terminal-tool factory throws with — the pure classification step of that factory's error handling.                                                                                                        |
| `inferDatabaseCode`      | function | Maps a caught error to the granular `DatabaseErrorCode` (`@orkestrel/database`) the code `createDatabaseTool` throws with — the pure classification step of that factory's error handling, mirroring `inferTerminalCode`'s idiom for `@orkestrel/database`. |
| `inferRelationCode`      | function | Maps a caught error to the granular `RelationErrorCode` (`@orkestrel/relation`) the code `createRelationTool` throws with — the pure classification step of that factory's error handling, mirroring `inferTerminalCode`'s idiom for `@orkestrel/relation`. |
| `expandInclude`          | function | Expands the relation tool's flat dot-path `include` list into a live `@orkestrel/relation` `Include` tree — the pure leaf `createRelationTool` calls before a `'load'` / `'find'` call.                                                                     |
| `resolveRelationManager` | function | Resolves which registered `RelationManagerInterface` a relation-tool call addresses — the pure manager-resolution leaf `createRelationTool` calls on every operation.                                                                                       |
| `resolveRelationModel`   | function | Resolves a `model` name against a live `RelationManagerInterface` — the pure model-lookup leaf `createRelationTool` calls on every operation, mirroring `resolveRelationManager`'s guard shape.                                                             |
| `clampQuery`             | function | Clamps a `'records'` call's query to a row cap, and builds the probe query the caller reads with — the pure leaf `createDatabaseTool`'s `'records'` operation uses to detect truncation without a separate `count` round trip.                              |
| `resolveLimit`           | function | Picks the effective row limit a tool reads with — the requested count when it sits inside the cap, the cap when it exceeds it, and `0` when either falls below zero.                                                                                        |
| `normalizeQuery`         | function | Returns the canonical live `@orkestrel/database` `QueryInput` for the database tool's parsed serialized query — each condition's omitted `connector` defaults to `'and'`.                                                                                   |

### Compilers

The `TableSpec` column DSL compiled into the live `@orkestrel/database` `TableMap` a `createDatabase` call accepts — one composite walk over the spec, and the `compileColumn` / `compileColumnPrimitive` leaves it maps with.

| API                      | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expandTables`           | function | Compiles a `TableSpec` into the `@orkestrel/database` `TableMap` it configures — each `ColumnSpec` maps to the matching primitive shaper (`'string'` → `stringShape()`, `'integer'` → `integerShape()`, `'number'` → `numberShape()`, `'boolean'` → `booleanShape()`), wrapped in `optionalShape` when the column declares `optional: true`. Total, pure. |
| `compileColumn`          | function | Compiles one `ColumnSpec` into its `@orkestrel/database` column shape — the per-column leaf `expandTables` maps over.                                                                                                                                                                                                                                     |
| `compileColumnPrimitive` | function | Compiles one `ColumnPrimitive` into its primitive `@orkestrel/database` shape — the leaf `compileColumn` wraps.                                                                                                                                                                                                                                           |

### Shapes

The shape values each `create*Tool` factory (and `createWorkflowDraftContract`) compiles into the lockstep guard / parser / JSON Schema outputs under AGENTS' narrow-untrusted-input-with-guards rule; `agentToolShape` agrees with the hand-written `AgentToolArguments`, the source of truth.

A `Shape` cell holds the constant's declared type.

| API                    | Kind  | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Summary                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agentToolShape`       | const | `ObjectShape<{ task, provider?, tools?, system? }>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Describes the shape of `AgentToolArguments` — `createAgentTool`'s advertised `parameters`.                                                                                                                                                                                                                                                                                                                                           |
| `taskDraftShape`       | const | `ObjectShape<{ id?, name?, description?, behavior?, retries?, timeout? }>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Describes the shape of a `TaskDraft` — identical to a strict task shape except that `id` and `name` are optional.                                                                                                                                                                                                                                                                                                                    |
| `phaseDraftShape`      | const | `ObjectShape<{ id?, name?, description?, tasks, concurrency?, bail? }>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Describes the shape of a phase in a draft workflow — identical to a strict phase shape except that `id` and `name` are optional and each task takes `taskDraftShape`.                                                                                                                                                                                                                                                                |
| `workflowDraftShape`   | const | `ObjectShape<{ id?, name?, description?, phases, bail? }>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Describes the shape of a draft workflow — identical to a strict workflow shape except that `id` and `name` are optional at the workflow, phase, and task levels, so a small model can omit every identity string and let the tool synthesize them positionally.                                                                                                                                                                      |
| `stepShape`            | const | `ObjectShape<{ name }>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Describes the shape of one flat step — `{ name }` — the building block of `workflowStepsShape`.                                                                                                                                                                                                                                                                                                                                      |
| `workflowStepsShape`   | const | `ObjectShape<{ name?, steps }>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Describes the flat authoring shape `createWorkflowTool` advertises as its `parameters` — the simplest surface a small model can fill: `{ name?, steps: [{ name }] }`.                                                                                                                                                                                                                                                                |
| `workspaceToolShape`   | const | `UnionShape<[{ operation: 'read', path }, { operation: 'list' }, { operation: 'has', path }, { operation: 'search', query, regex?, sensitive?, limit? }, { operation: 'replace', query, replacement, regex?, sensitive?, limit? }, { operation: 'write', path, content }, { operation: 'splice', path, content, fromLine, fromColumn, toLine, toColumn }, { operation: 'prepend', path, content }, { operation: 'append', path, content }, { operation: 'move', from, to }, { operation: 'remove', path }, { operation: 'workspaces' }, { operation: 'switch', id }]>` | Describes the shape of a `WorkspaceOperation` — a descriptive tagged union over the workspace edit, read, and navigation operations, discriminated by the `operation` literal (never a bare `kind`). Each variant leads with its `operation` discriminant then its flat fields, every field through `stringShape` / `optionalShape` / `integerShape({ min: 1 })` / `booleanShape`, each carrying a strong field-level `description`. |
| `describeToolShape`    | const | `ObjectShape<{ name }>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Describes the shape of `DescribeToolArguments` — `createDescribeTool`'s advertised `parameters`.                                                                                                                                                                                                                                                                                                                                     |
| `promptToolShape`      | const | `ObjectShape<{ to, schema }>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Describes the shape of `createPromptTool`'s call arguments — `to` names the terminal identity and `schema` carries the complete multi-field form document.                                                                                                                                                                                                                                                                           |
| `answerToolShape`      | const | `UnionShape<[{ operation: 'pending' }, { operation: 'answer', id, values }]>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Describes the shape of `createAnswerTool`'s call arguments — discriminated by `operation`: `'pending'` lists the forms addressed to this tool's terminal, while `'answer'` resolves one by `id` with a complete `values` record.                                                                                                                                                                                                     |
| `databaseToolShape`    | const | `UnionShape<[{ operation: 'create', id, tables, driver?, primary?, indexes?, version? }, { operation: 'tables', id }, { operation: 'get', id, table, key }, { operation: 'records', id, table, query? }, { operation: 'count', id, table, query? }, { operation: 'aggregate', id, table, function, column, query? }, { operation: 'add', id, table, row }, { operation: 'set', id, table, row }, { operation: 'update', id, table, key, changes }, { operation: 'remove', id, table, key }, { operation: 'destroy', id }]>`                                            | Describes the shape of `createDatabaseTool`'s call arguments — discriminated by `operation` into the database operations `'create'`, `'tables'`, `'get'`, `'records'`, `'count'`, `'aggregate'`, `'add'`, `'set'`, `'update'`, `'remove'`, and `'destroy'`.                                                                                                                                                                          |
| `columnPrimitiveShape` | const | `LiteralShape<'string' \| 'integer' \| 'number' \| 'boolean'>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Describes a `ColumnPrimitive` literal — the leaf `columnSpecShape` wraps.                                                                                                                                                                                                                                                                                                                                                            |
| `columnSpecShape`      | const | `UnionShape<[columnPrimitiveShape, { primitive, optional? }]>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Describes a `ColumnSpec` — a bare `columnPrimitiveShape`, or `{ primitive, optional }`.                                                                                                                                                                                                                                                                                                                                              |
| `tableSpecShape`       | const | `ObjectShape<Record<never, never>, ObjectShape<{ columns }>>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Describes a `TableSpec` — table name to `{ columns }`, each column a `columnSpecShape`.                                                                                                                                                                                                                                                                                                                                              |
| `keyShape`             | const | `UnionShape<[ArrayShape<UnionShape<[StringShape, NumberShape]>>, StringShape, NumberShape]>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Describes one key value for the database tool and the relation tool — a string or number; the array form (multiple keys, positional) resolves first, so an array argument is read as many keys rather than one.                                                                                                                                                                                                                      |
| `rowShape`             | const | `ObjectShape<Record<never, never>, JSONShape>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Describes a loose row — a flat object of column name to JSON value.                                                                                                                                                                                                                                                                                                                                                                  |
| `rowsShape`            | const | `UnionShape<[ArrayShape<rowShape>, rowShape]>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Describes one or many loose rows — the array form resolves first, so an array argument is read as many rows rather than one.                                                                                                                                                                                                                                                                                                         |
| `conditionShape`       | const | `ObjectShape<{ column, operator, values, connector? }>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Describes one serialized where condition — `values` is always an array, even for a single-value operator.                                                                                                                                                                                                                                                                                                                            |
| `orderShape`           | const | `ObjectShape<{ column, direction }>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Describes one sort term — a `column` to sort by and the `direction` to sort it in.                                                                                                                                                                                                                                                                                                                                                   |
| `queryShape`           | const | `ObjectShape<{ conditions?, order?, limit?, offset? }>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Describes the serialized query form — conditions, order, and pagination.                                                                                                                                                                                                                                                                                                                                                             |
| `relationToolShape`    | const | `UnionShape<[{ operation: 'load', manager?, model, key, include? }, { operation: 'find', manager?, model, include?, limit?, offset?, sort?, direction? }, { operation: 'link', manager?, model, key, relation, target }, { operation: 'unlink', manager?, model, key, relation, target }, { operation: 'links', manager?, model, key, relation }]>`                                                                                                                                                                                                                    | Describes the shape of `createRelationTool`'s call arguments — discriminated by `operation` into the relation operations `'load'`, `'find'`, `'link'`, `'unlink'`, and `'links'`.                                                                                                                                                                                                                                                    |
| `singleKeyShape`       | const | `UnionShape<[StringShape, NumberShape]>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Describes a single row key (not an array) — used by `'link'` / `'unlink'` / `'links'`, which address exactly one owning row.                                                                                                                                                                                                                                                                                                         |
| `includeShape`         | const | `OptionalShape<ArrayShape<StringShape>>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Describes the flat dot-path relation include list, expanded through `expandInclude`.                                                                                                                                                                                                                                                                                                                                                 |
| `managerShape`         | const | `OptionalShape<StringShape>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Describes which registered relation manager to address — omitted resolves to the sole registered manager.                                                                                                                                                                                                                                                                                                                            |
| `inferToolShape`       | const | `ObjectShape<{ samples, format?, enum?, candidates? }>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Describes the shape of `createInferTool`'s call arguments — one or more example `samples` to infer a JSON Schema from, plus per-call `format` / `enum` toggles and an optional `candidates` array to check against the inferred schema.                                                                                                                                                                                              |

### Constants

A `Shape` cell holds the constant's declared type.

| Constant                       | Kind  | Shape                | Summary                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ----- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_TOOL_NAME`              | const | `string`             | Holds the name `createAgentTool` advertises by default, `'agent'` — the key a model calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under.                                                                                                                                  |
| `AGENT_TOOL_DEPTH`             | const | `number`             | Holds the maximum nesting depth a delegation chain (agent tool → sub-agent → agent tool → …) may reach, `8` — the bound `createAgentTool`'s depth/cycle guard enforces.                                                                                                                        |
| `AGENT_TOOL_DESCRIPTION`       | const | `string`             | Holds the description `createAgentTool` advertises — a short guide covering the required task and optional provider, tools, and system overrides.                                                                                                                                              |
| `AGENT_TOOL_SUMMARY`           | const | `string`             | Holds the lean `ToolInterface.summary` `createAgentTool` advertises in place of `AGENT_TOOL_DESCRIPTION` — one sentence offering sub-agent delegation and pointing at `describe` for the optional overrides.                                                                                   |
| `MAX_WORKFLOW_CHAIN`           | const | `number`             | Holds the maximum nesting depth a workflow → agent → workflow chain may reach, `8` — the bound `createAgentFunction` and `createWorkflowTool`'s depth/cycle guards enforce.                                                                                                                    |
| `WORKFLOW_TOOL_NAME`           | const | `string`             | Holds the name `createWorkflowTool` advertises by default, `'workflow'` — the key a model calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under, and the name `createAgentFunction` binds the depth/cycle-aware workflow tool under onto a wrapped agent's `context.tools`. |
| `WORKFLOW_TOOL_FLAT_EXAMPLE`   | const | `WorkflowSteps`      | Holds a complete flat authoring example — the primary way a small model authors a workflow through `createWorkflowTool`: `{ name, steps: [{ name }] }`.                                                                                                                                        |
| `WORKFLOW_TOOL_NESTED_EXAMPLE` | const | `WorkflowDefinition` | Holds a minimal nested authoring example — the advanced escape-hatch form a model can use instead of the flat shape: a full `WorkflowDefinition` (`@orkestrel/workflow`).                                                                                                                      |
| `WORKFLOW_TOOL_DESCRIPTION`    | const | `string`             | Holds the description `createWorkflowTool` advertises — the flat authoring form, its worked example, and the advanced nested definition form.                                                                                                                                                  |
| `WORKFLOW_TOOL_SUMMARY`        | const | `string`             | Holds the lean `ToolInterface.summary` `createWorkflowTool` advertises in place of `WORKFLOW_TOOL_DESCRIPTION` — one sentence offering multi-phase authoring and pointing at `describe` for the authoring schema and its examples.                                                             |
| `WORKSPACE_TOOL_NAME`          | const | `string`             | Holds the name `createWorkspaceTool` advertises by default, `'workspace'` — the key a model calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under.                                                                                                                          |
| `WORKSPACE_TOOL_EXAMPLE`       | const | `WorkspaceOperation` | Holds a valid `WorkspaceOperation` object — the canonical example embedded verbatim in `WORKSPACE_TOOL_DESCRIPTION`.                                                                                                                                                                           |
| `WORKSPACE_TOOL_DESCRIPTION`   | const | `string`             | Holds the description `createWorkspaceTool` advertises — the operation-keyed workspace protocol, all supported operations, and worked examples.                                                                                                                                                |
| `WORKSPACE_TOOL_SUMMARY`       | const | `string`             | Holds the lean `ToolInterface.summary` `createWorkspaceTool` advertises in place of `WORKSPACE_TOOL_DESCRIPTION` — one sentence offering the `operation`-keyed file editing and pointing at `describe` for the operation list and its fields.                                                  |
| `DESCRIBE_TOOL_NAME`           | const | `string`             | Holds the name `createDescribeTool` advertises by default, `'describe'` — the key a model calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under.                                                                                                                            |
| `DESCRIBE_TOOL_SUMMARY`        | const | `string`             | Holds the lean `ToolInterface.summary` `createDescribeTool` advertises — this tool needs no teaching of its own, so its summary and description are both short.                                                                                                                                |
| `DESCRIBE_TOOL_DESCRIPTION`    | const | `string`             | Holds the description `createDescribeTool` advertises — the registered tool `name` it requires, and the full description of that tool it returns.                                                                                                                                              |
| `PROMPT_TOOL_NAME`             | const | `string`             | Holds the name `createPromptTool` advertises by default, `'ask'` — the key a model calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under.                                                                                                                                   |
| `PROMPT_TOOL_SUMMARY`          | const | `string`             | Holds the lean `ToolInterface.summary` `createPromptTool` advertises in place of `PROMPT_TOOL_DESCRIPTION` — one sentence offering the blocking multi-field ask and pointing at `describe` for the schema.                                                                                     |
| `PROMPT_TOOL_DESCRIPTION`      | const | `string`             | Holds the form protocol `createPromptTool` advertises — the required `to` and `schema`, how a field declares its control and its rules, and a worked example.                                                                                                                                  |
| `ANSWER_TOOL_NAME`             | const | `string`             | Holds the name `createAnswerTool` advertises by default, `'answer'` — the key a model calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under.                                                                                                                                |
| `ANSWER_TOOL_SUMMARY`          | const | `string`             | Holds the lean `ToolInterface.summary` `createAnswerTool` advertises in place of `ANSWER_TOOL_DESCRIPTION` — one sentence offering the pending listing and the answer call, and pointing at `describe` for the fields each takes.                                                              |
| `ANSWER_TOOL_DESCRIPTION`      | const | `string`             | Holds the protocol `createAnswerTool` advertises — the `pending` and `answer` operations and the `values` record an answer supplies, each with a worked example.                                                                                                                               |
| `DATABASE_TOOL_NAME`           | const | `string`             | Holds the name `createDatabaseTool` advertises by default, `'database'` — the key a model calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under.                                                                                                                            |
| `DATABASE_TOOL_SUMMARY`        | const | `string`             | Holds the lean `ToolInterface.summary` `createDatabaseTool` advertises in place of `DATABASE_TOOL_DESCRIPTION` — one sentence offering the `operation`-keyed database call and pointing at `describe` for the operation list, the query form, and the column DSL.                              |
| `DATABASE_TOOL_DESCRIPTION`    | const | `string`             | Holds the description `createDatabaseTool` advertises — a multi-line guide that teaches a small model the operation list, the serialized query form, and the `TableSpec` column DSL.                                                                                                           |
| `DATABASE_TOOL_LIMIT`          | const | `number`             | Holds the default cap on rows a `records` call returns when the caller omits `query.limit`, `1000` — the database tool's default row ceiling.                                                                                                                                                  |
| `DATABASE_TOOL_MUTATIONS`      | const | `readonly string[]`  | Lists the runtime-frozen database-tool mutation names disabled by `DatabaseToolOptions.readonly`.                                                                                                                                                                                              |
| `RELATION_TOOL_NAME`           | const | `string`             | Holds the name `createRelationTool` advertises by default, `'relation'` — the key a model calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under.                                                                                                                            |
| `RELATION_TOOL_SUMMARY`        | const | `string`             | Holds the lean `ToolInterface.summary` `createRelationTool` advertises in place of `RELATION_TOOL_DESCRIPTION` — one sentence offering the `operation`-keyed relationship traversal and pointing at `describe` for the include-path syntax.                                                    |
| `RELATION_TOOL_DESCRIPTION`    | const | `string`             | Holds the description `createRelationTool` advertises — a multi-line guide that teaches a small model the operation list and the flat dot-path `include` syntax.                                                                                                                               |
| `RELATION_TOOL_LIMIT`          | const | `number`             | Holds the default cap on rows a `find` or `links` call returns when the caller omits `limit`, `1000` — the relation tool's default row ceiling.                                                                                                                                                |
| `RELATION_TOOL_DEPTH`          | const | `number`             | Holds the default cap on how many `include` path segments deep a `load` or `find` call may traverse, `3` — the relation tool's default include-depth ceiling.                                                                                                                                  |
| `INFER_TOOL_NAME`              | const | `string`             | Holds the name `createInferTool` advertises by default, `'infer'` — the key a model calls and the `ToolManagerInterface` (`@orkestrel/tool`) registers under.                                                                                                                                  |
| `INFER_TOOL_SUMMARY`           | const | `string`             | Holds the lean `ToolInterface.summary` `createInferTool` advertises in place of `INFER_TOOL_DESCRIPTION` — one sentence offering schema inference from example values and pointing at `describe` for the fields it takes.                                                                      |
| `INFER_TOOL_DESCRIPTION`       | const | `string`             | Holds the schema-inference protocol `createInferTool` advertises — the required `samples`, the optional `format`, `enum`, and `candidates` arguments, and a worked example of the bare return and of the `candidates`-wrapped return.                                                          |

### Types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`.

| Type                       | Kind      | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Summary                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskDraft`                | interface | `{ id?, name?, description?, behavior?, retries?, timeout? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Represents a draft task — a `TaskDefinition` (`@orkestrel/workflow`) with optional `id` and `name`.                                                                                                                                                                                                                                                       |
| `PhaseDraft`               | interface | `{ id?, name?, description?, tasks, concurrency?, bail? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents a draft phase — a `PhaseDefinition` (`@orkestrel/workflow`) with optional `id` and `name` and `TaskDraft` tasks.                                                                                                                                                                                                                               |
| `WorkflowDraft`            | interface | `{ id?, name?, description?, phases, bail? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Represents a draft workflow — a `WorkflowDefinition` (`@orkestrel/workflow`) with optional `id` and `name` at the workflow, phase, and task levels.                                                                                                                                                                                                       |
| `WorkflowStep`             | interface | `{ name }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents one flat step — `{ name }` — the building block of a `WorkflowSteps` blob.                                                                                                                                                                                                                                                                     |
| `WorkflowSteps`            | interface | `{ name?, steps }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Represents the flat authoring blob `createWorkflowTool` advertises — `{ name?, steps }` — the simplest surface a small model can fill.                                                                                                                                                                                                                    |
| `WorkflowToolResult`       | interface | `{ status, count, durable?, fault? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Represents the JSON-safe run summary returned by `createWorkflowTool`.                                                                                                                                                                                                                                                                                    |
| `WorkflowLineage`          | type      | `readonly string[]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Represents one immutable workflow/agent call chain — strictly alternating tags, each unique, beginning with a workflow tag.                                                                                                                                                                                                                               |
| `WorkflowAgents`           | type      | `Readonly<Record<string, AgentInterface>>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents raw live agents keyed by the workflow function names that invoke them.                                                                                                                                                                                                                                                                         |
| `AgentFunction`            | type      | `WorkflowFunction & { category, lineage }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents a contextual agent adapter carrying immutable metadata for Toolbox composition.                                                                                                                                                                                                                                                                |
| `AgentFunctionOptions`     | interface | `{ runner?, lineage?, functions?, agents?, store? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Represents the options for `createAgentFunction` — the opt-in adapter that wraps a live `AgentInterface` (`@orkestrel/agent`) as an `AgentFunction` with immutable lineage metadata and optional nested-workflow composition.                                                                                                                             |
| `WorkflowToolOptions`      | interface | `{ lineage?, functions?, agents?, store? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Represents the options for `createWorkflowTool` and `createWorkflowFunctions` — lineage-aware composition of opaque leaves, raw agents, and native workflow persistence.                                                                                                                                                                                  |
| `WorkspaceToolOptions`     | interface | `{ name?, description?, manager?, store? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Represents the options for `createWorkspaceTool` — either a caller-built `WorkspaceManagerInterface` to drive directly, or a `WorkspaceStoreInterface` the tool constructs a fresh manager over; neither given constructs a manager over `@orkestrel/workspace`'s in-memory store.                                                                        |
| `WorkspaceOperation`       | type      | `{ operation: 'read', path } \| { operation: 'list' } \| { operation: 'has', path } \| { operation: 'search', query, regex?, sensitive?, limit? } \| { operation: 'replace', query, replacement, regex?, sensitive?, limit? } \| { operation: 'write', path, content } \| { operation: 'splice', path, content, fromLine, fromColumn, toLine, toColumn } \| { operation: 'prepend', path, content } \| { operation: 'append', path, content } \| { operation: 'move', from, to } \| { operation: 'remove', path } \| { operation: 'workspaces' } \| { operation: 'switch', id }` | Represents one operation an agent invokes through `createWorkspaceTool` — a flat, descriptive tagged union over the workspace edit, read, and navigation actions, discriminated by the `operation` literal (a discriminant is named for its axis — the action being performed — never `kind`).                                                            |
| `AgentToolOptions`         | interface | `{ name?, description?, provider?, tools?, system?, depth?, ancestry?, store? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Represents the options for `createAgentTool` — the sub-agent delegation defaults, the nesting-depth / cycle guard bookkeeping, and the advertised tool overrides.                                                                                                                                                                                         |
| `AgentToolArguments`       | interface | `{ task, provider?, tools?, system? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Represents the flat args `createAgentTool` accepts — a delegated `task` plus the minimal optional `AgentJobInput` (`@orkestrel/agent`) fields a caller may override per-call.                                                                                                                                                                             |
| `ToolboxErrorCode`         | type      | `'TOOL' \| 'DEPTH' \| 'DEADLOCK' \| 'EXPIRE' \| 'ANSWER' \| 'DATABASE' \| 'RELATION'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Represents the machine-readable code a thrown `ToolboxError` carries — a thrown, typed, code-bearing error, never a `{ error }` return.                                                                                                                                                                                                                   |
| `DescribeToolArguments`    | interface | `{ name }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents the flat args `createDescribeTool` accepts — the registered tool `name` whose full `description` a model wants back.                                                                                                                                                                                                                           |
| `PromptToolOptions`        | interface | `{ manager, from, name?, description? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Represents the options for `createPromptTool` — the live `TerminalManagerInterface` (`@orkestrel/terminal`) to `ask` through, the terminal name `from`, and the advertised tool overrides.                                                                                                                                                                |
| `AnswerToolOptions`        | interface | `{ manager, to, name?, description? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Represents the options for `createAnswerTool` — the live `TerminalManagerInterface` (`@orkestrel/terminal`) to list / answer prompts through, the terminal name `to`, and the advertised tool overrides.                                                                                                                                                  |
| `ColumnPrimitive`          | type      | `'string' \| 'integer' \| 'number' \| 'boolean'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Represents one column's declared primitive — a shorthand, or `integer` for a whole-number `number`.                                                                                                                                                                                                                                                       |
| `ColumnSpec`               | type      | `ColumnPrimitive \| { primitive, optional? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Represents one table column's spec — either a bare `ColumnPrimitive` shorthand, or `{ primitive, optional }` when the column may be absent from a row.                                                                                                                                                                                                    |
| `TableSpec`                | type      | `Readonly<Record<string, { columns }>>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Represents a database's table layout — one entry per table, each a flat map of column name to `ColumnSpec`. The small-model-facing DSL `expandTables` compiles into an `@orkestrel/database` `TableMap`.                                                                                                                                                  |
| `DatabaseDefinition`       | interface | `{ id, driver, tables, primary?, indexes?, version? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Represents one database's config-only definition — an `id`, a `driver`, and a `TableSpec`, with optional `primary`, `indexes`, and `version` schema configuration.                                                                                                                                                                                        |
| `DatabaseDefinitionRow`    | interface | `{ id, definition }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Represents one opaque persisted row — the shape a definition-row-backed `TableInterface` store reads/writes; `definition` is narrowed with `isDatabaseDefinition` on read.                                                                                                                                                                                |
| `DefinitionStoreInterface` | interface | `{} plus get, set, delete`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents the point-access persistence seam for `DatabaseDefinition` configs — the twin of `@orkestrel/terminal`'s `TerminalStoreInterface`, storing a database's config-only blueprint rather than a live handle. Every primitive is async; `delete` of an absent id is a no-op.                                                                        |
| `DatabaseQueryInput`       | interface | `{ conditions?, order?, limit?, offset? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents the serialized wire query a database-tool call carries — the parsed form of `queryShape`, which `normalizeQuery` normalizes into a live `@orkestrel/database` `QueryInput`.                                                                                                                                                                    |
| `ClampedQuery`             | interface | `{ query, limit }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Represents the probe query and effective row limit `clampQuery` returns.                                                                                                                                                                                                                                                                                  |
| `DatabaseToolOptions`      | interface | `{ name?, description?, databases?, store?, drivers?, generator?, limit?, timeout?, readonly? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Represents the options for `createDatabaseTool` — the live handles, definition store, driver registry, key generator, row cap, timeout, and readonly gate the tool composes.                                                                                                                                                                              |
| `RelationToolOptions`      | interface | `{ name?, description?, managers, limit?, depth? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Represents the options for `createRelationTool` — the required live `RelationManagerInterface` registry a call addresses, the row cap, and the `include` depth cap.                                                                                                                                                                                       |
| `InferToolOptions`         | interface | `{ name?, description? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Represents the options for `createInferTool` — advertised name and description overrides only; `format` and `enum` are runtime call arguments (see `inferToolShape`), not construction-time options, because a model chooses them per call.                                                                                                               |
| `EndpointHandler`          | type      | `(args: Readonly<Record<string, unknown>>) => Promise<unknown> \| unknown`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Represents the handler `EndpointDefinition.execute` implements — it mirrors `@orkestrel/tool`'s `ToolOptions.execute` signature exactly (the same `Readonly<Record<string, unknown>>` argument, the same `Promise<unknown> \| unknown` return), so `execute: (args) => definition.execute(args)` typechecks with zero assertions in `createEndpointTool`. |
| `EndpointDefinition`       | interface | `{ name, description, samples, execute }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Represents one concrete endpoint `createEndpointTool` wraps as an LLM-callable `ToolInterface` — the advertised identity, a non-empty set of example values its `parameters` are inferred from, and the local handler that runs a call.                                                                                                                   |
| `EndpointToolOptions`      | interface | `{ format?, enum?, validate? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Represents the construction-time tuning for `createEndpointTool` — the inferred `parameters` schema's `format` and `enum` constraints, and whether that same schema is enforced at `execute` time.                                                                                                                                                        |

### Server routes

The wire bridge for a `TerminalManagerInterface` — a GET SSE stream and a POST answer endpoint, both mounted on the same `:name`-templated path, returned as plain structural records carrying no dependency on `@orkestrel/router`'s own `Route` type ([`src/server`](../src/server), surfaced through `@src/server`).

The POST endpoint takes `{ id, values }`, admits the body only when `id` is a nonempty string and `values` passes `@orkestrel/form`'s `isFormValues`, and returns the manager's own answer `Result` as a JSON body — `200` accepted, `422` an `'unknown'` / `'rejected'` outcome, `404` a `'target'` outcome. The body is what carries a rejection's per-field `errors` back to the answering client, so `PromptClient` can re-render the failed fields instead of guessing from a status code.

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`. A function row's `Shape` cell holds its signature, and a guard row's the type it narrows to. A `Shape` cell holds the constant's declared type.

| API                     | Kind      | Shape                                                                                              | Summary                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | --------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createTerminalRoutes`  | function  | `(manager: TerminalManagerInterface, options?: TerminalRoutesOptions) => readonly TerminalRoute[]` | Builds the GET SSE stream and POST answer routes that bridge a terminal manager onto the wire.                                                                                                                                                                                                                                                                                           |
| `TerminalRouteMethod`   | type      | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE' \| 'HEAD' \| 'OPTIONS'`                           | Represents the HTTP method literal a `TerminalRoute` declares — the same union `@orkestrel/router`'s `Method` type accepts.                                                                                                                                                                                                                                                              |
| `TerminalRouteContext`  | interface | `{ params }`                                                                                       | Represents the minimal route-dispatch context a `TerminalRoute` handler reads — exactly the frozen, URL-decoded `:name` path param slice a router hands a matched handler.                                                                                                                                                                                                               |
| `TerminalRoute`         | interface | `{ method, path, handler }`                                                                        | Represents one structural route record `createTerminalRoutes` returns — a plain `{ method, path, handler }` shape carrying no dependency on `@orkestrel/router`'s own `Route` type, so a consumer mounts it against any router that accepts a two-arg `(request, context) => Response \| Promise<Response>` handler keyed by `method` and `path`.                                        |
| `TerminalRoutesOptions` | interface | `{ path?, token?, keepalive?, timer?, limit? }`                                                    | Represents the options `createTerminalRoutes` takes — the shared route, authorization, keepalive, timer, and body-limit configuration both routes read.                                                                                                                                                                                                                                  |
| `TerminalToken`         | type      | `string \| ((value: string \| undefined) => boolean)`                                              | Represents the `token` gate `TerminalRoutesOptions` may configure — a plain string compared for equality against the `x-orkestrel-token` header, or a validator function the consumer fully controls, enabling the expiry and rotation a fixed string cannot express (a JWT `exp` check, a revocation-list lookup, anything time-varying). `undefined` disables the auth check entirely. |
| `TERMINAL_ROUTES_PATH`  | const     | `string`                                                                                           | Holds the default `:name`-templated path `createTerminalRoutes` mounts its GET (SSE) and POST (answer) routes under, `/terminals/:name`.                                                                                                                                                                                                                                                 |
| `TERMINAL_KEEPALIVE_MS` | const     | `number`                                                                                           | Holds the default SSE keepalive interval `createTerminalRoutes` arms per open connection, `15_000` ms — a `:` comment ping a conforming SSE parser ignores, keeping intermediary proxies from timing out an otherwise-idle stream.                                                                                                                                                       |

> A reconnecting SSE client replays every pending form from the top on every (re)connect (the GET handler's replay loop), so a raw `EventSource` (or any hand-rolled consumer that isn't `PromptClient`) must dedupe `pending` frames by their SSE `id` — the same form id may arrive more than once across a reconnect. `PromptClient` (`@orkestrel/terminal`) already does this; a consumer bypassing it does not get the dedupe for free.
>
> Fan-out is `O(total connections)` per `pending` / `expire` event on one manager — every open GET stream for every endpoint on that manager runs its scoped listener on each emit (filtered by `to === name` inside the handler, not before). This is fine at ordinary connection counts; a workload with very many concurrently-open streams across many endpoints on one manager is the lever to reach for — per-endpoint sharding (one manager, or one emitter subscription, per endpoint) — if fan-out cost ever becomes material. Not implemented here; noted as the scaling lever, not a current limitation.

## Methods

Every `create*Tool` factory returns a plain `ToolInterface` (`@orkestrel/tool`'s type — its method surface is documented in [`tool.md`](tool.md), not re-documented here). `createToolFunction` returns a plain `WorkflowFunction`; `createAgentFunction` returns the compatible metadata-bearing `AgentFunction`; `createWorkflowFunctions` returns the frozen composed registry. The `WorkspaceManagerInterface` / `WorkflowRunnerInterface` / `AgentRegistryInterface` a caller supplies are likewise defined and documented upstream. `DefinitionStoreInterface` is the point-access persistence seam `MemoryDefinitionStore` / `DatabaseDefinitionStore` implement; the lifecycle classes expose their minimal orchestration methods directly.

#### `DefinitionStoreInterface`

| Method   | Returns                                    | Summary                                                                              |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `get`    | `Promise<DatabaseDefinition \| undefined>` | Resolves the persisted definition for `id`, or `undefined` when none is stored.      |
| `set`    | `Promise<void>`                            | Inserts or replaces a definition under its own `id`, taking no separate id argument. |
| `delete` | `Promise<void>`                            | Drops the definition for `id`, treating an absent id as a no-op that never throws.   |

#### `DatabaseResolver`

| Method    | Returns                          | Summary                                                                                                                          |
| --------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `has`     | `boolean`                        | Determines whether a live database is cached by id.                                                                              |
| `get`     | `DatabaseInterface \| undefined` | Reads a cached database without consulting the definition store.                                                                 |
| `set`     | `void`                           | Caches a live database by id.                                                                                                    |
| `delete`  | `void`                           | Removes a cached live database by id.                                                                                            |
| `resolve` | `Promise<DatabaseInterface>`     | Resolves a live database by id — the cached handle when one exists, otherwise a database constructed from its stored definition. |

### Composing `DatabaseResolver` directly

Construct the resolver over a caller-owned handle map, a driver registry, and a definition store, then drive its cache calls and resolve a database by id:

```ts
import type { DatabaseInterface } from '@orkestrel/database'
import type { DefinitionStoreInterface } from '@orkestrel/toolbox'
import { createMemoryDriver } from '@orkestrel/database'
import { DatabaseResolver } from '@orkestrel/toolbox'

declare const database: DatabaseInterface
declare const store: DefinitionStoreInterface

const resolver = new DatabaseResolver(new Map(), { memory: createMemoryDriver }, undefined, store)
resolver.has('shop')
resolver.set('shop', database)
resolver.get('shop')
resolver.delete('shop')
await resolver.resolve('shop')
```

## Contract

These invariants hold across `src/core` ↔ `toolbox.md`:

1. **doc ↔ source bijection.** Every `function` / `class` / `const` / `interface` / `type` row in the `## Surface` tables is a real export of `src/core`, and every export appears as a Surface row — exhaustive, both directions under AGENTS' documentation contract.

2. **One tool = one behavior; the runtime supplies the envelope, this package supplies the handler.** Each `create*Tool` factory returns a plain `ToolInterface` (`@orkestrel/tool`). Under AGENTS' narrow-untrusted-input-with-guards rule, its handler parses the model-supplied `args` against a compiled [contract](contract.md), dispatches, and either returns a plain value on success or throws a typed error on every failure path — it never builds a `ToolResult` itself. The runtime supplies registry execution and result isolation; see [`tool.md`](tool.md). Through that registry, a failure's flattened message text appears exactly once, identically, over both the agent loop and MCP.

3. **Contract-compiled schemas throughout.** Every advertised `parameters` is `schemaToParameters(contract.schema)` off a `createContract`-compiled shape (`workflowStepsShape` / `workflowDraftShape` / `workspaceToolShape` / `agentToolShape`) — never a hand-written JSON Schema — so the guard / parser / schema the handler validates against can never drift from what the tool advertises.

4. **Workflow/agent recursion is lineage-derived and contextually composed.** `WorkflowLineage` is a copied, frozen chain of nonempty unique tags, strictly alternating `workflow:` then `agent:`. Malformed configured lineage or a factory-incompatible final tag throws `ToolboxError('TOOL')`; runtime workflow mismatch, repeated workflow/agent id, or over-depth target throws `ToolboxError('DEPTH')` before agent, tool, or runner activity. Depth is zero-based and derived only from workflow-tag count minus one (empty/root is `0`): root plus eight nested workflows is allowed, the ninth nested workflow is rejected. `createWorkflowFunctions` is the sole composition engine: it snapshots opaque `functions`, rejects a marked `AgentFunction` supplied through that opaque channel, rejects function/agent key collisions, and contextually adapts raw `agents` for the exact target lineage. Its frozen registry has a null prototype, so the workflow runner's native bracket lookup cannot resolve unregistered inherited names such as `toString`, `constructor`, `valueOf`, `hasOwnProperty`, or `__proto__`; those remain genuine native `WorkflowError('TRANSITION')` failures. Opaque wrappers or spoofed metadata that hide their real agent behavior are not covered; hosts must not use them to share one live agent concurrently.

5. **`createWorkflowTool` widens the authoring surface additively; the strict contract stays the soundness gate.** It advertises the simple flat shape (`{ name?, steps: [{ name }] }`) as its `parameters` so a small model can author a whole tree in one call, but its handler accepts empty args (the wrapped `definition`), a `steps` array (the flat form, `expandSteps`'d), or a nested draft/full definition (`createWorkflowDraftContract`-parsed and `completeDraft`'d, or accepted as-is when already strict) — and every path converges on the byte-for-byte-unchanged `createWorkflowContract().is` gate before it runs. A blob that fails to parse, expand, or complete, or whose result fails that strict gate, throws a `TOOL` `ToolboxError`; the leniency never reaches the runner. An omitted task `behavior` is the native JSON-`null` no-op. A present unresolved name reaches the runner and is rejected by the native drivability gate as a genuine `WorkflowError('TRANSITION')`; Toolbox does not duplicate that preflight.

Before shape branching or property reads, the handler snapshots untrusted `args` through Contract's `attempt` and `cloneJSONRecord`; hostile traversal or inexact JSON becomes `ToolboxError('TOOL', 'malformed workflow definition', ...)` before runner functions or persistence begin, never a raw Proxy/Contract error. A standalone `createWorkflowTool` called with empty args runs its wrapped definition. The tool bound onto an agent deliberately wraps the containing workflow id, so its empty-args call is a repeated-lineage cycle and throws `ToolboxError('DEPTH')`; a bound nested call must author a new target rather than receive an invented id.

6. **`createWorkflowTool` delegates composition and persistence without inventing identity.** Configured lineage/functions/agents registries are copied at construction. At invocation the strict target tag is appended, repeated ids and over-depth are rejected, and `createWorkflowFunctions` builds the contextual registry only when functions or agents were supplied. The resulting registry and optional store are forwarded to `runner.execute(target, { functions?, store? })`. The runner owns initial/attempt/settlement/final checkpoints, coalescing, restore-ready final snapshots, and persistence failures as data. `WorkflowToolResult` projects `{ status, count, durable?, fault? }`: `durable`/`fault` appear exactly when the native result supplies them. A flat authoring `name` is the deterministic workflow id; repeated runs with the same name address and replace the same store snapshot rather than minting a hidden id.

7. **`createWorkspaceTool` is manager-driven, with a no-active ergonomic seam.** `options.manager` (drive directly) takes priority over `options.store` (build a fresh manager over it through `@orkestrel/workspace`'s `createWorkspaceManager`); neither given constructs a manager over `@orkestrel/workspace`'s in-memory default. The `store` slot deliberately diverges from invariant 6: the workspace tool's `store` only backs the constructed manager's `open` / `save` — the tool's edits are not auto-persisted (durability requires an explicit caller `save`), whereas the workflow tool forwards its store to native run-wide checkpoint persistence. Every edit / read arm targets `manager.active` — never a specific workspace by id directly — so a host repoints which workspace the model edits through the registry arms (`workspaces` lists them, `switch` re-points `active`, lenient on an unknown id). A writing arm (write / splice / prepend / append / move / remove / replace) run with no active workspace auto-creates and activates one (`manager.add()`); a pure-read arm (read / list / has / search) against no active workspace returns the empty result, never creating one and never throwing. `search` / `replace` pass the workspace vocabulary through unchanged: `regex` chooses pattern-vs-literal matching, `sensitive` controls case sensitivity, and `limit` caps occurrences; `replace` returns the dependency's own `ReplaceResult` directly as `{ occurrences, files }`.

8. **`createAgentTool` carries its own `store` slot, composable with a registry-level store.** `AgentToolOptions.store` is an optional `ConversationStoreInterface` (`@orkestrel/agent`): when supplied, the handler `await`s `store.set(agent.context.conversations.active.snapshot())` after `agent.generate()` settles successfully, before returning — one snapshot per delegation (each `registry.build` mints a fresh conversation id through its seeded `add`, so a shared store never collides, it accumulates one snapshot per delegated call). A `store.set` failure propagates as the tool call's own failure (isolated by `ToolManagerInterface` into the canonical `error`, per invariant 2) — persistence is not best-effort. Omitted, the handler persists nothing from this tool. This composes with, and is independent of, `AgentRegistryOptions.store` (`@orkestrel/agent`): a registry built with its own `store` backs every agent it builds with a store-backed `ConversationManagerInterface`, including ones built through this tool — a caller may use either seam alone or both together.

9. **A delegated sub-agent's lifecycle is a single `generate()` call.** `createAgentTool`'s handler resolves a live agent through `registry.build`, awaits one `agent.generate()`, and returns its settled `content` — `AgentInterface` (`@orkestrel/agent`) exposes no teardown method, so there is nothing to release afterwards; the agent's state lives entirely in the resolved `AgentContextInterface`, owned by the caller's registry.

10. **Provider-agnostic delegation.** `createAgentTool` never imports or references a concrete `ProviderInterface` implementation — `options.provider` / a per-call `call.provider` is a registry key resolved by `registry.build`, so swapping the provider behind that key changes nothing about the tool. A missing / unresolvable provider (neither the call nor the tool's own default supplies one) throws a `TOOL` `ToolboxError` before any agent is built.

11. **`ToolboxError` owns Toolbox boundary failures; upstream errors own genuine domain failures.** It carries a machine-readable `ToolboxErrorCode` and an optional `context` and is always thrown, never returned as `{ error }`: `TOOL` covers malformed authoring, missing tool bindings, invalid tool/agent JSON, and the other package-owned resolution/configuration guards; `DEPTH` covers Toolbox workflow/agent nesting refusal; the remaining codes retain their terminal/database/relation meanings. A genuine error thrown by an executed tool passes through unchanged. The native workflow runner's genuine `WorkflowError` also passes through unchanged, including `TRANSITION` for an unresolved named run; Toolbox never invents invalid workflow `TOOL`/`DEPTH` codes and never relabels runner errors. `WorkspaceError` similarly retains its upstream domain ownership. An in-process direct call can inspect typed codes/context; `ToolManagerInterface.execute` flattens the error to its message.

12. **The workflow-function adapters are opt-in and exact at the JSON boundary.** `createToolFunction(tools, name)` resolves the live tool, awaits `tool.execute(controller.input)`, then deep-gates the unknown return through `parseJSONValue`; a missing binding or non-JSON result throws `ToolboxError('TOOL')`, while a genuine tool throw passes through by identity. It rejects `name === WORKFLOW_TOOL_NAME` at construction so the reserved live workflow tool cannot be adapted back into a workflow registry. `createAgentFunction(agent, options?)` returns a frozen `AgentFunction` with frozen category/lineage metadata. It starts `agent.generate({ signal: controller.signal })` synchronously after any runner-bound tool installation, using Agent's native per-run cancellation seam: an already-aborted signal starts no provider call, and cancellation settles as a partial result. The full `AgentResult` is projected through Agent-owned `agentResultToJSON`; malformed structural results become `ToolboxError('TOOL')`. With a runner, an already-running real agent is rejected before its workflow-tool binding can be replaced, so another Toolbox branch observes the running state. Genuine agent/provider errors retain identity.

13. **The lean `summary` / full `description` split, and `createDescribeTool`'s expansion seam.** `createWorkflowTool`, `createWorkspaceTool`, and `createAgentTool` each set `ToolInterface.summary` (`@orkestrel/tool`) to a frozen one-sentence constant (`WORKFLOW_TOOL_SUMMARY` / `WORKSPACE_TOOL_SUMMARY` / `AGENT_TOOL_SUMMARY`) alongside their unchanged full teaching `description`; `ToolManagerInterface.definitions()` advertises `summary ?? description`, so a model sees the lean text by default. `createDescribeTool(tools)` is the on-demand expansion: given a registered `name`, it looks the tool up through `tools.tool(name)` and returns its full `tool.description` (falling back to `tool.summary`, then a placeholder, when a tool has neither) — never truncated, never re-derived. Each summary's text points the model at `describe('<name>')` for the full schema.

14. **`createDatabaseTool` and `createRelationTool` are single-tool-many-operations, matching `createWorkspaceTool`'s shape.** `createDatabaseTool` dispatches `create` / `tables` / `get` / `records` / `count` / `aggregate` / `add` / `set` / `update` / `remove` / `destroy` off `databaseToolShape`; `createRelationTool` dispatches `load` / `find` / `link` / `unlink` / `links` off `relationToolShape`. Both set `ToolInterface.summary` (`DATABASE_TOOL_SUMMARY` / `RELATION_TOOL_SUMMARY`) alongside their full teaching `description`, retrievable through `createDescribeTool`, per invariant 13. Every `'get'` / `'add'` / `'set'` / `'update'` / `'remove'` and `'load'` operation's `key` field takes either a single key or an array of keys (AGENTS' batch overload mold, with the array form resolving first); a single-key call returns a singular result field (`row` / `key` / `updated` / `removed`), an array-key call returns the plural (`rows` / `keys` / `updated` / `removed` as arrays).

15. **The database tool's query form is serialized, never fluent.** `databaseToolShape`'s `query` is a flat object — `{ conditions?: [{ column, operator, values, connector? }], order?, limit?, offset? }` — where `values` is always an array, even for a single-value operator (`{ column: 'age', operator: 'from', values: [18] }`), so a small model never chains method calls or guesses arity. `normalizeQuery` normalizes the parsed form into a live `@orkestrel/database` `QueryInput`, defaulting an omitted condition `connector` to `'and'` (the wire form lets a caller drop `connector` on the last condition, because it joins nothing forward).

16. **The `TableSpec` column DSL is bounded to the primitives `'string'` / `'integer'` / `'number'` / `'boolean'`.** A `ColumnSpec` is either a bare `ColumnPrimitive` shorthand or `{ primitive, optional? }`; `expandTables` compiles a `TableSpec` into the `@orkestrel/database` `TableMap` `createDatabase` accepts through `compileColumn` / `compileColumnPrimitive`, wrapping an `optional: true` column in `optionalShape`. There is no nested/composite column primitive — a table's shape is a flat map of column name to `ColumnSpec`, never an object/array column.

17. **`'records'` / `'find'` / `'links'` truncate against a configured cap, never silently.** `createDatabaseTool`'s `'records'` (cap: `DatabaseToolOptions.limit`, default `DATABASE_TOOL_LIMIT`) and `createRelationTool`'s `'find'` / `'links'` (cap: `RelationToolOptions.limit`, default `RELATION_TOOL_LIMIT`) each probe one row past the effective limit (`clampQuery` for the database tool; `resolveLimit` plus the same probe for `'find'`) to detect truncation without a separate count round trip, returning `{ rows, count, truncated, limit }` (`'links'`: `{ keys, count, truncated, limit }`) — `truncated` is `true` exactly when storage held more than `limit` matching rows/keys. A caller's own `query.limit` / `limit` can only lower the effective cap, never raise it past the configured ceiling.

18. **A typed upstream failure re-surfaces in-process as a typed `ToolboxError`, never passes through raw.** `createDatabaseTool` catches a `@orkestrel/database` `DatabaseError` and re-throws a typed `DATABASE` `ToolboxError` carrying the original `DatabaseErrorCode` in `context.code` (`inferDatabaseCode`); `createRelationTool` does the same for a `@orkestrel/relation` `RelationError` → `RELATION` (`inferRelationCode`, checked first) and, underneath it, a `DatabaseError` → `DATABASE` (mirroring the database tool's own mapping) — so an in-process catch or direct `tool.execute(args)` call sees exactly one of `TOOL` (this tool's own guards: malformed args, unknown manager/model/database/driver), `RELATION`, or `DATABASE`, never an unwrapped upstream error. A `ToolboxError` already thrown by this tool's own guards passes through unwrapped (never re-mapped a second time). A `ToolManagerInterface.execute` registry caller does not receive that code or context; it receives only the flattened message string.

19. **`DatabaseToolOptions.readonly` gates every mutating operation up front.** When `true`, `createDatabaseTool` throws a typed `TOOL` `ToolboxError` for `'create'` / `'add'` / `'set'` / `'update'` / `'remove'` / `'destroy'` before resolving a database or touching storage — the non-mutating operations (`'tables'` / `'get'` / `'records'` / `'count'` / `'aggregate'`) are unaffected. The exported `DATABASE_TOOL_MUTATIONS` membership list is a runtime-frozen readonly array, so a consumer cannot mutate it to bypass this gate. There is no equivalent gate on `createRelationTool` — its `'link'` / `'unlink'` writes are ungated (relation-tool callers rely on the underlying database's own access controls, if any).

20. **A `DatabaseDefinition` is config-only and round-trips through a `DefinitionStoreInterface` — never a live handle.** `createDatabaseTool`'s `'create'` persists `{ id, driver, tables, primary?, indexes?, version? }` (never the constructed `DatabaseInterface`) when `options.store` is supplied, and publishes the new live handle to its resolver only after persistence succeeds. Every other operation lazily `resolve`s an uncached id by reading the definition back and reconstructing a live database from it (`createDatabase` and `expandTables`) — the live handle itself is cached only in-process (`Map<string, DatabaseInterface>`), reconstructed fresh on the next process from the stored config. `primary` and `indexes` are paired schema metadata, while `version` is the target stamp a versioning driver writes after first use when it implements paired `metadata` / `stamp` capabilities. `isDatabaseDefinition` is the boundary guard a `DefinitionStoreInterface` applies to an untrusted persisted blob before trusting it. `MemoryDefinitionStore` structured-clones definitions on copy-in and copy-out; `DatabaseDefinitionStore` stores one opaque JSON column in a `@orkestrel/database` table and narrows it back with `isDatabaseDefinition` on read, reporting `undefined` for a malformed blob. They implement the same `get` / `set` / `delete` contract; only the memory store prevents caller mutation from aliasing stored state on its own, because the table-backed store's isolation follows from its driver.

21. **The relation tool's `include` is a flat dot-path list, capped by `RelationToolOptions.depth`.** `'load'` / `'find'` accept `include?: string[]` — each path a dot-separated chain of relation names (`'contacts.account'`) — expanded by `expandInclude` into a live `@orkestrel/relation` `Include` tree; a longer path subsumes a shorter sibling's bare `true` (`['contacts', 'contacts.account']` → `{ contacts: { account: true } }`). A path exceeding `depth` segments (default `RELATION_TOOL_DEPTH`), or carrying an empty segment (a leading/trailing/doubled `.`), throws a typed `TOOL` `ToolboxError` before any query runs. `resolveRelationManager` resolves which registered `RelationManagerInterface` a call addresses (an explicit `manager` miss, or an omitted one with other-than-exactly-one registered, throws typed `TOOL`); `resolveRelationModel` resolves `model` against it the same way.

22. **`createDatabaseTool` durability and ownership are narrower than they look.** A lazily re-minted database over the default in-memory driver yields an empty database — only the `DatabaseDefinition` schema persists in `store`, never rows; durable rows need a persistent driver factory registered in `DatabaseToolOptions.drivers`. A cached live database is never evolved in place. To adopt a new target `version`, create a new database id backed by a versioned persistent driver, or close the old tool lifecycle and construct a new tool whose stored definition carries the new schema metadata and stamp. `'destroy'` closes whatever handle is cached for the id, including an embedder-supplied `DatabaseToolOptions.databases` handle — the embedder relinquishes that handle's lifecycle to this tool for any id it wires in. `timeout`, when present, must be a nonnegative safe integer and is validated when the tool is constructed. Its fresh abort signal is passed only to `records`, `count`, `aggregate`, `add`, `set`, `update`, and `remove`, whose current table APIs accept operation options; it does not bound store resolution, construction, schema inspection, `get`, or `close`, and is not an outer deadline. The tool assumes the single-writer, non-reentrant model `@orkestrel/database` itself assumes — concurrent tool calls against one id are not serialized by this tool. Unlike `'records'` / `'find'` / `'links'`, `'get'` is uncapped by `DatabaseToolOptions.limit` (bounded only by the caller's `key` array size).

23. **`createEndpointTool` enforces its advertised inferred schema through a normalizing parse by default (`@orkestrel/contract`'s `schemaToShape`), with an explicit `validate: false` opt-out.** `parameters` is inferred once at construction (`samplesToSchema` and `schemaToObject` over `definition.samples`, tuned by `EndpointToolOptions.format`/`enum`) — the same object-rooted schema is compiled once (`schemaToShape` → `createContract`) into the contract the tool's `execute` `parse`s every call's `args` through before `definition.execute` runs. The parse coerces a scalar to its inferred type where the house parsers coerce (a number to/from a numeric string, a boolean from `'1'`/`'0'`/`'true'`/`'false'`/`1`/`0`) — `definition.execute` receives the coerced values (for example `7` sent for a string slot arrives as `'7'`), not the raw call args. A call whose `args` fails to parse into a record — a required key missing, or a value not coercible to its slot's type — throws a typed `TOOL` `ToolboxError` carrying the compiled contract's structured `explain` faults (through `contract.explain(args)`), and `definition.execute` is never called. Beyond that coercion, enforcement is structural: required keys, `enum` membership, and numeric bounds — `format` annotations (`email`, `date-time`, `uuid`, `uri`, ...) are never asserted, mirroring `@orkestrel/contract`'s own widening-only law for `schemaToShape` (a `format: true`-tuned endpoint still accepts a non-conforming string in that slot); a key outside the closed inferred schema is silently dropped, not rejected — `@orkestrel/contract`'s own `parse` grants that same leniency to any closed object. `EndpointToolOptions.validate: false` disables that enforcement: the tool's `execute` calls `definition.execute(args)` with the model-supplied `args` exactly as received, never re-parsed, coerced, or checked against the advertised schema. `createInferTool`'s own call args are, as before, always validated against `inferToolShape` (a hand-written shape) regardless — it is the schema inference's caller, not an inferred schema's consumer. `createEndpointTool`'s and `createInferTool`'s inferred schemas surface sample-derived strings verbatim (property names, and enum entries when opted in), so treat sample data intended for schema inference as untrusted content whenever the resulting schema will be advertised to other agents. `createInferTool`'s optional `candidates` call arg is the opposite seam: it checks values against the same call's freshly inferred schema (compiled per-call, because the schema itself is derived from that call's `samples`) and returns a uniform `{ index, valid, coercible, faults? }` entry per candidate. `valid` is a strict `.is` guard verdict, not a normalizing `.parse` — `7` against an inferred string slot is invalid (no coercion), where the same value would be silently coerced to `'7'` by `createEndpointTool`'s enforcement. `coercible` (`checker.parse(candidate) !== undefined`) answers that separate question directly — would `createEndpointTool`'s default enforcement admit this value — and, by the house parse/guard round-trip, is always `true` on a `valid: true` entry. Because `@orkestrel/contract`'s `.explain` mirrors `.parse`'s leniency, not `.is`'s strictness, a strictly-invalid but coercible candidate (`7` against a string slot) yields `{ valid: false, coercible: true, faults: [] }` — empty faults, because the mismatch normalization would silently fix is not one `.explain` reports; `faults` populates only for a non-coercible mismatch (`coercible: false`). `checker.is` / `.parse` / `.explain` are total over JSON-safe input — a JSON-safe hostile candidate (a `__proto__`-carrying object, deep nesting) reaches each of them and yields a bounded, non-throwing per-candidate verdict; a non-JSON-safe candidate (a throwing-getter `Proxy`) never reaches the checker — it fails the outer `args` parse and rejects the whole call as a `TOOL` error, with no per-candidate verdict. `candidates` is uncapped in count (any array length is accepted), but each individual check is bounded (`.explain`'s fault list and the checker's own schema are both bounded by the inference limits already governing `samples`), so the total per-call cost is linear in `candidates.length`.

24. **The terminal seam speaks whole forms, and `@orkestrel/form` owns their shape.** `promptToolShape` bounds a call to `{ to, schema }` and `answerToolShape`'s `'answer'` arm to `{ id, values }`, each of `schema` and `values` admitted only as exact JSON — Toolbox does not restate the form schema as a second contract. `createPromptTool` then hands `schema` to `parseForm`; a refusal (an unknown control, a duplicate field name, a `'select'` / `'checkbox'` field without usable choices, any other schema fault) throws a typed `TOOL` `ToolboxError` and nothing parks, so a malformed schema can never become a form nobody can answer. A parsed schema becomes a live form through `createForm` and is passed to `manager.ask(from, to, form)`, whose settled `FormValues` is the tool's return value — one record keyed by field name, however many fields the form declared. `createAnswerTool` narrows `values` with `isFormValues` before `manager.answer`, so a non-form payload is refused as `TOOL` rather than reaching the parked form. Expiry reaches one code from either side: a `TerminalError('EXPIRE')` from the broker and a `FormError('ABANDONED')` from the form itself both re-surface as `EXPIRE`, so a caller branches on Toolbox's own code and never on which layer timed the form out. A failed apply carries the manager's `TerminalAnswerError` through: `context.reason` is `'unknown'` / `'rejected'` / `'target'`, and a `'rejected'` apply also carries the per-field `errors` in `context.errors` so the asking side can name which field failed.

## Patterns

These patterns follow the arc — author and run a workflow through the tool; persist its snapshot; drive a workspace through the tool; delegate to a sub-agent; compose the adapters into a workflow's own registry.

### Authoring and running a workflow through the tool with a real `ToolManager`

Register the workflow tool on a real manager, then let a small model author the flat step list the tool advertises:

```ts
import { createWorkflowTool } from '@orkestrel/toolbox'
import { createToolManager } from '@orkestrel/tool'
import { createWorkflowRunner } from '@orkestrel/workflow'
import type { WorkflowDefinition } from '@orkestrel/workflow'

const definition: WorkflowDefinition = { id: 'release', name: 'Release', phases: [] }
const runner = createWorkflowRunner()
const functions = {
	compile: () => 'compiled',
	publish: () => 'published',
}
const tool = createWorkflowTool(definition, runner, { functions })

const tools = createToolManager()
tools.add(tool)

// A small model authors the simple flat shape — no ids/names required.
const result = await tools.execute({
	id: 'call-1',
	name: 'workflow',
	arguments: { name: 'release', steps: [{ name: 'compile' }, { name: 'publish' }] },
})
if (!result.success) throw new Error(result.error)
result.value // { status: 'completed', count: 2 } — the single-level envelope; no nested { id, name, value }
```

### Plugging a `WorkflowStoreInterface` and retrieving the persisted snapshot

Hand the tool a native workflow store, run the wrapped definition, and rebuild the finished run from the snapshot the runner checkpointed:

```ts
import { createWorkflowTool } from '@orkestrel/toolbox'
import {
	createMemoryWorkflowStore,
	createWorkflowRunner,
	createRestoredWorkflow,
} from '@orkestrel/workflow'
import type { WorkflowDefinition } from '@orkestrel/workflow'

const definition: WorkflowDefinition = {
	id: 'ingest',
	name: 'Ingest',
	phases: [{ id: 'load', name: 'Load', tasks: [{ id: 'read', name: 'Read' }] }],
}
const store = createMemoryWorkflowStore()
const runner = createWorkflowRunner()
const tool = createWorkflowTool(definition, runner, { store })

const summary = await tool.execute({}) // native runner checkpoints through `store`
// summary: { status: 'completed', count: 1, durable: true }
const snapshot = await store.get('ingest')
const restored = snapshot === undefined ? undefined : createRestoredWorkflow(snapshot)
restored?.status // 'completed' — the persisted run, rebuilt from its own snapshot
```

### Driving the workspace tool with a plugged store

Build the workspace tool over a store, then write a file and read it back through the manager the tool constructed:

```ts
import { createWorkspaceTool } from '@orkestrel/toolbox'
import { createMemoryWorkspaceStore } from '@orkestrel/workspace'
import { createToolManager } from '@orkestrel/tool'

const store = createMemoryWorkspaceStore()
const tool = createWorkspaceTool({ store }) // builds a fresh manager over `store`

const tools = createToolManager()
tools.add(tool)

await tools.execute({
	id: 'w1',
	name: 'workspace',
	arguments: { operation: 'write', path: 'notes.txt', content: 'hello' },
})
const read = await tools.execute({
	id: 'w2',
	name: 'workspace',
	arguments: { operation: 'read', path: 'notes.txt' },
})
read.value // 'hello'
```

### Delegating to a sub-agent through the agent tool

Register the agent tool over a seeded registry and delegate one task to a sub-agent:

```ts
import { createAgentTool } from '@orkestrel/toolbox'
import { createAgentRegistry } from '@orkestrel/agent'
import { createToolManager } from '@orkestrel/tool'

declare const registry: ReturnType<typeof createAgentRegistry> // seeded with a `providers` pool

const tool = createAgentTool(registry, { provider: 'openai' })
const tools = createToolManager()
tools.add(tool)

const result = await tools.execute({
	id: 'delegate-1',
	name: 'agent',
	arguments: { task: 'Summarize the attached notes in three bullet points.' },
})
result.value // the sub-agent's settled `AgentResult.content`
```

### Persisting a delegation's conversation through the agent tool's own `store` slot

Supply a conversation store, and each delegation's conversation is persisted under its own id:

```ts
import { createAgentTool } from '@orkestrel/toolbox'
import { createAgentRegistry, createMemoryConversationStore } from '@orkestrel/agent'
import { createToolManager } from '@orkestrel/tool'

declare const registry: ReturnType<typeof createAgentRegistry> // seeded with a `providers` pool

const store = createMemoryConversationStore()
const tool = createAgentTool(registry, { provider: 'openai', store }) // persists each delegation

const tools = createToolManager()
tools.add(tool)

await tools.execute({
	id: 'delegate-1',
	name: 'agent',
	arguments: { task: 'Summarize the attached notes in three bullet points.' },
})
// The delegated sub-agent's conversation snapshot now lives in `store` — one entry per
// delegation (a fresh conversation id per `registry.build`, so concurrent calls never collide).
```

### Lean advertisement and on-demand expansion through `createDescribeTool`

Register several tools on one manager, then expand a lean `summary` into its full teaching description on demand:

```ts
import { createDescribeTool, createWorkflowTool, createWorkspaceTool } from '@orkestrel/toolbox'
import { createToolManager } from '@orkestrel/tool'
import { createWorkflowRunner } from '@orkestrel/workflow'
import type { WorkflowDefinition } from '@orkestrel/workflow'

const definition: WorkflowDefinition = { id: 'release', name: 'Release', phases: [] }
const tools = createToolManager()
tools.add(createWorkflowTool(definition, createWorkflowRunner()))
tools.add(createWorkspaceTool())
tools.add(createDescribeTool(tools)) // the tool describes the same manager it is registered on

tools.definitions().map((entry) => entry.description)
// each entry is the lean summary (for example "Author and run a multi-phase workflow in one call — …")

const full = await tools.execute({
	id: 'd1',
	name: 'describe',
	arguments: { name: 'workflow' },
})
full.value // the workflow tool's full multi-line teaching description
```

### Composing opaque leaves and raw agents into a workflow registry

Split a workflow target registry into opaque host leaves and raw agents, and hand the same split to the authoring tool:

```ts
import type { AgentInterface } from '@orkestrel/agent'
import type { WorkflowDefinition } from '@orkestrel/workflow'
import { createToolFunction, createWorkflowFunctions, createWorkflowTool } from '@orkestrel/toolbox'
import { createToolManager } from '@orkestrel/tool'
import { createWorkflowRunner } from '@orkestrel/workflow'

declare const publishTool: Parameters<ReturnType<typeof createToolManager>['add']>[0]
declare const reviewAgent: AgentInterface

const tools = createToolManager()
tools.add(publishTool)

const definition: WorkflowDefinition = {
	id: 'ship',
	name: 'Ship',
	phases: [
		{ id: 'review', name: 'Review', tasks: [{ id: 'r', name: 'Review', behavior: 'review' }] },
		{ id: 'publish', name: 'Publish', tasks: [{ id: 'p', name: 'Publish', behavior: 'publish' }] },
	],
}
const runner = createWorkflowRunner()
const leaves = { publish: createToolFunction(tools, 'publish') }
const agents = { review: reviewAgent }
const functions = createWorkflowFunctions(runner, { functions: leaves, agents })
await runner.execute(definition, { functions })

// The authoring tool accepts the same split. Opaque leaves remain unchanged; raw agents are
// rebuilt for each exact target lineage. The native runner owns optional checkpoint persistence.
createWorkflowTool(definition, runner, { functions: leaves, agents })
```

### The lenient-authoring helpers, standalone

Call the lineage, draft-completion, and step-expansion helpers directly, outside any tool:

```ts
import {
	completeDraft,
	completePhaseDraft,
	completeTaskDraft,
	createWorkflowDraftContract,
	deriveWorkflowDepth,
	expandSteps,
	extendLineage,
	isAgentFunction,
	isWorkflowLineage,
	normalizeLineage,
	summarizeWorkflow,
	tagAgent,
	tagWorkflow,
} from '@orkestrel/toolbox'

tagWorkflow('release') // 'workflow:release'
tagAgent('reviewer') // 'agent:reviewer'

const root = normalizeLineage(['workflow:release'])
const agent = extendLineage(root, tagAgent('reviewer'))
isWorkflowLineage(agent) // true
deriveWorkflowDepth(root) // 0
isAgentFunction(() => 'opaque') // false

createWorkflowDraftContract().parse({ phases: [{ tasks: [{ behavior: 'compile' }] }] })

completeTaskDraft({ behavior: 'compile' }, 'phase-0', 0) // { id: 'phase-0-task-0', name: 'phase-0-task-0', behavior: 'compile' }
completePhaseDraft({ tasks: [{ behavior: 'compile' }] }, 0) // { id: 'phase-0', name: 'phase-0', tasks: [...] }
completeDraft({ phases: [{ tasks: [{ behavior: 'compile' }] }] }) // a complete WorkflowDefinition, ids/names filled positionally

expandSteps({ steps: [{ name: 'compile' }] }) // one one-task phase whose task's `behavior` is 'compile'

// summarizeWorkflow preserves the runner's optional durability/fault fields exactly:
declare const result: Parameters<typeof summarizeWorkflow>[0]
summarizeWorkflow(result) // { status, count, durable?, fault? }
```

### Recovering a typed `ToolboxError`

Catch a thrown failure and narrow it with the package's own guard to read its `code`:

```ts
import { ToolboxError, isToolboxError } from '@orkestrel/toolbox'

try {
	throw new ToolboxError('TOOL', 'task is required')
} catch (error) {
	if (isToolboxError(error)) console.log(error.code) // 'TOOL'
}
```

### Asking and answering through the terminal seam

Wire the ask and answer halves over one live terminal manager, and settle a form across them:

```ts
import { createAnswerTool, createPromptTool } from '@orkestrel/toolbox'
import { createToolManager } from '@orkestrel/tool'
import { createTerminalManager } from '@orkestrel/terminal'

const manager = createTerminalManager()
manager.add('agent')
manager.add('reviewer')

const askTool = createPromptTool({ manager, from: 'agent' })
const answerTool = createAnswerTool({ manager, to: 'reviewer' })

const tools = createToolManager()
tools.add(askTool)
tools.add(answerTool)

// One call asks a whole form — every field is answered together.
const asked = tools.execute({
	id: 'ask-1',
	name: 'ask',
	arguments: {
		to: 'reviewer',
		schema: {
			label: 'Release review',
			fields: [
				{ control: 'confirm', name: 'approved', label: 'Approve the release?' },
				{ control: 'editor', name: 'notes', label: 'Review notes' },
			],
		},
	},
}) // blocks until 'reviewer' answers

const listed = await tools.execute({
	id: 'p-1',
	name: 'answer',
	arguments: { operation: 'pending' },
})
listed.value // [{ id, from: 'agent', schema: { label: 'Release review', fields: [...] } }]

// The same parked records, typed, straight off the manager.
const [form] = manager.pending('reviewer')
if (form === undefined) throw new Error('expected one parked form')

await tools.execute({
	id: 'a-1',
	name: 'answer',
	arguments: {
		operation: 'answer',
		id: form.id,
		values: { approved: true, notes: 'Ship it.' },
	},
})

const result = await asked
result.value // { approved: true, notes: 'Ship it.' } — one record keyed by field name
```

### The terminal error-classification helper, standalone

Map a caught terminal failure to the code the terminal tools throw with:

```ts
import { inferTerminalCode } from '@orkestrel/toolbox'
import { TerminalError } from '@orkestrel/terminal'

inferTerminalCode(new TerminalError('DEADLOCK', 'cycle')) // 'DEADLOCK'
inferTerminalCode(new TerminalError('EXPIRE', 'timed out')) // 'EXPIRE'
inferTerminalCode(new TerminalError('TARGET', 'unknown')) // 'TOOL'
inferTerminalCode(new Error('not a terminal error')) // undefined
```

### Bridging a `TerminalManagerInterface` onto the wire

Build the route records that carry a terminal manager over the wire, and mount them on any router that accepts a structural handler:

```ts
import { createTerminalRoutes } from '@orkestrel/toolbox/server'
import { createTerminalManager } from '@orkestrel/terminal'

const manager = createTerminalManager()
manager.add('assistant')
const routes = createTerminalRoutes(manager, { token: 'secret' })
// mount `routes` (a GET SSE form stream and a POST `{ id, values }` answer, one shared
// `:name`-templated path) against any router that accepts a `{ method, path, handler }`
// structural record — byte-compatible with `@orkestrel/terminal`'s own `PromptClient`,
// down to the JSON answer `Result` the POST returns.
```

### Driving the database tool: create with metadata, add a row, query with a serialized condition

Create a database from the column DSL, add a row, and query it with a serialized condition:

```ts
import { createDatabaseTool } from '@orkestrel/toolbox'
import { createToolManager } from '@orkestrel/tool'

const tool = createDatabaseTool() // in-memory `memory` driver, no store — created databases live for the tool's lifetime

const tools = createToolManager()
tools.add(tool)

await tools.execute({
	id: 'c1',
	name: 'database',
	arguments: {
		operation: 'create',
		id: 'shop',
		tables: {
			products: {
				columns: {
					id: 'string',
					name: 'string',
					price: 'number',
					notes: { primitive: 'string', optional: true },
				},
			},
		},
		primary: { products: 'id' },
		indexes: { products: [['name'], ['price', 'name']] },
		version: 1,
	},
})

await tools.execute({
	id: 'a1',
	name: 'database',
	arguments: {
		operation: 'add',
		id: 'shop',
		table: 'products',
		row: { name: 'Widget', price: 25 },
	},
})

// Serialized query — a condition is a flat object; "values" is always an array.
const records = await tools.execute({
	id: 'r1',
	name: 'database',
	arguments: {
		operation: 'records',
		id: 'shop',
		table: 'products',
		query: { conditions: [{ column: 'price', operator: 'below', values: [50] }] },
	},
})
records.value // { rows: [{ id: '...', name: 'Widget', price: 25 }], count: 1, truncated: false, limit: 1000 }
```

### Persisting database definitions through `DefinitionStoreInterface`

Swap the in-memory definition store for the table-backed twin without changing the tool's calls:

```ts
import {
	createDatabaseDefinitionStore,
	createDatabaseTool,
	createMemoryDefinitionStore,
} from '@orkestrel/toolbox'
import { createToolManager } from '@orkestrel/tool'

const memory = createMemoryDefinitionStore() // in-memory Map-backed default
const durable = createDatabaseDefinitionStore() // one @orkestrel/database table (in-memory driver by default)

const tool = createDatabaseTool({ store: memory })
const tools = createToolManager()
tools.add(tool)

await tools.execute({
	id: 'c1',
	name: 'database',
	arguments: {
		operation: 'create',
		id: 'shop',
		tables: { products: { columns: { name: 'string' } } },
	},
})

const definition = await memory.get('shop')
definition?.driver // 'memory' — the config-only blueprint, never a live handle

await durable.set({ id: 'audit', driver: 'memory', tables: {} })
const restored = await durable.get('audit')
await durable.delete('audit')
restored?.id // 'audit'
```

### Wiring the relation tool over a live `RelationManagerInterface` and loading nested includes

Register a live relation manager and load a row with a nested dot-path `include` list:

```ts
import { createRelationTool } from '@orkestrel/toolbox'
import { createToolManager } from '@orkestrel/tool'
import type { RelationManagerInterface } from '@orkestrel/relation'

declare const manager: RelationManagerInterface // built with createRelationManager({ database, relations: { ... } })

const tool = createRelationTool({ managers: { shop: manager } }) // omit "manager" in a call when only one is registered

const tools = createToolManager()
tools.add(tool)

const loaded = await tools.execute({
	id: 'l1',
	name: 'relation',
	arguments: {
		operation: 'load',
		model: 'accounts',
		key: 'acc1',
		include: ['contacts.account'], // a flat dot-path — one segment per level of nested relations
	},
})
loaded.value // { row: { ...account fields, contacts: [{ ...contact fields, account: {...} }] } }

// link / unlink / links manage a many-to-many junction through a "through" relation.
await tools.execute({
	id: 'k1',
	name: 'relation',
	arguments: {
		operation: 'link',
		model: 'accounts',
		key: 'acc1',
		relation: 'representatives',
		target: 'rep1',
	},
})
const linked = await tools.execute({
	id: 'k2',
	name: 'relation',
	arguments: { operation: 'links', model: 'accounts', key: 'acc1', relation: 'representatives' },
})
linked.value // { keys: ['rep1'], count: 1, truncated: false, limit: 1000 }
```

### The database and relation helpers, standalone

Call the column compilers, the error classifiers, the query normalizer, and the relation resolvers directly:

```ts
import {
	compileColumn,
	compileColumnPrimitive,
	expandTables,
	inferDatabaseCode,
	inferRelationCode,
	isColumnPrimitive,
	isColumnSpec,
	isDatabaseDefinition,
	normalizeQuery,
	resolveRelationManager,
	resolveRelationModel,
} from '@orkestrel/toolbox'
import { DatabaseError } from '@orkestrel/database'
import { RelationError } from '@orkestrel/relation'

isColumnPrimitive('string') // true
isColumnSpec({ primitive: 'string', optional: true }) // true

const shapes = expandTables({
	products: { columns: { name: 'string', price: { primitive: 'number', optional: true } } },
})
compileColumn('integer') // the integerShape() ContractShape
compileColumnPrimitive('boolean') // the booleanShape() ContractShape

isDatabaseDefinition({ id: 'shop', driver: 'memory', tables: {} }) // true

inferDatabaseCode(new DatabaseError('NOT_FOUND', 'row not found')) // 'NOT_FOUND'
inferRelationCode(new RelationError('UNKNOWN_RELATION', 'unknown relation')) // 'UNKNOWN_RELATION'

normalizeQuery({ conditions: [{ column: 'age', operator: 'from', values: [18] }] })
// { conditions: [{ column: 'age', operator: 'from', values: [18], connector: 'and' }] }

declare const managers: Readonly<
	Record<string, import('@orkestrel/relation').RelationManagerInterface>
>
const resolved = resolveRelationManager(managers, undefined) // the sole registered manager, or throws
resolveRelationModel(resolved, 'accounts') // the resolved model, or throws on an unknown name
```

### Inferring a JSON Schema from example values, through a real `ToolManager`

Infer a schema from example values and check candidate values against that schema in the same call:

```ts
import { createInferTool } from '@orkestrel/toolbox'
import { createToolManager } from '@orkestrel/tool'

const tool = createInferTool()
const tools = createToolManager()
tools.add(tool)

const result = await tools.execute({
	id: 'call-1',
	name: 'infer',
	arguments: {
		samples: [
			{ id: 1, name: 'Ada' },
			{ id: 2, name: 'Bob' },
		],
	},
})
// result.value -> {
//   type: 'object',
//   properties: { id: { type: 'integer' }, name: { type: 'string' } },
//   required: ['id', 'name'],
//   additionalProperties: false,
// }

// pass `candidates` to check values against the freshly inferred schema — the result is wrapped
// as `{ parameters, checks }` instead of the bare parameters record, one check per candidate.
const checked = await tools.execute({
	id: 'call-2',
	name: 'infer',
	arguments: {
		samples: [{ id: 1, name: 'Ada' }],
		candidates: [
			{ id: 2, name: 'Bob' },
			{ id: 'x', name: 'Cy' },
			{ id: 1, name: 7 },
		],
	},
})
// checked.value -> {
//   parameters: {
//     type: 'object',
//     properties: { id: { type: 'integer' }, name: { type: 'string' } },
//     required: ['id', 'name'],
//     additionalProperties: false,
//   },
//   checks: [
//     { index: 0, valid: true, coercible: true },
//     { index: 1, valid: false, coercible: false, faults: [{ reason: 'type', path: ['id'], expected: 'integer', received: '"x"' }] },
//     { index: 2, valid: false, coercible: true, faults: [] },
//   ],
// }
// Note: `valid` is a strict guard verdict (`.is`), not a normalizing parse — the opposite of
// `createEndpointTool`'s enforcement (Contract invariant 23), which coerces (`7` becomes `'7'`
// for a string slot); here `7` against a string slot is `valid: false`. `coercible` answers that
// separate question directly (would the endpoint tool's normalizing parse accept it) — candidate 2
// is a strict mismatch that is still coercible, so it carries empty `faults`: `.explain` mirrors
// `.parse`'s leniency, not `.is`'s strictness, so faults populate only for a non-coercible mismatch
// (candidate 1's wrong, non-coercible `id` type).
```

### Bridging an existing API endpoint into an LLM-callable tool

Wrap one concrete endpoint whose advertised `parameters` are inferred from its samples and enforced at call time:

```ts
import { createEndpointTool } from '@orkestrel/toolbox'
import { createToolManager } from '@orkestrel/tool'

// A real handler over an existing API/DB call — samples teach the inferred `parameters`.
const tool = createEndpointTool({
	name: 'lookupUser',
	description: 'Look up a user by id.',
	samples: [
		{ id: '1', name: 'Ada' },
		{ id: '2', name: 'Bob' },
	],
	execute: async (args) => ({ id: args.id, name: 'Ada' }), // a real endpoint call goes here
})

const tools = createToolManager()
tools.add(tool)

const result = await tools.execute({
	id: 'call-1',
	name: 'lookupUser',
	arguments: { id: '1', name: 'Ada' },
})
// result.value -> { id: '1', name: 'Ada' }
// Note: by default `args` is parsed and validated against the advertised schema before the
// definition's `execute` runs (see Contract invariant 23) — a nonconforming call throws a typed
// `TOOL` `ToolboxError` with structured faults instead of reaching the handler. Pass
// `{ validate: false }` as the second argument to `createEndpointTool` for raw passthrough.
```

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` and `src/server` bijection (value and type exports, spanning both barrels), this guide's `## Patterns` fences resolving to real exports (per-specifier) with resolving imports, the `DefinitionStoreInterface` and `DatabaseResolver` method bijections, and the equality gate: every `Summary` cell against its declaration's description paragraph, the titled `Authoring and running a workflow through the tool with a real ToolManager` fence against the `@example` block of that title (pinned so the titled pair cannot be retired silently), and the README pitch against this guide's tagline. It also runs the flagship fences and asserts the values their comments claim.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — every factory returning a working instance or value; workflow coverage composes real runners, agents, tools, stores, and scripted providers across direct roots, top-level authoring tools, opaque-leaf propagation, frozen null-prototype registry isolation/collisions, inherited-name `TRANSITION` refusals, explicitly registered dangerous own keys, depth 8/9 boundaries, repeated workflow ids, bound no-arg cycle refusal, self-recursion, A→B→A, same-agent concurrency, native per-run cancellation (including already-aborted provider exclusion), hostile argument containment before runner/store entry, Agent-owned projection, malformed structural results, genuine error identity, and deterministic named-store replacement. Database coverage includes every operation, frozen readonly-mutation membership, persistence-before-cache publication through a real failing database store, timeout validation, query truncation, and typed failures. Creation and resolver coverage prove `primary` / `indexes` reach real memory-driver metadata and `version` is stamped after first use. Terminal coverage drives a real `TerminalManagerInterface` through the ask/answer pair: a multi-field schema parking once and settling into one values record, the pending listing carrying `{ id, from, schema }`, a schema `parseForm` refuses (an unknown control, duplicate field names, missing or non-array choices) throwing typed `TOOL` with nothing parked, the fixed `from` surviving a spoofing attempt, and the `DEADLOCK` / `EXPIRE` (injected timer) / unknown-terminal / unknown-id classifications.
- [`tests/src/core/databases/DatabaseResolver.test.ts`](../tests/src/core/databases/DatabaseResolver.test.ts) — caller-map isolation, explicit cache operations, stored-definition construction and reuse, and the typed unknown-database failure.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — the reusable workflow, terminal, database, and relation helpers; lineage coverage proves copy/freeze isolation, extension, and zero-based depth derivation. Database coverage includes `normalizeQuery` connector defaults, `resolveLimit` clamping a request to the cap and flooring a negative one at `0`, and `clampQuery` probe limits.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) — every guard at its untrusted boundary: `isWorkflowLineage` alternating/nonempty/unique validation and hostile-boundary totality, `isAgentFunction` metadata narrowing, `isColumnPrimitive` and `isColumnSpec` over the column DSL, and strict `isDatabaseDefinition` validation for `primary` / `indexes` / finite `version` with obsolete-field rejection.
- [`tests/src/core/compilers.test.ts`](../tests/src/core/compilers.test.ts) — the `TableSpec` column DSL compiled through a real `createContract` gate: every `ColumnPrimitive` accepting its own values and rejecting the others, `optional: true` admitting an absent column, `optional: false` staying required, integer separated from number, and multiple tables compiled independently.
- [`tests/src/core/shapers.test.ts`](../tests/src/core/shapers.test.ts) — every advertised shape, including valid samples of every database operation arm, create-time `primary` / `indexes` / `version`, query inputs, single/array row-key forms, and malformed metadata rejection.
- [`tests/src/core/errors.test.ts`](../tests/src/core/errors.test.ts) — `ToolboxError` carrying its `code` and its optional `context`, and `isToolboxError` narrowing a caught value (accepting a real instance, rejecting a plain `Error` / non-error value).
- [`tests/src/core/stores/MemoryDefinitionStore.test.ts`](../tests/src/core/stores/MemoryDefinitionStore.test.ts) — the memory twin against the shared `DefinitionStoreInterface` contract: round-trip, replacement, deletion, absent-id no-op, optional-metadata, and nested copy-isolation scenarios.
- [`tests/src/core/stores/DatabaseDefinitionStore.test.ts`](../tests/src/core/stores/DatabaseDefinitionStore.test.ts) — the database twin against the same contract scenarios, plus database-backed-only cases covering the default in-memory driver and malformed stored blobs.
- [`tests/src/server/factories.test.ts`](../tests/src/server/factories.test.ts) — `createTerminalRoutes` returning exactly the GET and POST records, in that order, sharing one path.
- [`tests/src/server/terminals/TerminalBridge.test.ts`](../tests/src/server/terminals/TerminalBridge.test.ts) — the bridge's own handlers, driven through the routes the factory projects: the GET route replaying every pending form as a `pending` frame then live-forwarding `pending` / `expire` events scoped to `name`, arming a keepalive `: ` comment ping through an injected `timer` that re-validates the connection's presented token on every tick (a `TerminalToken` function that starts rejecting mid-stream tears the stream down through the shared teardown and does not re-arm; a static string token is a no-op across ticks), ending the stream (unsubscribing and cancelling the keepalive) on the request's `AbortSignal` firing, and `401`/`404` on a token mismatch / unknown `name`; the POST route reading the body capped at `options.limit` bytes and parsing the JSON body and routing it through `manager.answer` — `200` and the JSON `Result` on success, `413` an over-limit body (a lying small `Content-Length` on a big streamed body still capped, `manager.answer` never called), `400` invalid JSON, `422` a non-`{ id, values }` body or a `'unknown'`/`'rejected'` answer result, `404` an unknown `name` or a `'target'` answer result, `401` on a token mismatch; mount-churn pressure (50 sequential GET connect→abort cycles) proving zero leaked keepalive timers / manager listener subscriptions and no ghost duplicate `pending` frames; POST fuzz pressure over malformed/invalid-shape bodies, unknown endpoint, bad token, and an expired id; and consumer-side stream-close self-heal — a live `pending` event or a keepalive tick arriving on a stream closed without the request `AbortSignal` ever firing runs the same teardown the abort path runs (listeners detached, keepalive cancelled), never re-arming or leaking.
- [`tests/src/server/terminals/TerminalConnection.test.ts`](../tests/src/server/terminals/TerminalConnection.test.ts) — idempotent direct opening, already-aborted request teardown, and fail-closed handling when a direct token validator throws.

## See also

- [`tool.md`](tool.md) — the `ToolInterface` / `ToolManager` runtime every tool here plugs into.
- [`workspace.md`](workspace.md) — the `WorkspaceManagerInterface` / `WorkspaceStoreInterface`, workspace errors, search options, and replace result the workspace tool drives.
- [`agent.md`](agent.md) — the `AgentRegistryInterface` / `AgentInterface` the agent tool and `createAgentFunction` resolve and run.
- [`workflow.md`](workflow.md) — the `WorkflowDefinition` / `WorkflowRunnerInterface` / `WorkflowStoreInterface` / `WorkflowFunction` primitives the workflow-authoring tool and adapters consume; native runner `WorkflowError`s pass through unchanged, while Toolbox authoring/depth/JSON guards use `ToolboxError`.
- [`contract.md`](contract.md) — the shape DSL (`createContract`, `objectShape` / `unionShape` / …) every advertised `parameters` compiles through, and `schemaToParameters`.
- [`terminal.md`](terminal.md) — a byte-identical mirror of the guide for `@orkestrel/terminal`, the `TerminalManagerInterface` / `PendingForm` / `TerminalError` primitives `createPromptTool` / `createAnswerTool` / `createTerminalRoutes` are built over, and the `PromptClient` `createTerminalRoutes` stays byte-compatible with.
- `@orkestrel/form` — the form package this seam speaks: `FormSchema` and `parseForm` / `createForm` shape what `createPromptTool` asks, `FormValues` and `isFormValues` bound what `createAnswerTool` and the POST route apply. This guide set carries no mirror of it.
- [`server.md`](server.md) — a byte-identical mirror of the guide for `@orkestrel/server`, the `createStream` SSE primitive `createTerminalRoutes`'s GET route is built over.
- [`database.md`](database.md) — a byte-identical mirror of the guide for `@orkestrel/database`, the `DatabaseInterface` / `DriverInterface` / `QueryInput` / `TableMap` primitives `createDatabaseTool` (and, underneath it, `createRelationTool`) is built over.
- [`relation.md`](relation.md) — a byte-identical mirror of the guide for `@orkestrel/relation`, the `RelationManagerInterface` / `ModelInterface` / `Include` primitives `createRelationTool` is built over.
- [`AGENTS.md`](../AGENTS.md) — the rules; narrow untrusted input with guards, and keep documentation as an enforced contract.
- [`README.md`](README.md) — the guides index.
