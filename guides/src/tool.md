# Tool

> Concrete, LLM-callable **tools** for the `@orkestrel` line — workflow authoring, workspace editing, and sub-agent delegation — over [`@orkestrel/agent`](agent.md)'s `ToolInterface` / `createTool` runtime, with pluggable stores. The runtime supplies the CALL SHAPE (`Tool`, `ToolManager`, the `{ id, name, value }` / `{ id, name, error }` envelope); this package supplies the CONCRETE BEHAVIOR — one factory per tool, each a `handler` that parses model-supplied args against a compiled [contract](contract.md), dispatches, and either returns a plain value or throws a typed error, exactly the shape the runtime's `ToolManagerInterface.execute` isolates.

`createWorkflowTool` and `createWorkspaceTool` own their FULL handler logic (ported byte-faithfully from `@orkestrel/workflow` / `@orkestrel/agent` ahead of the upstream cleanup that drops the authoring surface from those packages — this package is now the defining home) and layer a pluggable `store` slot on top; `createAgentTool` (sub-agent delegation over an `AgentRegistryInterface`) layers its OWN pluggable `store` slot too — a `ConversationStoreInterface` (`@orkestrel/agent`) that persists each delegation's sub-agent conversation on settle. All three tools, plus `createWorkspaceTool`, additionally advertise a lean `summary` (`@orkestrel/agent` 0.0.4's `ToolInterface.summary` / `ToolManagerInterface.definitions()` projection) in place of their full teaching `description`; `createDescribeTool` is the net-new on-demand expansion seam — given a registered tool's name, it returns that tool's full `description`. The two workflow-function adapters `createToolFunction` / `createAgentFunction` compose a `@orkestrel/agent` tool or a live agent into a workflow's `functions` registry; the authoring umbrella (`WorkflowSteps` / `WorkflowDraft` shapes, `createWorkflowDraftContract`, `expandSteps` / `completeDraft`, `workflowToolSummary`, `MAX_WORKFLOW_DEPTH`) is what lets a small model author a whole tree in one call.

`createPromptTool` / `createAnswerTool` are the ASK / ANSWER halves of a terminal-mediated human-in-the-loop seam over a live `TerminalManagerInterface` (`@orkestrel/terminal`): `createPromptTool` BLOCKS the calling agent turn until the addressed terminal answers (`from` FIXED at construction, `to` supplied per call), re-surfacing a prompt cycle as `DEADLOCK` and an unanswered expiry as `EXPIRE`; `createAnswerTool` lists / answers the prompts addressed to a FIXED `to` terminal, coercing the model-supplied `value` to the original prompt's form before applying it, re-surfacing a failed apply as `ANSWER`. `createTerminalRoutes` ([`src/server`](../../src/server), the `@src/server` barrel) is the wire bridge for the SAME manager — two structural `{ method, path, handler }` route records (GET SSE stream + POST answer, one shared `:name`-templated path), carrying NO dependency on `@orkestrel/router`'s own `Route` type so a consumer mounts them against any router accepting that two-arg handler shape, and byte-compatible with `@orkestrel/terminal`'s own `PromptClient` (same GET url streams, same POST url answers, same `{ id, value }` body, same `x-orkestrel-token` header).

`createInferTool` / `createEndpointTool` bridge an EXISTING API/DB surface into an LLM-callable `ToolInterface` over `@orkestrel/contract`'s sample-based schema inference — `createInferTool` a standalone utility a model calls to learn a JSON Schema from example values, `createEndpointTool` wrapping one concrete endpoint whose inferred `parameters` steer the model AND, by default, are ENFORCED at `execute` time (`EndpointToolOptions.validate`, default `true`; `validate: false` restores raw passthrough — see the Contract invariant below).

Source: [`src/core`](../../src/core) (the tool factories) and [`src/server`](../../src/server) (the terminal-routes wire bridge). Surfaced through the `@src/core` and `@src/server` barrels respectively.

## Surface

### Factories

| API                             | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createToolFunction`            | function | Wrap a registered tool as a `WorkflowFunction` — the OPT-IN adapter for a `function`-form task that runs a `@orkestrel/agent` tool BY NAME.                                                                                                                                                                                                                       |
| `createAgentFunction`           | function | Wrap a live `AgentInterface` as a `WorkflowFunction`, folding the nested-workflow depth/cycle guard into its own closure.                                                                                                                                                                                                                                         |
| `createWorkflowDraftContract`   | function | Compile the LENIENT DRAFT `ContractInterface` — like the strict `createWorkflowContract` but `id`/`name` optional at all three levels.                                                                                                                                                                                                                            |
| `createWorkflowTool`            | function | Wrap a `WorkflowDefinition` as an LLM-callable `ToolInterface` advertising the FLAT authoring shape, with an optional pluggable `WorkflowStoreInterface`.                                                                                                                                                                                                         |
| `createWorkspaceTool`           | function | Build the 13-operation workspace-editing `ToolInterface`, driving a caller `WorkspaceManagerInterface` OR a manager built over a pluggable `WorkspaceStoreInterface`.                                                                                                                                                                                             |
| `createAgentTool`               | function | Build the sub-agent delegation `ToolInterface` — resolves + runs one seeded agent via an `AgentRegistryInterface`, depth/cycle guarded, with an optional pluggable `ConversationStoreInterface`.                                                                                                                                                                  |
| `createDescribeTool`            | function | Build the `ToolInterface` that returns another registered tool's full `description` by name — the expansion seam for the other three tools' lean `summary`.                                                                                                                                                                                                       |
| `createPromptTool`              | function | Build the ASK-side `ToolInterface` over a live `TerminalManagerInterface` — asks a per-call `to` and BLOCKS until it answers; `from` FIXED at construction. A `'select'` / `'checkbox'` call with no `choices` rejects up front with a typed `TOOL` `AgentToolError` rather than parking an unanswerable prompt.                                                  |
| `createAnswerTool`              | function | Build the ANSWER-side `ToolInterface` over a live `TerminalManagerInterface` — lists / answers the prompts addressed to a FIXED `to`.                                                                                                                                                                                                                             |
| `createDatabaseTool`            | function | Build the `operation`-discriminated `ToolInterface` (create/tables/get/records/count/aggregate/add/set/update/remove/migrate/destroy) driving `@orkestrel/database` databases, resolved lazily and cached, with an optional pluggable `DefinitionStoreInterface`.                                                                                                 |
| `createRelationTool`            | function | Build the `operation`-discriminated `ToolInterface` (load/find/link/unlink/links) traversing/editing `@orkestrel/relation` relationships over a registry of live `RelationManagerInterface`s.                                                                                                                                                                     |
| `createMemoryDefinitionStore`   | function | Create the in-memory `DefinitionStoreInterface` — a process-lifetime `Map` of `DatabaseDefinition` configs, the DEFAULT store `createDatabaseTool` persists through.                                                                                                                                                                                              |
| `createDatabaseDefinitionStore` | function | Create a `DefinitionStoreInterface` backed by one `@orkestrel/database` table — the driver-pluggable twin of `createMemoryDefinitionStore`, storing each definition as one opaque JSON column.                                                                                                                                                                    |
| `createInferTool`               | function | Build a standalone `ToolInterface` that infers a JSON Schema (as a `parameters`-shaped record) from one or more example `samples` — the utility half of the API/DB → MCP bridge. An optional `candidates` call arg checks values against the freshly inferred schema (strict `.is` guard, no coercion) and wraps the return as `{ parameters, checks }`.          |
| `createEndpointTool`            | function | Wrap one concrete `EndpointDefinition` as a `ToolInterface` — `parameters` inferred ONCE at construction from `samples`; by default `execute` ENFORCES that same schema against the call's args before `invoke` runs, throwing a typed `TOOL` error with structured faults on rejection (`validate: false` restores raw passthrough — see Contract invariant 23). |

### Stores

Concrete `DefinitionStoreInterface` implementations (AGENTS §5 — Stores, point-access mold): `MemoryDefinitionStore` the in-memory default, `DatabaseDefinitionStore` the driver-pluggable twin over one `@orkestrel/database` table. Both are exact twins — same `get` / `set` / `delete` behavior, different backing storage.

| API                       | Kind  | Summary                                                                                                                                                       |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryDefinitionStore`   | class | The in-memory `DefinitionStoreInterface` — a process-lifetime `Map` of `DatabaseDefinition`s keyed by id; no idle-TTL, no eviction.                           |
| `DatabaseDefinitionStore` | class | The `DefinitionStoreInterface` backed by one `@orkestrel/database` `TableInterface` — the definition stored as one opaque JSON column (`{ id, definition }`). |

### Lifecycle entities

These implementation classes are available when consumers need direct lifecycle composition.
The factories `createDatabaseTool` and `createTerminalRoutes` remain the compact entry points.

| API                  | Kind  | Summary                                                                                                                                           |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DatabaseResolver`   | class | Resolve and cache a database handle from the tool's live handles, stored definitions, driver registry, and key function.                          |
| `TerminalRoutes`     | class | Own the shared terminal-route options and bound GET/POST handlers projected by `createTerminalRoutes`.                                            |
| `TerminalConnection` | class | Own one SSE connection's replay, listener subscriptions, keepalive revalidation, self-healing teardown, and exact optional wire-id serialization. |

### Errors

| API                | Kind     | Summary                                                                                                                                                                                                                                                                                                                       |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentToolError`   | class    | Carries an `AgentToolErrorCode` (`TOOL` / `DEPTH` / `DEADLOCK` / `EXPIRE` / `ANSWER` / `DATABASE` / `RELATION`) + an optional `context` — this package's general tool-call error, thrown by `createAgentTool` / `createDescribeTool` / `createPromptTool` / `createAnswerTool` / `createDatabaseTool` / `createRelationTool`. |
| `isAgentToolError` | function | Narrow an unknown caught value to an `AgentToolError`.                                                                                                                                                                                                                                                                        |

### Helpers

Pure, side-effect-free, exhaustively unit-tested (AGENTS §4.3 / §14) — the lenient-authoring synthesis path and the ancestry tags shared by both delegating tools.

| API                    | Kind     | Behavior                                                                                                                                                                                                                                  |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowTag`          | function | The ancestry identifier of a workflow in a run chain — `workflow:<id>`.                                                                                                                                                                   |
| `agentTag`             | function | The ancestry identifier of an agent in a run chain — `agent:<name>`.                                                                                                                                                                      |
| `workflowToolSummary`  | function | Build the plain success value `createWorkflowTool` returns on a completed run — `{ status, count }`.                                                                                                                                      |
| `completeDraft`        | function | Complete a `WorkflowDraft` into a strict `WorkflowDefinition` — synthesize missing ids positionally, default missing names to their id.                                                                                                   |
| `completePhaseDraft`   | function | Complete one `PhaseDraft` into a strict phase definition — the per-phase step of `completeDraft`.                                                                                                                                         |
| `completeTaskDraft`    | function | Complete one `TaskDraft` into a strict task definition — the per-task leaf step of `completeDraft`.                                                                                                                                       |
| `expandSteps`          | function | Expand a flat `WorkflowSteps` blob into a strict `WorkflowDefinition` — each step becomes a one-task phase, in order.                                                                                                                     |
| `coerceAnswer`         | function | Normalize an LLM-supplied answer `value` to a `PromptType`'s own shape — `boolean` for `confirm`, `readonly string[]` for `checkbox`, `string` otherwise; pure and total.                                                                 |
| `terminalToolCode`     | function | Classify a caught error into an `AgentToolErrorCode` for `createPromptTool` / `createAnswerTool` — `TerminalError('DEADLOCK'\|'EXPIRE')` maps 1:1, every other `TerminalError` maps to `TOOL`, a non-`TerminalError` returns `undefined`. |
| `isColumnKind`         | function | Narrow an unknown value to a `ColumnKind` (`'string'` / `'integer'` / `'number'` / `'boolean'`).                                                                                                                                          |
| `isColumnSpec`         | function | Narrow an unknown value to a `ColumnSpec` — a valid `ColumnKind` shorthand, or `{ type, optional }` with a valid `type`.                                                                                                                  |
| `expandTables`         | function | Compile a `TableSpec` into the `@orkestrel/database` `TablesShape` it configures — each `ColumnSpec` maps to its primitive shaper, wrapped in `optionalShape` when `optional: true`.                                                      |
| `columnShape`          | function | Compile one `ColumnSpec` into its `@orkestrel/database` column shape — the per-column leaf `expandTables` maps over.                                                                                                                      |
| `kindShape`            | function | Map one `ColumnKind` to its primitive `@orkestrel/database` shape — the leaf `columnShape` wraps.                                                                                                                                         |
| `isDatabaseDefinition` | function | Narrow an unknown value to a `DatabaseDefinition` — the boundary guard a `DefinitionStoreInterface` applies to an untrusted persisted blob.                                                                                               |
| `databaseToolCode`     | function | Map a caught error to the granular `DatabaseErrorCode`, or `undefined` if `error` is not a `DatabaseError` — the classification step `createDatabaseTool` / `createRelationTool` throw a `DATABASE` `AgentToolError` from.                |
| `relationToolCode`     | function | Map a caught error to the granular `RelationErrorCode`, or `undefined` if `error` is not a `RelationError` — the classification step `createRelationTool` throws a `RELATION` `AgentToolError` from.                                      |
| `expandInclude`        | function | Expand a flat dot-path `include` list into a live `@orkestrel/relation` `Include` tree; an empty segment or a path exceeding `depth` throws a typed `TOOL` `AgentToolError`.                                                              |
| `relationManagerOf`    | function | Resolve which registered `RelationManagerInterface` a relation-tool call addresses — an explicit `name` miss, or an omitted `name` with more/less than one registered manager, throws a typed `TOOL` `AgentToolError`.                    |
| `relationModelOf`      | function | Resolve a `model` name against a live `RelationManagerInterface` — an unknown model throws a typed `TOOL` `AgentToolError`.                                                                                                               |
| `clampCriteria`        | function | Clamp a `'records'` / `'find'` call's criteria to a row cap, and build the PROBE criteria (`limit` bumped by one) used to detect truncation without a separate `count` round trip.                                                        |
| `criteriaOf`           | function | Normalize the database tool's parsed SERIALIZED criteria into a live `@orkestrel/database` `Criteria` — defaults each condition's omitted `connector` to `'and'`.                                                                         |
| `columnSchema`         | function | Map a column name + its live `@orkestrel/database` `ContractShape` to a `ColumnSchema` — the leaf `tableSchema` maps over.                                                                                                                |
| `tableSchema`          | function | Build one `TableSchema` from a table name and its `@orkestrel/database` `TableExport` — the deployed schema `'migrate'` diffs against, derived from a live handle's own `export()`.                                                       |

### Shapes

The shape VALUES each `create*Tool` factory (and `createWorkflowDraftContract`) compiles into the lockstep guard / parser / JSON Schema outputs (AGENTS §14); `agentToolShape` agrees with the hand-written `AgentToolArguments`, the source of truth.

| API                  | Kind  | Summary                                                                                                                                                                                   |
| -------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentToolShape`     | const | The shape of `AgentToolArguments` — `createAgentTool`'s advertised `parameters` (`task` required, `provider`/`tools`/`system` optional overrides).                                        |
| `taskDraftShape`     | const | The DRAFT task shape — like a strict task shape but `id`/`name` optional.                                                                                                                 |
| `phaseDraftShape`    | const | The DRAFT phase shape — `id`/`name` optional, holding `taskDraftShape` tasks.                                                                                                             |
| `workflowDraftShape` | const | The DRAFT workflow shape `createWorkflowDraftContract` compiles — `id`/`name` optional at all three levels.                                                                               |
| `stepShape`          | const | The flat STEP shape — `{ name }`, the building block of `workflowStepsShape`.                                                                                                             |
| `workflowStepsShape` | const | The FLAT shape `createWorkflowTool` advertises as its `parameters` — `{ name?, steps: [{ name }] }`.                                                                                      |
| `workspaceToolShape` | const | The 13-arm `operation`-discriminated union `createWorkspaceTool` advertises as its `parameters`.                                                                                          |
| `describeToolShape`  | const | The shape of `DescribeToolArguments` — `createDescribeTool`'s advertised `parameters` (`name` required).                                                                                  |
| `promptToolShape`    | const | The shape of `createPromptTool`'s call args — `to` / `form` / `message` required, every per-form optional field flattened onto one object.                                                |
| `answerToolShape`    | const | The `operation`-discriminated shape of `createAnswerTool`'s call args — `pending` (no fields) or `answer` (`id` + form-typed `value`).                                                    |
| `databaseToolShape`  | const | The 12-arm `operation`-discriminated union `createDatabaseTool` advertises as its `parameters` (create/tables/get/records/count/aggregate/add/set/update/remove/migrate/destroy).         |
| `columnKindShape`    | const | A `ColumnKind` literal — the leaf `columnSpecShape` wraps.                                                                                                                                |
| `columnSpecShape`    | const | A `ColumnSpec` — a bare `columnKindShape`, or `{ type, optional }`.                                                                                                                       |
| `tableSpecShape`     | const | A `TableSpec` — table name to `{ columns }`, each column a `columnSpecShape`.                                                                                                             |
| `keyShape`           | const | One database row key value — a string or number; the array form (multiple keys, positional) resolves first per AGENTS §9.2.                                                               |
| `rowShape`           | const | A loose database row — a flat object of column name to JSON value.                                                                                                                        |
| `rowsShape`          | const | One or many loose database rows — the array form resolves first per AGENTS §9.2.                                                                                                          |
| `conditionShape`     | const | One SERIALIZED WHERE condition — `values` is always an array, even for a single-value operator.                                                                                           |
| `orderShape`         | const | One sort term — `{ column, direction }`.                                                                                                                                                  |
| `criteriaShape`      | const | The SERIALIZED criteria form — conditions, order, and pagination.                                                                                                                         |
| `relationToolShape`  | const | The 5-arm `operation`-discriminated union `createRelationTool` advertises as its `parameters` (load/find/link/unlink/links).                                                              |
| `relationKeyShape`   | const | One relation row key value — a string or number; the array form (multiple keys, positional) resolves first per AGENTS §9.2.                                                               |
| `singleKeyShape`     | const | A single relation row key (not an array) — used by `'link'` / `'unlink'` / `'links'`, which address exactly one owning row.                                                               |
| `includeShape`       | const | Flat dot-path relation include list, expanded via `expandInclude`.                                                                                                                        |
| `managerShape`       | const | Which registered relation manager to address — omitted resolves to the sole registered manager.                                                                                           |
| `inferToolShape`     | const | The shape of `createInferTool`'s call args — `samples` (array, `min: 1`) plus optional `format` / `enum` toggles and an optional `candidates` array to check against the inferred schema. |

### Constants

| Constant                       | Kind  | Value                                                                                                                                                                                    |
| ------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_TOOL_NAME`              | const | The name (`'agent'`) `createAgentTool` advertises by default.                                                                                                                            |
| `AGENT_TOOL_DEPTH`             | const | The maximum sub-agent delegation nesting depth (`8`) — deliberately a SEPARATE constant from `MAX_WORKFLOW_DEPTH`.                                                                       |
| `AGENT_TOOL_DESCRIPTION`       | const | The multi-line description `createAgentTool` advertises — `task` required, `provider`/`tools`/`system` per-call overrides.                                                               |
| `AGENT_TOOL_SUMMARY`           | const | The lean one-sentence `summary` `createAgentTool` advertises in place of `AGENT_TOOL_DESCRIPTION` (`ToolInterface.summary`).                                                             |
| `MAX_WORKFLOW_DEPTH`           | const | The maximum nesting depth a workflow → agent → workflow chain may reach — owned here now (ported from `@orkestrel/workflow`).                                                            |
| `WORKFLOW_TOOL_NAME`           | const | The name (`'workflow'`) `createWorkflowTool` advertises by default, and the key `createAgentFunction` binds a nested tool under.                                                         |
| `WORKFLOW_TOOL_FLAT_EXAMPLE`   | const | A complete FLAT authoring example (`{ name, steps: [{ name }] }`) embedded verbatim in `WORKFLOW_TOOL_DESCRIPTION`.                                                                      |
| `WORKFLOW_TOOL_NESTED_EXAMPLE` | const | A minimal NESTED authoring example (a full `WorkflowDefinition`) — the advanced-form example in the description.                                                                         |
| `WORKFLOW_TOOL_DESCRIPTION`    | const | The multi-line description `createWorkflowTool` advertises — the flat form (primary) + the nested form (advanced).                                                                       |
| `WORKFLOW_TOOL_SUMMARY`        | const | The lean one-sentence `summary` `createWorkflowTool` advertises in place of `WORKFLOW_TOOL_DESCRIPTION`.                                                                                 |
| `WORKSPACE_TOOL_NAME`          | const | The name (`'workspace'`) `createWorkspaceTool` advertises by default.                                                                                                                    |
| `WORKSPACE_TOOL_EXAMPLE`       | const | A valid `WorkspaceOperation` (a `'write'` op) embedded verbatim in `WORKSPACE_TOOL_DESCRIPTION`.                                                                                         |
| `WORKSPACE_TOOL_DESCRIPTION`   | const | The multi-line description `createWorkspaceTool` advertises — every operation's flat fields + a worked example.                                                                          |
| `WORKSPACE_TOOL_SUMMARY`       | const | The lean one-sentence `summary` `createWorkspaceTool` advertises in place of `WORKSPACE_TOOL_DESCRIPTION`.                                                                               |
| `DESCRIBE_TOOL_NAME`           | const | The name (`'describe'`) `createDescribeTool` advertises by default.                                                                                                                      |
| `DESCRIBE_TOOL_SUMMARY`        | const | The lean one-sentence `summary` `createDescribeTool` advertises (short — this tool needs no teaching).                                                                                   |
| `DESCRIBE_TOOL_DESCRIPTION`    | const | The short description `createDescribeTool` advertises — `name` required, returns the named tool's full description.                                                                      |
| `PROMPT_TOOL_NAME`             | const | The name (`'ask'`) `createPromptTool` advertises by default.                                                                                                                             |
| `PROMPT_TOOL_SUMMARY`          | const | The lean one-sentence `summary` `createPromptTool` advertises in place of `PROMPT_TOOL_DESCRIPTION`.                                                                                     |
| `PROMPT_TOOL_DESCRIPTION`      | const | The multi-line description `createPromptTool` advertises — `to`/`form`/`message` required, form-specific optional fields, a worked example.                                              |
| `ANSWER_TOOL_NAME`             | const | The name (`'answer'`) `createAnswerTool` advertises by default.                                                                                                                          |
| `ANSWER_TOOL_SUMMARY`          | const | The lean one-sentence `summary` `createAnswerTool` advertises in place of `ANSWER_TOOL_DESCRIPTION`.                                                                                     |
| `ANSWER_TOOL_DESCRIPTION`      | const | The multi-line description `createAnswerTool` advertises — the `pending` / `answer` operations, each with a worked example.                                                              |
| `DATABASE_TOOL_NAME`           | const | The name (`'database'`) `createDatabaseTool` advertises by default.                                                                                                                      |
| `DATABASE_TOOL_SUMMARY`        | const | The lean one-sentence `summary` `createDatabaseTool` advertises in place of `DATABASE_TOOL_DESCRIPTION`.                                                                                 |
| `DATABASE_TOOL_DESCRIPTION`    | const | The multi-line description `createDatabaseTool` advertises — the 12 operations, the SERIALIZED criteria form, the `TableSpec` column DSL, worked examples.                               |
| `DATABASE_TOOL_LIMIT`          | const | The default cap (`1000`) on rows a `'records'` / `'remove'` call returns (or acts on) when the caller omits `criteria.limit`.                                                            |
| `DATABASE_TOOL_MUTATIONS`      | const | The database tool's mutating operations — disabled by `DatabaseToolOptions.readonly`.                                                                                                    |
| `RELATION_TOOL_NAME`           | const | The name (`'relation'`) `createRelationTool` advertises by default.                                                                                                                      |
| `RELATION_TOOL_SUMMARY`        | const | The lean one-sentence `summary` `createRelationTool` advertises in place of `RELATION_TOOL_DESCRIPTION`.                                                                                 |
| `RELATION_TOOL_DESCRIPTION`    | const | The multi-line description `createRelationTool` advertises — the 5 operations and the flat dot-path `include` syntax, a worked example.                                                  |
| `RELATION_TOOL_LIMIT`          | const | The default cap (`1000`) on rows a `'find'` / `'links'` call returns when the caller omits `limit`.                                                                                      |
| `RELATION_TOOL_DEPTH`          | const | The default cap (`3`) on how many `include` path segments deep a `'load'` / `'find'` call may traverse.                                                                                  |
| `INFER_TOOL_NAME`              | const | The name (`'infer'`) `createInferTool` advertises by default.                                                                                                                            |
| `INFER_TOOL_SUMMARY`           | const | The lean one-sentence `summary` `createInferTool` advertises in place of `INFER_TOOL_DESCRIPTION`.                                                                                       |
| `INFER_TOOL_DESCRIPTION`       | const | The multi-line description `createInferTool` advertises — `samples` required, `format`/`enum`/`candidates` optional, worked examples for both the bare and `candidates`-wrapped returns. |

### Types

| Type                       | Kind      | Shape                                                                                                                                                                                                                                                                             |
| -------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskDraft`                | interface | `{ id?, name?, description?, run?, retries?, timeout? }` — a `TaskDefinition` (`@orkestrel/workflow`) with OPTIONAL id/name.                                                                                                                                                      |
| `PhaseDraft`               | interface | `{ id?, name?, description?, tasks, concurrency?, bail? }` — a `PhaseDefinition` with OPTIONAL id/name + `TaskDraft` tasks.                                                                                                                                                       |
| `WorkflowDraft`            | interface | `{ id?, name?, description?, phases, bail? }` — a `WorkflowDefinition` with OPTIONAL id/name at all three levels.                                                                                                                                                                 |
| `WorkflowStep`             | interface | `{ name }` — one flat step; `name` is a REGISTERED behavior name (becomes the task's `run`, not a human label).                                                                                                                                                                   |
| `WorkflowSteps`            | interface | `{ name?, steps }` — the FLAT authoring blob `createWorkflowTool` advertises; each step → a one-task phase via `expandSteps`.                                                                                                                                                     |
| `AgentFunctionOptions`     | interface | `{ runner?, depth?, ancestry? }` — options for `createAgentFunction`: the OPT-IN nested-workflow-tool binding + depth/cycle bookkeeping.                                                                                                                                          |
| `WorkflowToolOptions`      | interface | `{ depth?, ancestry?, store? }` — the depth + ancestry a nested run is bound at, plus the optional durable `WorkflowStoreInterface`.                                                                                                                                              |
| `WorkspaceToolOptions`     | interface | `{ name?, description?, manager?, store? }` — a caller-built `WorkspaceManagerInterface` to drive directly, OR a `WorkspaceStoreInterface` to build one over.                                                                                                                     |
| `WorkspaceOperation`       | type      | The 13-arm `operation`-discriminated union `createWorkspaceTool` dispatches — `read` / `list` / `has` / `search` / `replace` / `write` / `splice` / `prepend` / `append` / `move` / `remove` / `workspaces` / `switch`.                                                           |
| `AgentToolOptions`         | interface | `{ name?, description?, provider?, tools?, system?, depth?, ancestry?, store? }` — `createAgentTool`'s delegation defaults, nesting bookkeeping, and optional `ConversationStoreInterface`.                                                                                       |
| `AgentToolArguments`       | interface | `{ task, provider?, tools?, system? }` — the flat call args `createAgentTool` accepts.                                                                                                                                                                                            |
| `AgentToolErrorCode`       | type      | `'TOOL' \| 'DEPTH' \| 'DEADLOCK' \| 'EXPIRE' \| 'ANSWER' \| 'DATABASE' \| 'RELATION'` — the machine-readable code an `AgentToolError` carries (`DATABASE` / `RELATION` carrying the granular upstream error code in `context.code`).                                              |
| `DescribeToolArguments`    | interface | `{ name }` — the flat call args `createDescribeTool` accepts (the registered tool name to describe).                                                                                                                                                                              |
| `PromptToolOptions`        | interface | `{ manager, from, name?, description? }` — `createPromptTool`'s live `TerminalManagerInterface`, the FIXED `from` identity, and advertised overrides.                                                                                                                             |
| `AnswerToolOptions`        | interface | `{ manager, to, name?, description? }` — `createAnswerTool`'s live `TerminalManagerInterface`, the FIXED `to` identity, and advertised overrides.                                                                                                                                 |
| `ColumnKind`               | type      | `'string' \| 'integer' \| 'number' \| 'boolean'` — one column's declared primitive type.                                                                                                                                                                                          |
| `ColumnSpec`               | type      | A bare `ColumnKind` shorthand, or `{ type, optional? }` when the column may be absent from a row.                                                                                                                                                                                 |
| `TableSpec`                | type      | A database's table layout — one entry per table, each `{ columns: Record<string, ColumnSpec> }`; `expandTables` compiles it into an `@orkestrel/database` `TablesShape`.                                                                                                          |
| `DatabaseDefinition`       | interface | `{ id, driver, tables, keys? }` — a database's CONFIG-ONLY definition (never a live handle); the durable blueprint `createDatabaseTool` builds a live database from and a `DefinitionStoreInterface` persists.                                                                    |
| `DatabaseDefinitionRow`    | interface | `{ id, definition }` — one opaque persisted row (`definition: unknown`, narrowed with `isDatabaseDefinition` on read) — the shape `DatabaseDefinitionStore`'s backing table reads/writes.                                                                                         |
| `DefinitionStoreInterface` | interface | `{ get, set, delete }` — the point-access persistence seam for `DatabaseDefinition` configs (AGENTS §5 — Stores); every primitive async, `delete` of an absent id a no-op.                                                                                                        |
| `DatabaseToolOptions`      | interface | `{ name?, description?, databases?, store?, drivers?, key?, limit?, timeout?, readonly? }` — `createDatabaseTool`'s seed handles, optional `DefinitionStoreInterface`, driver registry, key function, row cap, per-call timeout, and mutation lock.                               |
| `RelationToolOptions`      | interface | `{ name?, description?, managers, limit?, depth? }` — `createRelationTool`'s REQUIRED live `RelationManagerInterface` registry, row cap, and `include` depth cap.                                                                                                                 |
| `InferToolOptions`         | interface | `{ name?, description? }` — `createInferTool`'s advertised overrides; `format`/`enum` are RUNTIME call args, not construction options.                                                                                                                                            |
| `EndpointHandler`          | type      | `(args: Readonly<Record<string, unknown>>) => Promise<unknown> \| unknown` — mirrors `@orkestrel/agent`'s `ToolOptions.execute` signature EXACTLY, so `execute: (args) => definition.invoke(args)` typechecks with zero assertions.                                               |
| `EndpointDefinition`       | interface | `{ name, description, samples, invoke }` — one concrete endpoint `createEndpointTool` wraps; `samples` MUST be non-empty (checked at construction).                                                                                                                               |
| `EndpointToolOptions`      | interface | `{ format?, enum?, validate? }` — construction-time inference tuning for `createEndpointTool`'s advertised `parameters` (`format`/`enum` default `false`), plus whether that schema is ENFORCED at `execute` time (`validate` defaults `true`; `false` restores raw passthrough). |

### Server routes

The wire bridge for a `TerminalManagerInterface` — a GET SSE stream + a POST answer endpoint, both mounted on the same `:name`-templated path, returned as plain structural records carrying NO dependency on `@orkestrel/router`'s own `Route` type ([`src/server`](../../src/server), surfaced through `@src/server`).

| API                     | Kind      | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createTerminalRoutes`  | function  | Build the two `TerminalRoute` records (GET SSE, POST answer) bridging a `TerminalManagerInterface`'s endpoints onto the wire, byte-compatible with `PromptClient`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Method`                | type      | The HTTP method literal a `TerminalRoute` declares — the exact 7-literal union `@orkestrel/router`'s `Method` accepts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `TerminalRouteContext`  | interface | `{ params }` — the minimal route-dispatch context a `TerminalRoute` handler reads (the frozen, URL-decoded `:name` path param).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `TerminalRoute`         | interface | `{ method, path, handler }` — one structural route record `createTerminalRoutes` returns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `TerminalRoutesOptions` | interface | `{ path?, token?, keepalive?, timer?, limit? }` — the shared mount path, optional `TerminalToken` gate, SSE keepalive interval, injected `TimerHandler`, and POST body byte cap (defaults to `@orkestrel/server`'s `DEFAULT_BODY_LIMIT`, 1 MiB; a non-finite limit also defaults, a negative limit clamps to zero, and over-limit input is `413`, ignoring any `Content-Length` header).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `TerminalToken`         | type      | `string \| ((value: string \| undefined) => boolean)` — the `token` gate: a string is compared for equality against the `x-orkestrel-token` header; a function is a consumer-controlled validator (JWT `exp` checks, revocation lookups, anything time-varying), letting a token expire or rotate mid-stream. Validated at GET connect, on every POST, and RE-VALIDATED on every SSE keepalive tick — a stream whose presented token stops validating is torn down through the same abort/self-heal teardown path (no `shutdown` frame; the client reconnects and re-authenticates). Because re-validation only happens on the keepalive tick, the revocation window equals the keepalive interval — a rejected/expired token keeps streaming until the next tick — and a throwing validator is treated as rejection (fail-closed) at every call site. |
| `TERMINAL_ROUTES_PATH`  | const     | The default `:name`-templated path (`/terminals/:name`) `createTerminalRoutes` mounts its routes under.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `TERMINAL_KEEPALIVE_MS` | const     | The default SSE keepalive interval in milliseconds (`15_000`) `createTerminalRoutes` arms per open connection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

> A reconnecting SSE client replays every currently-pending prompt from the top on EVERY (re)connect (the GET handler's replay loop), so a raw `EventSource` (or any hand-rolled consumer that isn't `PromptClient`) MUST dedupe `pending` frames by their SSE `id` — the same prompt id may arrive more than once across a reconnect. `PromptClient` (`@orkestrel/terminal`) already does this; a consumer bypassing it does not get the dedupe for free.
>
> Fan-out is `O(total connections)` per `pending` / `expire` event on ONE manager — every open GET stream for every endpoint on that manager runs its scoped listener on each emit (filtered by `to === name` inside the handler, not before). This is fine at ordinary connection counts; a workload with very many concurrently-open streams across many endpoints on one manager is the lever to reach for — per-endpoint sharding (one manager, or one emitter subscription, per endpoint) — if fan-out cost ever becomes material. Not implemented here; noted as the scaling lever, not a current limitation.

## Methods

Every `create*Tool` factory returns a plain `ToolInterface` (`@orkestrel/agent`'s own type — its method surface is documented in [`agent.md`](agent.md), not re-documented here), and `createAgentFunction` / `createToolFunction` return a plain `WorkflowFunction` (`@orkestrel/workflow`'s own type — see [`workflow.md`](workflow.md)). The `WorkspaceManagerInterface` / `WorkflowRunnerInterface` / `AgentRegistryInterface` a caller supplies are likewise defined and documented upstream. `DefinitionStoreInterface` is the point-access persistence seam `MemoryDefinitionStore` / `DatabaseDefinitionStore` implement; the lifecycle classes expose their minimal orchestration methods directly.

#### `DefinitionStoreInterface`

| Method   | Returns                                    | Behavior                                                                     |
| -------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `get`    | `Promise<DatabaseDefinition \| undefined>` | Resolve the persisted definition for `id`, or `undefined` if none is stored. |
| `set`    | `Promise<void>`                            | Insert / replace under the definition's OWN `id` (no separate id param).     |
| `delete` | `Promise<void>`                            | Drop the definition for `id`; an absent id is a no-op (never throws).        |

#### `DatabaseResolver`

| Method    | Returns                          | Behavior                                                                |
| --------- | -------------------------------- | ----------------------------------------------------------------------- |
| `has`     | `boolean`                        | Report whether a live database is cached by id.                         |
| `get`     | `DatabaseInterface \| undefined` | Read a cached database without consulting the definition store.         |
| `set`     | `void`                           | Cache a live database by id.                                            |
| `delete`  | `void`                           | Remove a cached live database by id.                                    |
| `resolve` | `Promise<DatabaseInterface>`     | Return a cached live database, or construct one from its stored config. |

#### `TerminalRoutes`

| Method   | Returns                    | Behavior                                                    |
| -------- | -------------------------- | ----------------------------------------------------------- |
| `routes` | `readonly TerminalRoute[]` | Project the bound GET stream and POST answer route records. |

#### `TerminalConnection`

| Method | Returns    | Behavior                                                                 |
| ------ | ---------- | ------------------------------------------------------------------------ |
| `open` | `Response` | Replay pending prompts, subscribe to live events, and arm the keepalive. |

### Composing lifecycle entities directly

```ts
import type { DatabaseInterface } from '@orkestrel/database'
import type { DefinitionStoreInterface } from '@orkestrel/tool'
import { createMemoryDriver, generateUUID } from '@orkestrel/database'
import { DatabaseResolver } from '@orkestrel/tool'

declare const database: DatabaseInterface
declare const store: DefinitionStoreInterface

const resolver = new DatabaseResolver(
	new Map(),
	{ memory: createMemoryDriver },
	generateUUID,
	store,
)
resolver.has('shop')
resolver.set('shop', database)
resolver.get('shop')
resolver.delete('shop')
await resolver.resolve('shop')
```

```ts
import type { StreamInterface } from '@orkestrel/server'
import type { TerminalManagerInterface, TimerHandler } from '@orkestrel/terminal'
import { TerminalConnection, TerminalRoutes } from '@orkestrel/tool/server'

declare const manager: TerminalManagerInterface
declare const request: Request
declare const stream: StreamInterface
declare const accepts: (presented: string | undefined) => boolean
declare const timer: TimerHandler

new TerminalRoutes(manager).routes()
const connection = new TerminalConnection(
	manager,
	'assistant',
	request,
	stream,
	accepts,
	timer,
	15_000,
)
connection.open()
```

## Contract

These invariants hold across `src/core` ↔ `tool.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `const` / `interface` / `type` row in the `## Surface` tables is a real export of `src/core`, and every export appears as a Surface row — exhaustive, both directions (AGENTS §22).

2. **One tool = one behavior; the runtime supplies the envelope, this package supplies the handler.** Each `create*Tool` factory returns a plain `ToolInterface` (`@orkestrel/agent`) — `name` / `description` / `parameters` / `execute`. The handler PARSES the model-supplied `args` against a compiled [contract](contract.md), dispatches, and either RETURNS a plain value on success or THROWS a typed error on every failure path (AGENTS §14's universal tool-handler contract) — it never builds a `ToolResult` itself. The `ToolManagerInterface.execute` (`@orkestrel/agent`) performs the ONE canonical wrap — `{ id, name, value }` on a return, `{ id, name, error }` on a throw, ISOLATED so nothing escapes the run — so a failure appears EXACTLY ONCE, identically, over both the agent loop and MCP.

3. **Contract-compiled schemas throughout.** Every advertised `parameters` is `schemaToParameters(contract.schema)` off a `createContract`-compiled shape (`workflowStepsShape` / `workflowDraftShape` / `workspaceToolShape` / `agentToolShape`) — never a hand-written JSON Schema — so the guard / parser / schema the handler validates against can never drift from what the tool advertises.

4. **Every delegating tool guards depth + cycle before it acts.** `createWorkflowTool` (a nested workflow run), `createAgentFunction` (an agent authoring a nested workflow through its bound tool), and `createAgentTool` (sub-agent delegation) each carry a `depth` + `ancestry` pair (`WorkflowToolOptions` / `AgentFunctionOptions` / `AgentToolOptions`), CLOSED OVER at bind/construction time (a tool handler receives only the model-supplied `args`, no ambient context — so the run's position in a workflow → agent → workflow or agent → agent chain cannot be threaded through a call). Before acting, the handler REJECTS with a typed `DEPTH` error when `depth + 1` would exceed the bound (`MAX_WORKFLOW_DEPTH` for the workflow chain, `AGENT_TOOL_DEPTH` for the agent-delegation chain — deliberately separate constants, same value by convention only) OR when the target (`workflowTag(id)` / `agentTag(name)`) is already present in `ancestry` (a re-entry cycle) — never runs the nested work in either case.

5. **`createWorkflowTool` widens the authoring surface additively; the strict contract stays the soundness gate.** It advertises the SIMPLE flat shape (`{ name?, steps: [{ name }] }`) as its `parameters` so a small model can author a whole tree in one call, but its handler ACCEPTS three forms — empty args (the wrapped `definition`), a `steps` array (the flat form, `expandSteps`'d), or a nested draft/full definition (`createWorkflowDraftContract`-parsed + `completeDraft`'d, or accepted as-is when already strict) — and EVERY path converges on the byte-for-byte-unchanged `createWorkflowContract().is` gate before it runs. A blob that fails to parse, expand, or complete, or whose result fails that strict gate, THROWS a `TOOL` `WorkflowError` (`@orkestrel/workflow`); the leniency never reaches the runner.

6. **`createWorkflowTool`'s store persists on settle; omitted means no persistence.** When `options.store` (a `WorkflowStoreInterface`) is supplied, the handler `await`s `store.set(result.workflow.snapshot())` once the run SETTLES (after `runner.execute` resolves, before the handler returns) — the executed run's final snapshot is retrievable / restorable afterwards through the SAME store a caller passed in. Omitted, the handler persists nothing; the run's outcome exists only in the returned summary.

7. **`createWorkspaceTool` is manager-driven, with a no-active ergonomic seam.** `options.manager` (drive directly) takes priority over `options.store` (build a fresh manager over it via `@orkestrel/agent`'s `createWorkspaceManager`); neither given constructs a manager over `@orkestrel/agent`'s in-memory default. NOTE the deliberate `store` divergence from invariant 6: the workspace tool's `store` only BACKS the constructed manager's `open` / `save` — the tool's edits are NOT auto-persisted (durability requires an explicit caller `save`), whereas the workflow tool's `store` persists each executed snapshot on settle. Every edit / read arm targets `manager.active` — never a specific workspace by id directly — so a host repoints which workspace the model edits via the two REGISTRY arms (`workspaces` lists them, `switch` re-points `active`, lenient on an unknown id). A WRITING arm (write / splice / prepend / append / move / remove / replace) run with no active workspace AUTO-CREATES + activates one (`manager.add()`); a pure-READ arm (read / list / has / search) against no active workspace returns the EMPTY result, never creating one.

8. **`createAgentTool` carries its own `store` slot, composable with a registry-level store.** `AgentToolOptions.store` is an optional `ConversationStoreInterface` (`@orkestrel/agent`): when supplied, the handler `await`s `store.set(agent.context.conversations.active.snapshot())` once `agent.generate()` SETTLES SUCCESSFULLY, before returning — one snapshot PER delegation (each `registry.build` mints a fresh conversation id via its seeded `add`, so a shared store never collides, it accumulates one snapshot per delegated call). A `store.set` failure PROPAGATES as the tool call's own failure (isolated by `ToolManagerInterface` into the canonical `error`, per invariant 2) — persistence is not best-effort. Omitted, the handler persists nothing from this tool. This composes with, and is independent of, `AgentRegistryOptions.store` (`@orkestrel/agent` 0.0.4): a registry built with its OWN `store` backs EVERY agent it builds with a store-backed `ConversationManagerInterface`, including ones built through this tool — a caller may use either seam alone or both together.

9. **A delegated sub-agent's lifecycle is a single `generate()` call.** `createAgentTool`'s handler resolves a live agent via `registry.build`, awaits ONE `agent.generate()`, and returns its settled `content` — `AgentInterface` (`@orkestrel/agent`) exposes no teardown method, so there is nothing to release afterwards; the agent's state lives entirely in the resolved `AgentContextInterface`, owned by the caller's registry.

10. **Provider-agnostic delegation.** `createAgentTool` never imports or references a concrete `ProviderInterface` implementation — `options.provider` / a per-call `call.provider` is a REGISTRY KEY resolved by `registry.build`, so swapping the provider behind that key changes nothing about the tool. A missing / unresolvable provider (neither the call nor the tool's own default supplies one) THROWS a `TOOL` `AgentToolError` before any agent is built.

11. **`AgentToolError` mirrors `WorkflowError`'s exact shape, kept distinct per package, and is this package's general tool-call error.** It carries a machine-readable `code` (`AgentToolErrorCode` — `TOOL` / `DEPTH`) + an optional `context` bag, thrown on every `createAgentTool` AND `createDescribeTool` failure path — never a `{ error }` return (AGENTS §14). It is NOT scoped to agent delegation alone: `createDescribeTool` reuses it (`TOOL`) for a malformed call or an unknown tool name, since that is the same "tool-level misuse" semantic `TOOL` already carries — no second error class was minted for it. `@orkestrel/workflow`'s `WorkflowError` and `@orkestrel/agent`'s `WorkspaceError` already cover the workflow tool's and workspace tool's failure paths respectively and are thrown as-is, never duplicated.

12. **The workflow-function adapters are OPT-IN, composed into the caller's own registry.** `createToolFunction(tools, name)` and `createAgentFunction(agent, options?)` each return a plain `WorkflowFunction` (`@orkestrel/workflow`) — the pure `WorkflowRunner` engine carries no knowledge of tools or agents itself; a caller composes either adapter into its own `WorkflowOptions.functions` registry like any other behavior (`{ publish: createToolFunction(tools, 'publish') }`). `createToolFunction`'s wrapped `ToolManagerInterface.execute` never throws (a handler throw is isolated into `result.error`), so the adapter RE-THROWS a plain `Error` carrying that message as `cause` when `result.error` is set — surfacing it as a task failure that honours `bail`. `createAgentFunction` folds the task's cancellation into the wrapped agent's run (an already-aborted `controller.signal` cancels up front; otherwise a one-shot listener fires `agent.abort` on the task's own cancellation) and, when `options.runner` is supplied, BINDS a depth/cycle-aware `createWorkflowTool` onto the agent's `context.tools` under `WORKFLOW_TOOL_NAME` — the propagation seam letting the wrapped agent author + run a NESTED workflow.

13. **The lean `summary` / full `description` split, and `createDescribeTool`'s expansion seam.** `createWorkflowTool`, `createWorkspaceTool`, and `createAgentTool` each set `ToolInterface.summary` (`@orkestrel/agent` 0.0.4) to a frozen one-sentence constant (`WORKFLOW_TOOL_SUMMARY` / `WORKSPACE_TOOL_SUMMARY` / `AGENT_TOOL_SUMMARY`) alongside their unchanged full teaching `description`; `ToolManagerInterface.definitions()` advertises `summary ?? description`, so a model sees the lean text by default. `createDescribeTool(tools)` is the on-demand expansion: given a registered `name`, it looks the tool up via `tools.tool(name)` and returns its full `tool.description` (falling back to `tool.summary`, then a placeholder, when a tool has neither) — never truncated, never re-derived. Each summary's text points the model at `describe('<name>')` for the full schema.

14. **`createDatabaseTool` and `createRelationTool` are single-tool-many-operations, matching `createWorkspaceTool`'s shape.** `createDatabaseTool` dispatches 12 operations (`create` / `tables` / `get` / `records` / `count` / `aggregate` / `add` / `set` / `update` / `remove` / `migrate` / `destroy`) off `databaseToolShape`; `createRelationTool` dispatches 5 (`load` / `find` / `link` / `unlink` / `links`) off `relationToolShape`. Both set `ToolInterface.summary` (`DATABASE_TOOL_SUMMARY` / `RELATION_TOOL_SUMMARY`) alongside their full teaching `description`, retrievable via `createDescribeTool`, per invariant 13. Every `'get'` / `'add'` / `'set'` / `'update'` / `'remove'` and `'load'` operation's `key` field takes EITHER a single key OR an array of keys (AGENTS §9.2, positional overload — the array form resolves first); a single-key call returns a singular result field (`row` / `key` / `updated` / `removed`), an array-key call returns the plural (`rows` / `keys` / `updated` / `removed` as arrays).

15. **The database tool's criteria form is SERIALIZED, never fluent.** `databaseToolShape`'s `criteria` is a flat object — `{ conditions?: [{ column, operator, values, connector? }], order?, limit?, offset? }` — where `values` is ALWAYS an array, even for a single-value operator (`{ column: 'age', operator: 'from', values: [18] }`), so a small model never chains method calls or guesses arity. `criteriaOf` normalizes the parsed form into a live `@orkestrel/database` `Criteria`, defaulting an omitted condition `connector` to `'and'` (the wire form lets a caller drop `connector` on the LAST condition, since it joins nothing forward).

16. **The `TableSpec` column DSL is bounded to four primitive kinds.** A `ColumnSpec` is either a bare `ColumnKind` shorthand (`'string'` / `'integer'` / `'number'` / `'boolean'`) or `{ type, optional? }`; `expandTables` compiles a `TableSpec` into the `@orkestrel/database` `TablesShape` `createDatabase` accepts via `columnShape` / `kindShape`, wrapping an `optional: true` column in `optionalShape`. There is no nested/composite column kind — a table's shape is a flat map of column name to `ColumnSpec`, never an object/array column.

17. **`'records'` / `'find'` / `'links'` truncate against a configured cap, never silently.** `createDatabaseTool`'s `'records'` (cap: `DatabaseToolOptions.limit`, default `DATABASE_TOOL_LIMIT`) and `createRelationTool`'s `'find'` / `'links'` (cap: `RelationToolOptions.limit`, default `RELATION_TOOL_LIMIT`) each PROBE one row past the effective limit (`clampCriteria` for the database tool; the same idiom inline for `'find'`) to detect truncation without a separate count round trip, returning `{ rows, count, truncated, limit }` (`'links'`: `{ keys, count, truncated, limit }`) — `truncated` is `true` exactly when storage held more than `limit` matching rows/keys. A caller's own `criteria.limit` / `limit` can only LOWER the effective cap, never raise it past the configured ceiling.

18. **A typed upstream failure re-surfaces as a typed `AgentToolError`, never passes through raw.** `createDatabaseTool` catches a `@orkestrel/database` `DatabaseError` and re-throws a typed `DATABASE` `AgentToolError` carrying the original `DatabaseErrorCode` in `context.code` (`databaseToolCode`); `createRelationTool` does the same for a `@orkestrel/relation` `RelationError` → `RELATION` (`relationToolCode`, checked FIRST) and, underneath it, a `DatabaseError` → `DATABASE` (mirroring the database tool's own mapping) — so a relation-tool caller sees exactly one of `TOOL` (this tool's own guards: malformed args, unknown manager/model/database/driver), `RELATION`, or `DATABASE`, never an unwrapped upstream error. An `AgentToolError` already thrown by this tool's own guards passes through UNWRAPPED (never re-mapped a second time).

19. **`DatabaseToolOptions.readonly` gates every mutating operation up front.** When `true`, `createDatabaseTool` throws a typed `TOOL` `AgentToolError` for `'create'` / `'add'` / `'set'` / `'update'` / `'remove'` / `'migrate'` / `'destroy'` BEFORE resolving a database or touching storage — the non-mutating operations (`'tables'` / `'get'` / `'records'` / `'count'` / `'aggregate'`) are unaffected. There is no equivalent gate on `createRelationTool` — its `'link'` / `'unlink'` writes are ungated (relation-tool callers rely on the underlying database's own access controls, if any).

20. **A `DatabaseDefinition` is CONFIG-ONLY and round-trips through a `DefinitionStoreInterface` — never a live handle.** `createDatabaseTool`'s `'create'` persists `{ id, driver, tables, keys? }` (never the constructed `DatabaseInterface`) when `options.store` is supplied, and every other operation lazily `resolve`s an uncached id by reading the definition back and reconstructing a live database from it (`createDatabase` + `expandTables`) — the live handle itself is cached only in-process (`Map<string, DatabaseInterface>`), reconstructed fresh on the next process from the stored config. `isDatabaseDefinition` is the boundary guard a `DefinitionStoreInterface` applies to an untrusted persisted blob before trusting it. `MemoryDefinitionStore` (a plain `Map`) and `DatabaseDefinitionStore` (one opaque JSON column of a `@orkestrel/database` table) are EXACT twins — same `get` / `set` / `delete` behavior, different backing storage — and either swaps in without touching a consumer.

21. **The relation tool's `include` is a FLAT dot-path list, capped by `RelationToolOptions.depth`.** `'load'` / `'find'` accept `include?: string[]` — each path a dot-separated chain of relation names (`'contacts.account'`) — expanded by `expandInclude` into a live `@orkestrel/relation` `Include` tree; a longer path SUBSUMES a shorter sibling's bare `true` (`['contacts', 'contacts.account']` → `{ contacts: { account: true } }`). A path exceeding `depth` segments (default `RELATION_TOOL_DEPTH`), or carrying an empty segment (a leading/trailing/doubled `.`), throws a typed `TOOL` `AgentToolError` before any query runs. `relationManagerOf` resolves which registered `RelationManagerInterface` a call addresses (an explicit `manager` miss, or an omitted one with other-than-exactly-one registered, throws typed `TOOL`); `relationModelOf` resolves `model` against it the same way.

22. **`createDatabaseTool` durability and ownership are narrower than they look.** A lazily re-minted database over the DEFAULT in-memory driver yields an EMPTY database — only the `DatabaseDefinition` schema persists in `store`, never rows; durable rows need a persistent driver factory registered in `DatabaseToolOptions.drivers`. `'destroy'` closes whatever handle is cached for the id, INCLUDING an embedder-supplied `DatabaseToolOptions.databases` handle — the embedder relinquishes that handle's lifecycle to this tool for any id it wires in. The tool assumes the single-writer, non-reentrant model `@orkestrel/database` itself assumes — concurrent tool calls against one id are NOT serialized by this tool. Unlike `'records'` / `'find'` / `'links'`, `'get'` is UNCAPPED by `DatabaseToolOptions.limit` (bounded only by the caller's `key` array size).

23. **`createEndpointTool` ENFORCES its advertised inferred schema via a NORMALIZING parse by default (`@orkestrel/contract` 0.0.7's `schemaToShape`), with an explicit `validate: false` opt-out.** `parameters` is inferred ONCE at construction (`samplesToSchema` + `schemaToObject` over `definition.samples`, tuned by `EndpointToolOptions.format`/`enum`) — the SAME object-rooted schema is compiled ONCE (`schemaToShape` → `createContract`) into the contract `execute` `parse`s every call's `args` through before `definition.invoke` runs. The parse COERCES a scalar to its inferred type where the house parsers coerce (a number to/from a numeric string, a boolean from `'1'`/`'0'`/`'true'`/`'false'`/`1`/`0`) — `invoke` receives the COERCED values (e.g. `7` sent for a string slot arrives at `invoke` as `'7'`), not the raw call args. A call whose `args` fails to parse into a record — a required key missing, or a value not coercible to its slot's type — THROWS a typed `TOOL` `AgentToolError` carrying the compiled contract's structured `explain` faults (via `contract.explain(args)`), and `invoke` is never called. Beyond that coercion, enforcement is STRUCTURAL: required keys, `enum` membership, and numeric bounds — `format` annotations (`email`, `date-time`, `uuid`, `uri`, ...) are NEVER asserted, mirroring `@orkestrel/contract`'s own widening-only law for `schemaToShape` (a `format: true`-tuned endpoint still accepts a non-conforming string in that slot); a key outside the closed inferred schema is SILENTLY DROPPED, not rejected — `@orkestrel/contract`'s own `parse` grants that same leniency to any closed object. `EndpointToolOptions.validate: false` restores the PRE-0.0.7 behavior exactly: `execute` calls `definition.invoke(args)` with the model-supplied `args` EXACTLY as received, never re-parsed, coerced, or checked against the advertised schema — the capability this package shipped before 0.0.7 added `schemaToShape`, kept as an explicit, documented escape hatch. `createInferTool`'s own call args are, as before, ALWAYS validated against `inferToolShape` (a hand-written shape) regardless — it is the schema INFERENCE's caller, not an inferred schema's consumer. Both factories' inferred schemas surface sample-derived strings VERBATIM (property names, and enum entries when opted in), so sample data intended for schema inference should be treated as untrusted content whenever the resulting schema will be advertised to other agents. `createInferTool`'s OPTIONAL `candidates` call arg is the OPPOSITE seam: it checks values against the SAME call's freshly inferred schema (compiled per-call, since the schema itself is derived from that call's `samples`) and returns a UNIFORM `{ index, valid, coercible, faults? }` entry per candidate. `valid` is a STRICT `.is` guard verdict, not a normalizing `.parse` — `7` against an inferred string slot is INVALID (no coercion), where the same value would be silently coerced to `'7'` by `createEndpointTool`'s enforcement. `coercible` (`checker.parse(candidate) !== undefined`) answers that SEPARATE question directly — would `createEndpointTool`'s default enforcement admit this value — and, by the house parse/guard round-trip guarantee, is ALWAYS `true` on a `valid: true` entry. Because `@orkestrel/contract` 0.0.7's `.explain` mirrors `.parse`'s leniency, not `.is`'s strictness, a strictly-invalid but coercible candidate (`7` against a string slot) yields `{ valid: false, coercible: true, faults: [] }` — EMPTY faults, since the mismatch normalization would silently fix is not one `.explain` reports; `faults` populates only for a NON-coercible mismatch (`coercible: false`). `checker.is` / `.parse` / `.explain` are total over JSON-safe input — a JSON-safe hostile candidate (a `__proto__`-carrying object, deep nesting) reaches all three and yields a bounded, non-throwing per-candidate verdict; a NON-JSON-safe candidate (a throwing-getter `Proxy`) never reaches the checker — it fails the OUTER `args` parse and rejects the WHOLE call as a `TOOL` error, with no per-candidate verdict. `candidates` is uncapped in COUNT (any array length is accepted), but each individual check is bounded (`.explain`'s fault list and the checker's own schema are both bounded by the inference limits already governing `samples`), so the total per-call cost is LINEAR in `candidates.length`.

## Patterns

These patterns follow the arc — author + run a workflow through the tool; persist its snapshot; drive a workspace through the tool; delegate to a sub-agent; compose the adapters into a workflow's own registry.

### Authoring + running a workflow through the tool, via a real `ToolManager`

```ts
import { createWorkflowTool } from '@orkestrel/tool'
import { createToolManager } from '@orkestrel/agent'
import { createWorkflowRunner } from '@orkestrel/workflow'
import type { WorkflowDefinition } from '@orkestrel/workflow'

const definition: WorkflowDefinition = { id: 'release', name: 'Release', phases: [] }
const runner = createWorkflowRunner()
const tool = createWorkflowTool(definition, runner)

const tools = createToolManager()
tools.add(tool)

// A small model authors the SIMPLE flat shape — no ids/names required.
const result = await tools.execute({
	id: 'call-1',
	name: 'workflow',
	arguments: { name: 'release', steps: [{ name: 'compile' }, { name: 'publish' }] },
})
result.value // { status: 'completed', count: 2 } — the single-level envelope; no nested { id, name, value }
```

### Plugging a `WorkflowStoreInterface` and retrieving the persisted snapshot

```ts
import { createWorkflowTool } from '@orkestrel/tool'
import {
	createMemoryWorkflowStore,
	createWorkflowRunner,
	restoreWorkflow,
} from '@orkestrel/workflow'
import type { WorkflowDefinition } from '@orkestrel/workflow'

const definition: WorkflowDefinition = { id: 'ingest', name: 'Ingest', phases: [] }
const store = createMemoryWorkflowStore()
const runner = createWorkflowRunner()
const tool = createWorkflowTool(definition, runner, { store })

await tool.execute({}) // empty args ⇒ run the wrapped `definition` ('ingest') — persisted on settle
const snapshot = await store.get('ingest')
const restored = snapshot === undefined ? undefined : restoreWorkflow(snapshot)
restored?.status // 'completed' — the persisted run, rebuilt from its own snapshot
```

### Driving the workspace tool with a plugged store

```ts
import { createWorkspaceTool } from '@orkestrel/tool'
import { createMemoryWorkspaceStore } from '@orkestrel/agent'
import { createToolManager } from '@orkestrel/agent'

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

```ts
import { createAgentTool } from '@orkestrel/tool'
import { createAgentRegistry, createToolManager } from '@orkestrel/agent'

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

### Persisting a delegation's conversation via the agent tool's own `store` slot

```ts
import { createAgentTool } from '@orkestrel/tool'
import {
	createAgentRegistry,
	createMemoryConversationStore,
	createToolManager,
} from '@orkestrel/agent'

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

### Lean advertisement + on-demand expansion via `createDescribeTool`

```ts
import { createDescribeTool, createWorkflowTool, createWorkspaceTool } from '@orkestrel/tool'
import { createToolManager } from '@orkestrel/agent'
import { createWorkflowRunner } from '@orkestrel/workflow'
import type { WorkflowDefinition } from '@orkestrel/workflow'

const definition: WorkflowDefinition = { id: 'release', name: 'Release', phases: [] }
const tools = createToolManager()
tools.add(createWorkflowTool(definition, createWorkflowRunner()))
tools.add(createWorkspaceTool())
tools.add(createDescribeTool(tools)) // the tool describes the SAME manager it is registered on

tools.definitions().map((entry) => entry.description)
// each entry is the LEAN summary (e.g. "Author and run a multi-phase workflow in one call — …")

const full = await tools.execute({
	id: 'd1',
	name: 'describe',
	arguments: { name: 'workflow' },
})
full.value // the workflow tool's FULL multi-line teaching description
```

### Composing `createToolFunction` / `createAgentFunction` into a workflow's `functions` registry

```ts
import { createAgentFunction, createToolFunction } from '@orkestrel/tool'
import { createToolManager } from '@orkestrel/agent'
import { createWorkflowRunner } from '@orkestrel/workflow'
import type { WorkflowDefinition } from '@orkestrel/workflow'

declare const publishTool: Parameters<ReturnType<typeof createToolManager>['add']>[0]
declare const reviewAgent: Parameters<typeof createAgentFunction>[0]

const tools = createToolManager()
tools.add(publishTool)

const definition: WorkflowDefinition = {
	id: 'ship',
	name: 'Ship',
	phases: [
		{ id: 'review', name: 'Review', tasks: [{ id: 'r', name: 'Review', run: 'review' }] },
		{ id: 'publish', name: 'Publish', tasks: [{ id: 'p', name: 'Publish', run: 'publish' }] },
	],
}
const runner = createWorkflowRunner()
await runner.execute(definition, {
	functions: {
		review: createAgentFunction(reviewAgent), // OPT-IN: wraps a live agent
		publish: createToolFunction(tools, 'publish'), // OPT-IN: wraps a registered tool by name
	},
})
```

### The lenient-authoring helpers, standalone

```ts
import {
	agentTag,
	completeDraft,
	completePhaseDraft,
	completeTaskDraft,
	expandSteps,
	workflowTag,
	workflowToolSummary,
} from '@orkestrel/tool'

workflowTag('release') // 'workflow:release'
agentTag('reviewer') // 'agent:reviewer'

completeTaskDraft({ run: 'compile' }, 'phase-0', 0) // { id: 'phase-0-task-0', name: 'phase-0-task-0', run: 'compile' }
completePhaseDraft({ tasks: [{ run: 'compile' }] }, 0) // { id: 'phase-0', name: 'phase-0', tasks: [...] }
completeDraft({ phases: [{ tasks: [{ run: 'compile' }] }] }) // a complete WorkflowDefinition, ids/names filled positionally

expandSteps({ steps: [{ name: 'compile' }] }) // one one-task phase whose task's `run` is 'compile'

// workflowToolSummary reduces a settled WorkflowResult to the tool's plain success value:
declare const result: Parameters<typeof workflowToolSummary>[0]
workflowToolSummary(result) // { status: result.status, count: result.results.length }
```

### Recovering a typed `AgentToolError`

```ts
import { AgentToolError, isAgentToolError } from '@orkestrel/tool'

try {
	throw new AgentToolError('TOOL', 'task is required')
} catch (error) {
	if (isAgentToolError(error)) console.log(error.code) // 'TOOL'
}
```

### Asking + answering through the terminal seam

```ts
import { createAnswerTool, createPromptTool } from '@orkestrel/tool'
import { createTerminalManager, createToolManager } from '@orkestrel/terminal'

const manager = createTerminalManager()
manager.add('agent')
manager.add('reviewer')

const askTool = createPromptTool({ manager, from: 'agent' })
const answerTool = createAnswerTool({ manager, to: 'reviewer' })

const tools = createToolManager()
tools.add(askTool)
tools.add(answerTool)

const asked = tools.execute({
	id: 'ask-1',
	name: 'ask',
	arguments: { to: 'reviewer', form: 'confirm', message: 'Approve the release?' },
}) // blocks until 'reviewer' answers

const pending = await tools.execute({
	id: 'p-1',
	name: 'answer',
	arguments: { operation: 'pending' },
})
const [prompt] = pending.value as readonly { id: string }[]
await tools.execute({
	id: 'a-1',
	name: 'answer',
	arguments: { operation: 'answer', id: prompt.id, value: true },
})

const result = await asked
result.value // true — the answer 'reviewer' just submitted
```

### The answer coercion + error classification helpers, standalone

```ts
import { coerceAnswer, terminalToolCode } from '@orkestrel/tool'
import { TerminalError } from '@orkestrel/terminal'

coerceAnswer('confirm', 'true') // true
coerceAnswer('checkbox', 'a,b') // ['a', 'b']
coerceAnswer('input', 42) // '42'

terminalToolCode(new TerminalError('DEADLOCK', 'cycle')) // 'DEADLOCK'
terminalToolCode(new TerminalError('TARGET', 'unknown')) // 'TOOL'
terminalToolCode(new Error('not a terminal error')) // undefined
```

### Bridging a `TerminalManagerInterface` onto the wire

```ts
import { createTerminalRoutes } from '@orkestrel/tool/server'
import { createTerminalManager } from '@orkestrel/terminal'

const manager = createTerminalManager()
manager.add('assistant')
const routes = createTerminalRoutes(manager, { token: 'secret' })
// mount `routes` (GET SSE + POST answer, one shared `:name`-templated path) against
// any router that accepts a `{ method, path, handler }` structural record —
// byte-compatible with `@orkestrel/terminal`'s own `PromptClient`.
```

### Driving the database tool: create, add a row, query with a serialized condition, migrate

```ts
import { createDatabaseTool } from '@orkestrel/tool'
import { createToolManager } from '@orkestrel/agent'

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
				columns: { name: 'string', price: 'number', notes: { type: 'string', optional: true } },
			},
		},
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

// Serialized criteria — a condition is a flat object; "values" is always an array.
const records = await tools.execute({
	id: 'r1',
	name: 'database',
	arguments: {
		operation: 'records',
		id: 'shop',
		table: 'products',
		criteria: { conditions: [{ column: 'price', operator: 'below', values: [50] }] },
	},
})
records.value // { rows: [{ name: 'Widget', price: 25, ... }], count: 1, truncated: false, limit: 1000 }

// Migrate — replace the table layout in place.
await tools.execute({
	id: 'm1',
	name: 'database',
	arguments: {
		operation: 'migrate',
		id: 'shop',
		tables: { products: { columns: { name: 'string', price: 'number' } } }, // drops "notes"
	},
})
```

### Persisting database definitions via `DefinitionStoreInterface`

```ts
import {
	createDatabaseDefinitionStore,
	createDatabaseTool,
	createMemoryDefinitionStore,
} from '@orkestrel/tool'
import { createToolManager } from '@orkestrel/agent'

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
definition?.driver // 'memory' — the CONFIG-ONLY blueprint, never a live handle

await durable.set({ id: 'audit', driver: 'memory', tables: {} })
const restored = await durable.get('audit')
await durable.delete('audit')
restored?.id // 'audit'
```

### Wiring the relation tool over a live `RelationManagerInterface` and loading nested includes

```ts
import { createRelationTool } from '@orkestrel/tool'
import { createToolManager } from '@orkestrel/agent'
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
		include: ['contacts.account'], // a flat dot-path — two levels of nested relations
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

### The database / relation helpers, standalone

```ts
import {
	columnSchema,
	columnShape,
	criteriaOf,
	databaseToolCode,
	expandTables,
	isColumnKind,
	isColumnSpec,
	isDatabaseDefinition,
	kindShape,
	relationManagerOf,
	relationModelOf,
	relationToolCode,
	tableSchema,
} from '@orkestrel/tool'
import { DatabaseError } from '@orkestrel/database'
import { RelationError } from '@orkestrel/relation'

isColumnKind('string') // true
isColumnSpec({ type: 'string', optional: true }) // true

const shapes = expandTables({
	products: { columns: { name: 'string', price: { type: 'number', optional: true } } },
})
columnShape('integer') // the integerShape() ContractShape
kindShape('boolean') // the booleanShape() ContractShape

isDatabaseDefinition({ id: 'shop', driver: 'memory', tables: {} }) // true

databaseToolCode(new DatabaseError('NOT_FOUND', 'row not found')) // 'NOT_FOUND'
relationToolCode(new RelationError('UNKNOWN_RELATION', 'unknown relation')) // 'UNKNOWN_RELATION'

criteriaOf({ conditions: [{ column: 'age', operator: 'from', values: [18] }] })
// { conditions: [{ column: 'age', operator: 'from', values: [18], connector: 'and' }] }

declare const table: Readonly<{
	key: string
	columns: Readonly<Record<string, ReturnType<typeof columnShape>>>
}>
tableSchema('products', table) // { name: 'products', primary: table.key, columns: [...], indexes: [] }
columnSchema('name', columnShape('string')) // { name: 'name', type: 'string', nullable: false }

declare const managers: Readonly<
	Record<string, import('@orkestrel/relation').RelationManagerInterface>
>
const resolved = relationManagerOf(managers, undefined) // the sole registered manager, or throws
relationModelOf(resolved, 'accounts') // the resolved model, or throws on an unknown name
```

### Inferring a JSON Schema from example values, via a real `ToolManager`

```ts
import { createInferTool } from '@orkestrel/tool'
import { createToolManager } from '@orkestrel/agent'

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

// pass `candidates` to CHECK values against the freshly inferred schema — the result is wrapped
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
// NOTE: `valid` is a STRICT guard verdict (`.is`), not a normalizing parse — the OPPOSITE of
// `createEndpointTool`'s enforcement (Contract invariant 23), which COERCES (`7` becomes `'7'`
// for a string slot); here `7` against a string slot is `valid: false`. `coercible` answers that
// separate question directly (would the endpoint tool's normalizing parse accept it) — candidate 2
// is a STRICT mismatch that is still coercible, so it carries EMPTY `faults`: `.explain` mirrors
// `.parse`'s leniency, not `.is`'s strictness, so faults populate only for a non-coercible mismatch
// (candidate 1's wrong, non-coercible `id` type).
```

### Bridging an existing API endpoint into an LLM-callable tool

```ts
import { createEndpointTool } from '@orkestrel/tool'
import { createToolManager } from '@orkestrel/agent'

// A real handler over an existing API/DB call — samples teach the inferred `parameters`.
const tool = createEndpointTool({
	name: 'lookupUser',
	description: 'Look up a user by id.',
	samples: [
		{ id: '1', name: 'Ada' },
		{ id: '2', name: 'Bob' },
	],
	invoke: async (args) => ({ id: args.id, name: 'Ada' }), // a real endpoint call goes here
})

const tools = createToolManager()
tools.add(tool)

const result = await tools.execute({
	id: 'call-1',
	name: 'lookupUser',
	arguments: { id: '1', name: 'Ada' },
})
// result.value -> { id: '1', name: 'Ada' }
// NOTE: by default `args` is PARSED + VALIDATED against the advertised schema before `invoke`
// runs (see Contract invariant 23) — a nonconforming call throws a typed `TOOL` `AgentToolError`
// with structured faults instead of reaching `invoke`. Pass `{ validate: false }` as the second
// argument to `createEndpointTool` to restore raw passthrough.
```

## Tests

- [`tests/guides/src/parity.test.ts`](../../tests/guides/src/parity.test.ts) — the `## Surface` ↔ `src/core` + `src/server` bijection (value + type exports, spanning both barrels), and this guide's `## Patterns` fences resolving to real exports (per-specifier) with resolving imports.
- [`tests/src/core/factories.test.ts`](../../tests/src/core/factories.test.ts) — every factory returning a working instance / value: `createToolFunction` running a registered tool and re-throwing a failing tool's error with the original message as `cause`; `createAgentFunction` running a live (scripted) agent, folding task cancellation into `agent.abort`, and — when `options.runner` is supplied — binding a depth/cycle-aware `createWorkflowTool` onto the agent's `context.tools` under `WORKFLOW_TOOL_NAME`, plus its own `DEPTH` guard rejecting an over-deep / cyclic call before running the agent; `createWorkflowDraftContract` round-tripping a lenient draft (`id`/`name` optional, an explicit empty `id` still rejected); `createWorkflowTool` end to end through a REAL `createToolManager` — the flat shape, an ids-omitted draft, and the full nested form all converging on `{ status, count }`, a malformed blob throwing `TOOL`, an over-deep / cyclic nested run throwing `DEPTH`, and (with `options.store` supplied) the settled run's snapshot landing in the store; `createWorkspaceTool` driven both `manager`-first and `store`-first, one case per operation arm (incl. the no-active auto-create / empty-read rule and the `workspaces` / `switch` registry arms), and its `WorkspaceError` propagation (`MODALITY` / `PATTERN` / `RANGE` uncaught, `TOOL` on a malformed op); `createAgentTool` resolving a seeded sub-agent via a (scripted) `AgentRegistryInterface`, returning its settled content, its `TOOL` failure paths (malformed call, unresolved provider), its `DEPTH` guard (over-depth, a cyclic re-entrant provider), and — net-new — its optional `store` slot: a successful delegation persisting the sub-agent's conversation snapshot, two delegations persisting two distinct snapshots, the storeless path unchanged, and a `store.set` failure surfacing as the tool call's own failure via the manager's error envelope; the three tools' advertised `summary` (exact text, alongside an unchanged full `description`) and a real `ToolManager.definitions()` advertising the summary while `tool(name).description` keeps the full text; `createDescribeTool` returning each of the three tools' full description through a real `ToolManager`, an unknown name throwing a typed `TOOL` `AgentToolError` (via both a direct call and the manager's error envelope), and malformed args (missing/empty `name`) rejected; `createPromptTool` / `createAnswerTool` driven through a real `TerminalManagerInterface` / `ToolManager` — asking + blocking until answered, listing pending prompts, coercing the answer to the prompt's form, a prompt cycle throwing `DEADLOCK`, an expired prompt throwing `EXPIRE`, and an unknown/rejected answer throwing `ANSWER`; `createMemoryDefinitionStore` / `createDatabaseDefinitionStore` each returning a working `DefinitionStoreInterface` (a `set`/`get`/`delete` round trip); `createDatabaseTool` driven through a REAL `createToolManager` across every operation (`create`/`tables`/`get`/`records`/`count`/`aggregate`/`add`/`set`/`update`/`remove`/`migrate`/`destroy`), the single/array `key` overload on `get`/`add`/`set`/`update`/`remove`, `'records'` truncation against `limit` (with `criteria.limit` clamped, never raised, past the configured cap), `'migrate'` re-declaring a live handle against its own deployed schema, lazy `store`-backed resolution of an uncached id (an unknown id throwing `TOOL`), `readonly` gating every mutating operation, and a `DatabaseError` re-surfacing as a typed `DATABASE` `AgentToolError` carrying `context.code`; `createRelationTool` driven the same way across `load`/`find`/`link`/`unlink`/`links`, `manager` resolution (an explicit miss, an omitted one against zero/one/many registered managers), `include` dot-path expansion + depth-cap rejection, `'find'`/`'links'` truncation, and a `RelationError` / underlying `DatabaseError` each re-surfacing as typed `RELATION` / `DATABASE` `AgentToolError`s.
- [`tests/src/core/databases/DatabaseResolver.test.ts`](../../tests/src/core/databases/DatabaseResolver.test.ts) — caller-map isolation, explicit cache operations, stored-definition construction and reuse, and the typed unknown-database failure.
- [`tests/src/core/helpers.test.ts`](../../tests/src/core/helpers.test.ts) — `workflowTag` / `agentTag`'s namespaced tags; `workflowToolSummary`'s plain `{ status, count }` reduction; the lenient-authoring synthesis `completeDraft` / `completePhaseDraft` / `completeTaskDraft` (positional ids, name defaulting to id, a provided id/name preserved, per-phase `bail` + per-task `retries`/`timeout` carried over) and `expandSteps` (one one-task phase per step, a step's `name` → the task's `run`), each yielding a tree the STRICT `createWorkflowContract` accepts; `coerceAnswer` per form (`confirm` → `boolean`, `checkbox` → `readonly string[]`, text forms → `string`, including a lossless-string fallback for an object/array value); `terminalToolCode` mapping `TerminalError('DEADLOCK'|'EXPIRE')` 1:1, every other `TerminalError` to `TOOL`, and a non-`TerminalError` to `undefined`; `isColumnKind` / `isColumnSpec` narrowing valid and invalid column specs; `expandTables` / `columnShape` / `kindShape` compiling every `ColumnKind` (+ `optional`) into the matching `@orkestrel/database` shape; `isDatabaseDefinition` narrowing a valid definition and rejecting malformed `tables` / `keys`; `databaseToolCode` / `relationToolCode` mapping every `DatabaseErrorCode` / `RelationErrorCode` 1:1 and a non-matching error to `undefined`; `expandInclude` merging dot-paths (a longer path subsuming a shorter sibling's bare `true`) and rejecting an empty segment / over-depth path with a typed `TOOL` error; `relationManagerOf` / `relationModelOf` resolving an explicit/omitted name and throwing typed `TOOL` on a miss; `criteriaOf` defaulting an omitted `connector` to `'and'`; `clampCriteria` bumping the probe `limit` by one and flooring the effective limit at `0`; `columnSchema` / `tableSchema` building a `TableSchema` from a live handle's `export()`.
- [`tests/src/core/shapers.test.ts`](../../tests/src/core/shapers.test.ts) — `agentToolShape` agreeing with `AgentToolArguments` (`task` required, `provider`/`tools`/`system` optional); the draft shapes (`workflowDraftShape` / `phaseDraftShape` / `taskDraftShape`); `stepShape` / `workflowStepsShape`; `workspaceToolShape` accepting a valid sample of each of the 13 operation arms and rejecting malformed input; `promptToolShape` accepting each of the six prompt forms' fields and rejecting malformed input; `answerToolShape` accepting both the `pending` and `answer` arms (each `value` type) and rejecting malformed input; `databaseToolShape` accepting a valid sample of each of the 12 operation arms (incl. the single/array `key` and `row` forms) and rejecting malformed input; `relationToolShape` accepting a valid sample of each of the 5 operation arms (incl. `manager` omitted, single/array `key`) and rejecting malformed input.
- [`tests/src/core/errors.test.ts`](../../tests/src/core/errors.test.ts) — `AgentToolError` carrying its `code` + optional `context`, and `isAgentToolError` narrowing a caught value (accepting a real instance, rejecting a plain `Error` / non-error value).
- [`tests/src/core/stores.test.ts`](../../tests/src/core/stores.test.ts) — `MemoryDefinitionStore` and `DatabaseDefinitionStore` run against the SAME scenario set to pin identical `DefinitionStoreInterface` behavior: `set` inserting / replacing under the definition's own `id`, `get` resolving a stored definition or `undefined`, `delete` removing an entry and a no-op on an absent id; `DatabaseDefinitionStore`-only scenarios — a malformed blob written directly into the backing table resolving `undefined` via `isDatabaseDefinition` rather than throwing, and construction over a custom (non-default) `DriverInterface`.
- [`tests/src/server/factories.test.ts`](../../tests/src/server/factories.test.ts) — `createTerminalRoutes` returning exactly two records (GET then POST) sharing one path; the GET route replaying every currently-pending prompt as a `pending` frame then live-forwarding `pending` / `expire` events scoped to `name`, arming a keepalive `: ` comment ping via an injected `timer` that RE-VALIDATES the connection's presented token on every tick (a `TerminalToken` function that starts rejecting mid-stream tears the stream down through the shared teardown and does not re-arm; a static string token is a no-op across ticks), ending the stream (unsubscribing + cancelling the keepalive) on the request's `AbortSignal` firing, and `401`/`404` on a token mismatch / unknown `name`; the POST route reading the body capped at `options.limit` bytes and parsing the JSON body and routing it through `manager.answer` — `204` on success, `413` an over-limit body (a lying small `Content-Length` on a big streamed body still capped, `manager.answer` never called), `400` invalid JSON, `422` a non-`{ id, value }` body or a `'unknown'`/`'rejected'` answer result, `404` an unknown `name` or a `'terminal'` answer result, `401` on a token mismatch; mount-churn pressure (50 sequential GET connect→abort cycles) proving zero leaked keepalive timers / manager listener subscriptions and no ghost duplicate `pending` frames; POST fuzz pressure over malformed/invalid-shape bodies, unknown endpoint, bad token, and an expired id; and consumer-side stream-close self-heal — a live `pending` event or a keepalive tick arriving on a stream closed WITHOUT the request `AbortSignal` ever firing runs the SAME teardown the abort path runs (listeners detached, keepalive cancelled), never re-arming or leaking.
- [`tests/src/server/routes/TerminalConnection.test.ts`](../../tests/src/server/routes/TerminalConnection.test.ts) — idempotent direct opening, already-aborted request teardown, and fail-closed handling when a direct token validator throws.

## See also

- [`agent.md`](agent.md) — the `ToolInterface` / `ToolManager` runtime every tool here plugs into, the `WorkspaceManagerInterface` / `WorkspaceStoreInterface` the workspace tool drives, and the `AgentRegistryInterface` / `AgentInterface` the agent tool and `createAgentFunction` resolve and run.
- [`workflow.md`](workflow.md) — the `WorkflowDefinition` / `WorkflowRunnerInterface` / `WorkflowStoreInterface` / `WorkflowFunction` primitives the workflow-authoring tool and the two adapters wrap; `WorkflowError` is thrown as-is by `createWorkflowTool` / `createAgentFunction`.
- [`contract.md`](contract.md) — the shape DSL (`createContract`, `objectShape` / `unionShape` / …) every advertised `parameters` compiles through, and `schemaToParameters`.
- [`terminal.md`](terminal.md) — a byte-identical mirror of the guide for `@orkestrel/terminal`, the `TerminalManagerInterface` / `PromptType` / `TerminalError` primitives `createPromptTool` / `createAnswerTool` / `createTerminalRoutes` are built over, and the `PromptClient` `createTerminalRoutes` stays byte-compatible with.
- [`server.md`](server.md) — a byte-identical mirror of the guide for `@orkestrel/server`, the `openStream` SSE primitive `createTerminalRoutes`'s GET route is built over.
- [`database.md`](database.md) — a byte-identical mirror of the guide for `@orkestrel/database`, the `DatabaseInterface` / `DriverInterface` / `Criteria` / `TablesShape` primitives `createDatabaseTool` (and, underneath it, `createRelationTool`) is built over.
- [`relation.md`](relation.md) — a byte-identical mirror of the guide for `@orkestrel/relation`, the `RelationManagerInterface` / `ModelInterface` / `Include` primitives `createRelationTool` is built over.
- [`AGENTS.md`](../../AGENTS.md) — the rules; §14 the universal tool-handler contract + totality, §22 documentation-as-contracts.
- [`README.md`](../README.md) — the guides index.
