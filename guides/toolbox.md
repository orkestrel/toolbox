# Toolbox

> Concrete, LLM-callable **tools** for the `@orkestrel` line — workflow authoring, workspace editing, sub-agent delegation, terminal-mediated prompting, database and relation access, and schema inference / endpoint wrapping — over the [`@orkestrel/tool`](tool.md) runtime, with pluggable stores. The runtime supplies `ToolInterface`, registry execution, and result isolation; see [`tool.md`](tool.md). This package supplies the concrete behavior through one factory per tool.

`createWorkflowTool` and `createWorkspaceTool` own their full handler logic (the workflow authoring surface and the workspace editing surface respectively). The workflow tool composes opaque host `functions` plus raw live `agents` through `createWorkflowFunctions`, then forwards that frozen target registry and the optional `store` to `@orkestrel/workflow` 0.0.8, whose runner owns named-run drivability, checkpoint persistence, and `durable` / `fault`; the workspace tool retains its distinct manager/store composition. `createAgentTool` (sub-agent delegation over an `AgentRegistryInterface`) has its own `ConversationStoreInterface` persistence slot. All three tools additionally advertise a lean `summary` (`@orkestrel/tool`'s `ToolInterface.summary` / `ToolManagerInterface.definitions()` projection) in place of their full teaching `description`; `createDescribeTool` is the on-demand expansion seam. `createToolFunction` adapts an ordinary registered runtime tool, while `createAgentFunction` returns a frozen metadata-bearing adapter and uses Agent-owned `agentResultToJSON` for the exact result projection. The authoring umbrella (`WorkflowSteps` / `WorkflowDraft` shapes, `createWorkflowDraftContract`, lineage helpers, `expandSteps` / `completeDraft`, `workflowToolSummary`, `MAX_WORKFLOW_DEPTH`) lets a small model author a whole recursion-safe tree in one call.

`createPromptTool` / `createAnswerTool` are the ASK / ANSWER halves of a terminal-mediated human-in-the-loop seam over a live `TerminalManagerInterface` (`@orkestrel/terminal`): `createPromptTool` BLOCKS the calling agent turn until the addressed terminal answers (`from` FIXED at construction, `to` supplied per call), re-surfacing a prompt cycle as `DEADLOCK` and an unanswered expiry as `EXPIRE`; `createAnswerTool` lists / answers the prompts addressed to a FIXED `to` terminal, coercing the model-supplied `value` to the original prompt's form before applying it, re-surfacing a failed apply as `ANSWER`. `createTerminalRoutes` ([`src/server`](../../src/server), the `@src/server` barrel) is the wire bridge for the SAME manager — two structural `{ method, path, handler }` route records (GET SSE stream + POST answer, one shared `:name`-templated path), carrying NO dependency on `@orkestrel/router`'s own `Route` type so a consumer mounts them against any router accepting that two-arg handler shape, and byte-compatible with `@orkestrel/terminal`'s own `PromptClient` (same GET url streams, same POST url answers, same `{ id, value }` body, same `x-orkestrel-token` header).

`createInferTool` / `createEndpointTool` bridge an EXISTING API/DB surface into an LLM-callable `ToolInterface` over `@orkestrel/contract`'s sample-based schema inference — `createInferTool` a standalone utility a model calls to learn a JSON Schema from example values, `createEndpointTool` wrapping one concrete endpoint whose inferred `parameters` steer the model AND, by default, are ENFORCED at `execute` time (`EndpointToolOptions.validate`, default `true`; `validate: false` restores raw passthrough — see the Contract invariant below).

Source: [`src/core`](../../src/core) (the tool factories) and [`src/server`](../../src/server) (the terminal-routes wire bridge). Surfaced through the `@src/core` and `@src/server` barrels respectively.

## Surface

### Factories

| API                             | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createToolFunction`            | function | Wrap a registered runtime tool as a `WorkflowFunction`, preserving execution throws and deep-validating its unknown return as JSON.                                                                                                                                                                                                                               |
| `createAgentFunction`           | function | Wrap a live `AgentInterface` as a frozen metadata-bearing `AgentFunction`, using Agent-owned result projection and optionally binding a nested workflow tool with propagated functions/agents/store.                                                                                                                                                              |
| `createWorkflowFunctions`       | function | Snapshot opaque host leaves and contextually adapt raw agents into one frozen null-prototype recursion-safe `WorkflowFunctions` registry.                                                                                                                                                                                                                         |
| `createWorkflowDraftContract`   | function | Compile the LENIENT DRAFT `ContractInterface` — like the strict `createWorkflowContract` but `id`/`name` optional at all three levels.                                                                                                                                                                                                                            |
| `createWorkflowTool`            | function | Wrap a `WorkflowDefinition` as an LLM-callable flat/draft/full authoring tool, forwarding optional named functions and a checkpoint store to the native runner.                                                                                                                                                                                                   |
| `createWorkspaceTool`           | function | Build the 13-operation workspace-editing `ToolInterface`, driving a caller `WorkspaceManagerInterface` OR a manager built over a pluggable `WorkspaceStoreInterface`.                                                                                                                                                                                             |
| `createAgentTool`               | function | Build the sub-agent delegation `ToolInterface` — resolves + runs one seeded agent via an `AgentRegistryInterface`, depth/cycle guarded, with an optional pluggable `ConversationStoreInterface`.                                                                                                                                                                  |
| `createDescribeTool`            | function | Build the `ToolInterface` that returns another registered tool's full `description` by name — the expansion seam for the other three tools' lean `summary`.                                                                                                                                                                                                       |
| `createPromptTool`              | function | Build the ASK-side `ToolInterface` over a live `TerminalManagerInterface` — asks a per-call `to` and BLOCKS until it answers; `from` FIXED at construction. A `'select'` / `'checkbox'` call with no `choices` rejects up front with a typed `TOOL` `ToolboxError` rather than parking an unanswerable prompt.                                                    |
| `createAnswerTool`              | function | Build the ANSWER-side `ToolInterface` over a live `TerminalManagerInterface` — lists / answers the prompts addressed to a FIXED `to`.                                                                                                                                                                                                                             |
| `createDatabaseTool`            | function | Build the 11-arm `operation`-discriminated `ToolInterface` (create/tables/get/records/count/aggregate/add/set/update/remove/destroy) driving `@orkestrel/database` databases, resolved lazily and cached, with an optional pluggable `DefinitionStoreInterface`.                                                                                                  |
| `createRelationTool`            | function | Build the `operation`-discriminated `ToolInterface` (load/find/link/unlink/links) traversing/editing `@orkestrel/relation` relationships over a registry of live `RelationManagerInterface`s.                                                                                                                                                                     |
| `createMemoryDefinitionStore`   | function | Create the in-memory `DefinitionStoreInterface` — a process-lifetime `Map` of `DatabaseDefinition` configs, the DEFAULT store `createDatabaseTool` persists through.                                                                                                                                                                                              |
| `createDatabaseDefinitionStore` | function | Create a `DefinitionStoreInterface` backed by one `@orkestrel/database` table — the driver-pluggable twin of `createMemoryDefinitionStore`, storing each definition as one opaque JSON column.                                                                                                                                                                    |
| `createInferTool`               | function | Build a standalone `ToolInterface` that infers a JSON Schema (as a `parameters`-shaped record) from one or more example `samples` — the utility half of the API/DB → MCP bridge. An optional `candidates` call arg checks values against the freshly inferred schema (strict `.is` guard, no coercion) and wraps the return as `{ parameters, checks }`.          |
| `createEndpointTool`            | function | Wrap one concrete `EndpointDefinition` as a `ToolInterface` — `parameters` inferred ONCE at construction from `samples`; by default `execute` ENFORCES that same schema against the call's args before `invoke` runs, throwing a typed `TOOL` error with structured faults on rejection (`validate: false` restores raw passthrough — see Contract invariant 23). |

### Stores

Concrete `DefinitionStoreInterface` implementations (AGENTS' Stores rule, point-access mold): `MemoryDefinitionStore` the in-memory default, `DatabaseDefinitionStore` the driver-pluggable twin over one `@orkestrel/database` table. Both are exact twins — same `get` / `set` / `delete` behavior, different backing storage.

| API                       | Kind  | Summary                                                                                                                                                                |
| ------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryDefinitionStore`   | class | The in-memory `DefinitionStoreInterface` — a process-lifetime `Map` of structured-cloned `DatabaseDefinition`s keyed by id; copy-in/copy-out, no idle-TTL or eviction. |
| `DatabaseDefinitionStore` | class | The `DefinitionStoreInterface` backed by one `@orkestrel/database` `TableInterface` — the definition stored as one opaque JSON column (`{ id, definition }`).          |

### Lifecycle entities

These implementation classes are available when consumers need direct lifecycle composition.
The factories `createDatabaseTool` and `createTerminalRoutes` remain the compact entry points.

| API                  | Kind  | Summary                                                                                                                                           |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DatabaseResolver`   | class | Resolve and cache a database handle from the tool's live handles, stored definitions, driver registry, and optional generator.                    |
| `TerminalRoutes`     | class | Own the shared terminal-route options and bound GET/POST handlers projected by `createTerminalRoutes`.                                            |
| `TerminalConnection` | class | Own one SSE connection's replay, listener subscriptions, keepalive revalidation, self-healing teardown, and exact optional wire-id serialization. |

### Errors

| API              | Kind     | Summary                                                                                                                                                                                                               |
| ---------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ToolboxError`   | class    | Carries a `ToolboxErrorCode` (`TOOL` / `DEPTH` / `DEADLOCK` / `EXPIRE` / `ANSWER` / `DATABASE` / `RELATION`) + optional `context` — Toolbox authoring, adapter, nesting, resolution, and mapped integration failures. |
| `isToolboxError` | function | Narrow an unknown caught value to a `ToolboxError`.                                                                                                                                                                   |

### Helpers

Pure, side-effect-free, exhaustively unit-tested under AGENTS' export-and-test-reusable-logic law and narrow-untrusted-input-with-guards rule — the lenient-authoring synthesis path and the ancestry tags shared by both delegating tools.

| API                    | Kind     | Behavior                                                                                                                                                                                                                               |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowTag`          | function | The ancestry identifier of a workflow in a run chain — `workflow:<id>`.                                                                                                                                                                |
| `agentTag`             | function | The ancestry identifier of an agent in a run chain — `agent:<name>`.                                                                                                                                                                   |
| `workflowToolSummary`  | function | Project a native workflow result into `{ status, count, durable?, fault? }`, preserving optional durability fields only when present.                                                                                                  |
| `extendLineage`        | function | Append one workflow or agent tag and return a validated frozen lineage copy.                                                                                                                                                           |
| `lineageOf`            | function | Build a validated, copied, and frozen alternating unique workflow/agent lineage; malformed configured input throws `ToolboxError('TOOL')`.                                                                                             |
| `deriveWorkflowDepth`  | function | Derive zero-based workflow depth from workflow-tag count: empty/root is `0`, then one per nested workflow.                                                                                                                             |
| `isWorkflowLineage`    | function | Narrow an unknown value to a valid alternating unique lineage beginning with a workflow tag.                                                                                                                                           |
| `isAgentFunction`      | function | Narrow an unknown callable to Toolbox's frozen `AgentFunction` metadata shape.                                                                                                                                                         |
| `completeDraft`        | function | Complete a `WorkflowDraft` into a strict `WorkflowDefinition` — synthesize missing ids positionally, default missing names to their id.                                                                                                |
| `completePhaseDraft`   | function | Complete one `PhaseDraft` into a strict phase definition — the per-phase step of `completeDraft`.                                                                                                                                      |
| `completeTaskDraft`    | function | Complete one `TaskDraft` into a strict task definition — the per-task leaf step of `completeDraft`.                                                                                                                                    |
| `expandSteps`          | function | Expand a flat `WorkflowSteps` blob into a strict `WorkflowDefinition` — each step becomes a one-task phase, in order.                                                                                                                  |
| `coerceAnswer`         | function | Normalize an LLM-supplied answer `value` to a `PromptType`'s own shape — `boolean` for `confirm`, `readonly string[]` for `checkbox`, `string` otherwise; pure and total.                                                              |
| `terminalToolCode`     | function | Classify a caught error into a `ToolboxErrorCode` for `createPromptTool` / `createAnswerTool` — `TerminalError('DEADLOCK'\|'EXPIRE')` maps 1:1, every other `TerminalError` maps to `TOOL`, a non-`TerminalError` returns `undefined`. |
| `isColumnKind`         | function | Narrow an unknown value to a `ColumnKind` (`'string'` / `'integer'` / `'number'` / `'boolean'`).                                                                                                                                       |
| `isColumnSpec`         | function | Narrow an unknown value to a `ColumnSpec` — a valid `ColumnKind` shorthand, or `{ type, optional }` with a valid `type`.                                                                                                               |
| `expandTables`         | function | Compile a `TableSpec` into the `@orkestrel/database` `TableMap` it configures — each `ColumnSpec` maps to its primitive shaper, wrapped in `optionalShape` when `optional: true`.                                                      |
| `columnShape`          | function | Compile one `ColumnSpec` into its `@orkestrel/database` column shape — the per-column leaf `expandTables` maps over.                                                                                                                   |
| `kindShape`            | function | Map one `ColumnKind` to its primitive `@orkestrel/database` shape — the leaf `columnShape` wraps.                                                                                                                                      |
| `isDatabaseDefinition` | function | Narrow an unknown value to a `DatabaseDefinition` — the boundary guard a `DefinitionStoreInterface` applies to an untrusted persisted blob.                                                                                            |
| `databaseToolCode`     | function | Map a caught error to the granular `DatabaseErrorCode`, or `undefined` if `error` is not a `DatabaseError` — the classification step `createDatabaseTool` / `createRelationTool` throw a `DATABASE` `ToolboxError` from.               |
| `relationToolCode`     | function | Map a caught error to the granular `RelationErrorCode`, or `undefined` if `error` is not a `RelationError` — the classification step `createRelationTool` throws a `RELATION` `ToolboxError` from.                                     |
| `expandInclude`        | function | Expand a flat dot-path `include` list into a live `@orkestrel/relation` `Include` tree; an empty segment or a path exceeding `depth` throws a typed `TOOL` `ToolboxError`.                                                             |
| `relationManagerOf`    | function | Resolve which registered `RelationManagerInterface` a relation-tool call addresses — an explicit `name` miss, or an omitted `name` with more/less than one registered manager, throws a typed `TOOL` `ToolboxError`.                   |
| `relationModelOf`      | function | Resolve a `model` name against a live `RelationManagerInterface` — an unknown model throws a typed `TOOL` `ToolboxError`.                                                                                                              |
| `clampQuery`           | function | Clamp a `'records'` call's query to a row cap, and build the PROBE query (`limit` bumped by one) used to detect truncation without a separate `count` round trip.                                                                      |
| `queryOf`              | function | Normalize the database tool's parsed SERIALIZED query into a live `@orkestrel/database` `QueryInput` — defaults each condition's omitted `connector` to `'and'`.                                                                       |

### Shapes

The shape VALUES each `create*Tool` factory (and `createWorkflowDraftContract`) compiles into the lockstep guard / parser / JSON Schema outputs under AGENTS' narrow-untrusted-input-with-guards rule; `agentToolShape` agrees with the hand-written `AgentToolArguments`, the source of truth.

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
| `databaseToolShape`  | const | The 11-arm `operation`-discriminated union `createDatabaseTool` advertises as its `parameters` (create/tables/get/records/count/aggregate/add/set/update/remove/destroy).                 |
| `columnKindShape`    | const | A `ColumnKind` literal — the leaf `columnSpecShape` wraps.                                                                                                                                |
| `columnSpecShape`    | const | A `ColumnSpec` — a bare `columnKindShape`, or `{ type, optional }`.                                                                                                                       |
| `tableSpecShape`     | const | A `TableSpec` — table name to `{ columns }`, each column a `columnSpecShape`.                                                                                                             |
| `keyShape`           | const | One database row key value — a string or number; the array form (multiple keys, positional) resolves first per AGENTS' batch overload mold.                                               |
| `rowShape`           | const | A loose database row — a flat object of column name to JSON value.                                                                                                                        |
| `rowsShape`          | const | One or many loose database rows — the array form resolves first per AGENTS' batch overload mold.                                                                                          |
| `conditionShape`     | const | One SERIALIZED WHERE condition — `values` is always an array, even for a single-value operator.                                                                                           |
| `orderShape`         | const | One sort term — `{ column, direction }`.                                                                                                                                                  |
| `queryShape`         | const | The SERIALIZED query form — conditions, order, and pagination.                                                                                                                            |
| `relationToolShape`  | const | The 5-arm `operation`-discriminated union `createRelationTool` advertises as its `parameters` (load/find/link/unlink/links).                                                              |
| `relationKeyShape`   | const | One relation row key value — a string or number; the array form (multiple keys, positional) resolves first per AGENTS' batch overload mold.                                               |
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
| `MAX_WORKFLOW_DEPTH`           | const | The maximum zero-based workflow nesting depth (`8`): root plus eight nested workflows is allowed; a ninth nested workflow is rejected.                                                   |
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
| `DATABASE_TOOL_DESCRIPTION`    | const | The multi-line description `createDatabaseTool` advertises — the 11 operations, the SERIALIZED query form, the `TableSpec` column DSL, worked examples.                                  |
| `DATABASE_TOOL_LIMIT`          | const | The default cap (`1000`) on rows a `'records'` call returns when the caller omits `query.limit`.                                                                                         |
| `DATABASE_TOOL_MUTATIONS`      | const | The runtime-frozen readonly array of database-tool mutations disabled by `DatabaseToolOptions.readonly`.                                                                                 |
| `RELATION_TOOL_NAME`           | const | The name (`'relation'`) `createRelationTool` advertises by default.                                                                                                                      |
| `RELATION_TOOL_SUMMARY`        | const | The lean one-sentence `summary` `createRelationTool` advertises in place of `RELATION_TOOL_DESCRIPTION`.                                                                                 |
| `RELATION_TOOL_DESCRIPTION`    | const | The multi-line description `createRelationTool` advertises — the 5 operations and the flat dot-path `include` syntax, a worked example.                                                  |
| `RELATION_TOOL_LIMIT`          | const | The default cap (`1000`) on rows a `'find'` / `'links'` call returns when the caller omits `limit`.                                                                                      |
| `RELATION_TOOL_DEPTH`          | const | The default cap (`3`) on how many `include` path segments deep a `'load'` / `'find'` call may traverse.                                                                                  |
| `INFER_TOOL_NAME`              | const | The name (`'infer'`) `createInferTool` advertises by default.                                                                                                                            |
| `INFER_TOOL_SUMMARY`           | const | The lean one-sentence `summary` `createInferTool` advertises in place of `INFER_TOOL_DESCRIPTION`.                                                                                       |
| `INFER_TOOL_DESCRIPTION`       | const | The multi-line description `createInferTool` advertises — `samples` required, `format`/`enum`/`candidates` optional, worked examples for both the bare and `candidates`-wrapped returns. |

### Types

| Type                       | Kind      | Shape                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskDraft`                | interface | `{ id?, name?, description?, run?, retries?, timeout? }` — a `TaskDefinition` (`@orkestrel/workflow`) with OPTIONAL id/name.                                                                                                                                                                                                       |
| `PhaseDraft`               | interface | `{ id?, name?, description?, tasks, concurrency?, bail? }` — a `PhaseDefinition` with OPTIONAL id/name + `TaskDraft` tasks.                                                                                                                                                                                                        |
| `WorkflowDraft`            | interface | `{ id?, name?, description?, phases, bail? }` — a `WorkflowDefinition` with OPTIONAL id/name at all three levels.                                                                                                                                                                                                                  |
| `WorkflowStep`             | interface | `{ name }` — one flat step; `name` is a REGISTERED behavior name (becomes the task's `run`, not a human label).                                                                                                                                                                                                                    |
| `WorkflowSteps`            | interface | `{ name?, steps }` — the FLAT authoring blob `createWorkflowTool` advertises; `name` is also the deterministic workflow id, and each step → a one-task phase via `expandSteps`.                                                                                                                                                    |
| `WorkflowToolResult`       | interface | `{ status, count, durable?, fault? }` — the exact JSON-safe summary returned by `createWorkflowTool`; optional native persistence outcome fields appear only when the runner supplies them.                                                                                                                                        |
| `WorkflowLineage`          | type      | `readonly string[]` — an immutable alternating chain of unique `workflow:` / `agent:` tags beginning with a workflow.                                                                                                                                                                                                              |
| `WorkflowAgents`           | type      | `Readonly<Record<string, AgentInterface>>` — raw live agents keyed by workflow function name for contextual Toolbox adaptation.                                                                                                                                                                                                    |
| `AgentFunction`            | type      | A `WorkflowFunction` carrying frozen `{ category: 'agent', lineage }` metadata.                                                                                                                                                                                                                                                    |
| `AgentFunctionOptions`     | interface | `{ runner?, lineage?, functions?, agents?, store? }` — nested workflow composition, exact context lineage, opaque leaves, raw agents, and native store.                                                                                                                                                                            |
| `WorkflowToolOptions`      | interface | `{ lineage?, functions?, agents?, store? }` — target lineage plus opaque leaves, raw agents, and native runner checkpoint store.                                                                                                                                                                                                   |
| `WorkspaceToolOptions`     | interface | `{ name?, description?, manager?, store? }` — a caller-built `WorkspaceManagerInterface` to drive directly, OR a `WorkspaceStoreInterface` to build one over.                                                                                                                                                                      |
| `WorkspaceOperation`       | type      | The 13-arm `operation`-discriminated union `createWorkspaceTool` dispatches — `read` / `list` / `has` / `search` / `replace` / `write` / `splice` / `prepend` / `append` / `move` / `remove` / `workspaces` / `switch`; search/replace options are `{ regex?, sensitive?, limit? }`, and replace returns `{ occurrences, files }`. |
| `AgentToolOptions`         | interface | `{ name?, description?, provider?, tools?, system?, depth?, ancestry?, store? }` — `createAgentTool`'s delegation defaults, nesting bookkeeping, and optional `ConversationStoreInterface`.                                                                                                                                        |
| `AgentToolArguments`       | interface | `{ task, provider?, tools?, system? }` — the flat call args `createAgentTool` accepts.                                                                                                                                                                                                                                             |
| `ToolboxErrorCode`         | type      | `'TOOL' \| 'DEPTH' \| 'DEADLOCK' \| 'EXPIRE' \| 'ANSWER' \| 'DATABASE' \| 'RELATION'` — the machine-readable code a `ToolboxError` carries (`DATABASE` / `RELATION` carrying the granular upstream error code in `context.code`).                                                                                                  |
| `DescribeToolArguments`    | interface | `{ name }` — the flat call args `createDescribeTool` accepts (the registered tool name to describe).                                                                                                                                                                                                                               |
| `PromptToolOptions`        | interface | `{ manager, from, name?, description? }` — `createPromptTool`'s live `TerminalManagerInterface`, the FIXED `from` identity, and advertised overrides.                                                                                                                                                                              |
| `AnswerToolOptions`        | interface | `{ manager, to, name?, description? }` — `createAnswerTool`'s live `TerminalManagerInterface`, the FIXED `to` identity, and advertised overrides.                                                                                                                                                                                  |
| `ColumnKind`               | type      | `'string' \| 'integer' \| 'number' \| 'boolean'` — one column's declared primitive type.                                                                                                                                                                                                                                           |
| `ColumnSpec`               | type      | A bare `ColumnKind` shorthand, or `{ type, optional? }` when the column may be absent from a row.                                                                                                                                                                                                                                  |
| `TableSpec`                | type      | A database's table layout — one entry per table, each `{ columns: Record<string, ColumnSpec> }`; `expandTables` compiles it into an `@orkestrel/database` `TableMap`.                                                                                                                                                              |
| `DatabaseDefinition`       | interface | `{ id, driver, tables, primary?, indexes?, version? }` — a database's CONFIG-ONLY definition (never a live handle); the durable blueprint `createDatabaseTool` builds a live database from and a `DefinitionStoreInterface` persists.                                                                                              |
| `DatabaseDefinitionRow`    | interface | `{ id, definition }` — one opaque persisted row (`definition: unknown`, narrowed with `isDatabaseDefinition` on read) — the shape `DatabaseDefinitionStore`'s backing table reads/writes.                                                                                                                                          |
| `DefinitionStoreInterface` | interface | `{ get, set, delete }` — the point-access persistence seam for `DatabaseDefinition` configs under AGENTS' Stores rule; every primitive async, `delete` of an absent id a no-op.                                                                                                                                                    |
| `DatabaseToolOptions`      | interface | `{ name?, description?, databases?, store?, drivers?, generator?, limit?, timeout?, readonly? }` — seed handles, store, drivers, generator, row cap, validated table-operation signal timeout, and mutation lock.                                                                                                                  |
| `RelationToolOptions`      | interface | `{ name?, description?, managers, limit?, depth? }` — `createRelationTool`'s REQUIRED live `RelationManagerInterface` registry, row cap, and `include` depth cap.                                                                                                                                                                  |
| `InferToolOptions`         | interface | `{ name?, description? }` — `createInferTool`'s advertised overrides; `format`/`enum` are RUNTIME call args, not construction options.                                                                                                                                                                                             |
| `EndpointHandler`          | type      | `(args: Readonly<Record<string, unknown>>) => Promise<unknown> \| unknown` — mirrors `@orkestrel/tool`'s `ToolOptions.execute` signature EXACTLY, so `execute: (args) => definition.invoke(args)` typechecks with zero assertions.                                                                                                 |
| `EndpointDefinition`       | interface | `{ name, description, samples, invoke }` — one concrete endpoint `createEndpointTool` wraps; `samples` MUST be non-empty (checked at construction).                                                                                                                                                                                |
| `EndpointToolOptions`      | interface | `{ format?, enum?, validate? }` — construction-time inference tuning for `createEndpointTool`'s advertised `parameters` (`format`/`enum` default `false`), plus whether that schema is ENFORCED at `execute` time (`validate` defaults `true`; `false` restores raw passthrough).                                                  |

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

Every `create*Tool` factory returns a plain `ToolInterface` (`@orkestrel/tool`'s type — its method surface is documented in [`tool.md`](tool.md), not re-documented here). `createToolFunction` returns a plain `WorkflowFunction`; `createAgentFunction` returns the compatible metadata-bearing `AgentFunction`; `createWorkflowFunctions` returns the frozen composed registry. The `WorkspaceManagerInterface` / `WorkflowRunnerInterface` / `AgentRegistryInterface` a caller supplies are likewise defined and documented upstream. `DefinitionStoreInterface` is the point-access persistence seam `MemoryDefinitionStore` / `DatabaseDefinitionStore` implement; the lifecycle classes expose their minimal orchestration methods directly.

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

```ts
import type { StreamInterface } from '@orkestrel/server'
import type { TerminalManagerInterface, TimerHandler } from '@orkestrel/terminal'
import { TerminalConnection, TerminalRoutes } from '@orkestrel/toolbox/server'

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

These invariants hold across `src/core` ↔ `toolbox.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `const` / `interface` / `type` row in the `## Surface` tables is a real export of `src/core`, and every export appears as a Surface row — exhaustive, both directions under AGENTS' documentation contract.

2. **One tool = one behavior; the runtime supplies the envelope, this package supplies the handler.** Each `create*Tool` factory returns a plain `ToolInterface` (`@orkestrel/tool`). Under AGENTS' narrow-untrusted-input-with-guards rule, its handler parses the model-supplied `args` against a compiled [contract](contract.md), dispatches, and either RETURNS a plain value on success or THROWS a typed error on every failure path — it never builds a `ToolResult` itself. The runtime supplies registry execution and result isolation; see [`tool.md`](tool.md). Through that registry, a failure's flattened message text appears EXACTLY ONCE, identically, over both the agent loop and MCP.

3. **Contract-compiled schemas throughout.** Every advertised `parameters` is `schemaToParameters(contract.schema)` off a `createContract`-compiled shape (`workflowStepsShape` / `workflowDraftShape` / `workspaceToolShape` / `agentToolShape`) — never a hand-written JSON Schema — so the guard / parser / schema the handler validates against can never drift from what the tool advertises.

4. **Workflow/agent recursion is lineage-derived and contextually composed.** `WorkflowLineage` is a copied, frozen chain of nonempty unique tags, strictly alternating `workflow:` then `agent:`. Malformed configured lineage or a factory-incompatible final tag throws `ToolboxError('TOOL')`; runtime workflow mismatch, repeated workflow/agent id, or over-depth target throws `ToolboxError('DEPTH')` before agent, tool, or runner activity. Depth is zero-based and derived only from workflow-tag count minus one (empty/root is `0`): root plus eight nested workflows is allowed, the ninth nested workflow is rejected. `createWorkflowFunctions` is the sole composition engine: it snapshots opaque `functions`, rejects a marked `AgentFunction` supplied through that opaque channel, rejects function/agent key collisions, and contextually adapts raw `agents` for the exact target lineage. Its frozen registry has a null prototype, so Workflow 0.0.8's native bracket lookup cannot resolve unregistered inherited names such as `toString`, `constructor`, `valueOf`, `hasOwnProperty`, or `__proto__`; those remain genuine native `WorkflowError('TRANSITION')` failures. Opaque wrappers or spoofed metadata that hide their real agent behavior are outside this guarantee; hosts must not use them to share one live agent concurrently.

5. **`createWorkflowTool` widens the authoring surface additively; the strict contract stays the soundness gate.** It advertises the SIMPLE flat shape (`{ name?, steps: [{ name }] }`) as its `parameters` so a small model can author a whole tree in one call, but its handler ACCEPTS three forms — empty args (the wrapped `definition`), a `steps` array (the flat form, `expandSteps`'d), or a nested draft/full definition (`createWorkflowDraftContract`-parsed + `completeDraft`'d, or accepted as-is when already strict) — and EVERY path converges on the byte-for-byte-unchanged `createWorkflowContract().is` gate before it runs. A blob that fails to parse, expand, or complete, or whose result fails that strict gate, THROWS a `TOOL` `ToolboxError`; the leniency never reaches the runner. An omitted task `run` is the native JSON-`null` no-op. A present unresolved name reaches the runner and is rejected by the native drivability gate as a genuine `WorkflowError('TRANSITION')`; Toolbox does not duplicate that preflight.

Before shape branching or property reads, the handler snapshots untrusted `args` through Contract's `attempt` + `cloneJSONRecord`; hostile traversal or inexact JSON becomes `ToolboxError('TOOL', 'malformed workflow definition', ...)` before runner functions or persistence begin, never a raw Proxy/Contract error. A standalone `createWorkflowTool` called with empty args runs its wrapped definition. The tool bound onto an agent deliberately wraps the containing workflow id, so its empty-args call is a repeated-lineage cycle and throws `ToolboxError('DEPTH')`; a bound nested call must author a new target rather than receive an invented id.

6. **`createWorkflowTool` delegates composition and persistence without inventing identity.** Configured lineage/functions/agents registries are copied at construction. At invocation the strict target tag is appended, repeated ids and over-depth are rejected, and `createWorkflowFunctions` builds the contextual registry only when functions or agents were supplied. The resulting registry and optional store are forwarded to `runner.execute(target, { functions?, store? })`. The 0.0.8 runner owns initial/attempt/settlement/final checkpoints, coalescing, restore-ready final snapshots, and persistence failures as data. `WorkflowToolResult` projects `{ status, count, durable?, fault? }`: `durable`/`fault` appear exactly when the native result supplies them. A flat authoring `name` is the deterministic workflow id; repeated runs with the same name address and replace the same store snapshot rather than minting a hidden id.

7. **`createWorkspaceTool` is manager-driven, with a no-active ergonomic seam.** `options.manager` (drive directly) takes priority over `options.store` (build a fresh manager over it via `@orkestrel/workspace`'s `createWorkspaceManager`); neither given constructs a manager over `@orkestrel/workspace`'s in-memory default. NOTE the deliberate `store` divergence from invariant 6: the workspace tool's `store` only BACKS the constructed manager's `open` / `save` — the tool's edits are NOT auto-persisted (durability requires an explicit caller `save`), whereas the workflow tool forwards its store to native run-wide checkpoint persistence. Every edit / read arm targets `manager.active` — never a specific workspace by id directly — so a host repoints which workspace the model edits via the two REGISTRY arms (`workspaces` lists them, `switch` re-points `active`, lenient on an unknown id). A WRITING arm (write / splice / prepend / append / move / remove / replace) run with no active workspace AUTO-CREATES + activates one (`manager.add()`); a pure-READ arm (read / list / has / search) against no active workspace returns the EMPTY result, never creating one and never throwing. `search` / `replace` pass the workspace vocabulary through unchanged: `regex` chooses pattern-vs-literal matching, `sensitive` controls case sensitivity, and `limit` caps occurrences; `replace` returns the dependency's own `ReplaceResult` directly as `{ occurrences, files }`.

8. **`createAgentTool` carries its own `store` slot, composable with a registry-level store.** `AgentToolOptions.store` is an optional `ConversationStoreInterface` (`@orkestrel/agent`): when supplied, the handler `await`s `store.set(agent.context.conversations.active.snapshot())` once `agent.generate()` SETTLES SUCCESSFULLY, before returning — one snapshot PER delegation (each `registry.build` mints a fresh conversation id via its seeded `add`, so a shared store never collides, it accumulates one snapshot per delegated call). A `store.set` failure PROPAGATES as the tool call's own failure (isolated by `ToolManagerInterface` into the canonical `error`, per invariant 2) — persistence is not best-effort. Omitted, the handler persists nothing from this tool. This composes with, and is independent of, `AgentRegistryOptions.store` (`@orkestrel/agent` 0.0.4): a registry built with its OWN `store` backs EVERY agent it builds with a store-backed `ConversationManagerInterface`, including ones built through this tool — a caller may use either seam alone or both together.

9. **A delegated sub-agent's lifecycle is a single `generate()` call.** `createAgentTool`'s handler resolves a live agent via `registry.build`, awaits ONE `agent.generate()`, and returns its settled `content` — `AgentInterface` (`@orkestrel/agent`) exposes no teardown method, so there is nothing to release afterwards; the agent's state lives entirely in the resolved `AgentContextInterface`, owned by the caller's registry.

10. **Provider-agnostic delegation.** `createAgentTool` never imports or references a concrete `ProviderInterface` implementation — `options.provider` / a per-call `call.provider` is a REGISTRY KEY resolved by `registry.build`, so swapping the provider behind that key changes nothing about the tool. A missing / unresolvable provider (neither the call nor the tool's own default supplies one) THROWS a `TOOL` `ToolboxError` before any agent is built.

11. **`ToolboxError` owns Toolbox boundary failures; upstream errors own genuine domain failures.** It carries a machine-readable `ToolboxErrorCode` + optional `context` and is always thrown, never returned as `{ error }`: `TOOL` covers malformed authoring, missing tool bindings, invalid tool/agent JSON, and the other package-owned resolution/configuration guards; `DEPTH` covers Toolbox workflow/agent nesting refusal; the remaining codes retain their terminal/database/relation meanings. A genuine error thrown by an executed tool passes through unchanged. The native workflow runner's genuine `WorkflowError` also passes through unchanged, including `TRANSITION` for an unresolved named run; Toolbox never invents invalid workflow `TOOL`/`DEPTH` codes and never relabels runner errors. `WorkspaceError` similarly retains its upstream domain ownership. An in-process direct call can inspect typed codes/context; `ToolManagerInterface.execute` flattens the error to its message.

12. **The workflow-function adapters are opt-in and exact at the JSON boundary.** `createToolFunction(tools, name)` resolves the live tool, awaits `tool.execute(controller.input)`, then deep-gates the unknown return through `parseJSONValue`; a missing binding or non-JSON result throws `ToolboxError('TOOL')`, while a genuine tool throw passes through by identity. It rejects `name === WORKFLOW_TOOL_NAME` at construction so the reserved live workflow tool cannot be adapted back into a workflow registry. `createAgentFunction(agent, options?)` returns a frozen `AgentFunction` with frozen category/lineage metadata. It starts `agent.generate({ signal: controller.signal })` synchronously after any runner-bound tool installation, using Agent's native per-run cancellation seam: an already-aborted signal starts no provider call, and cancellation settles as a partial result. The full `AgentResult` is projected through Agent-owned `agentResultToJSON`; malformed structural results become `ToolboxError('TOOL')`. With a runner, an already-running real agent is rejected before its workflow-tool binding can be replaced, so another Toolbox branch observes the running state. Genuine agent/provider errors retain identity.

13. **The lean `summary` / full `description` split, and `createDescribeTool`'s expansion seam.** `createWorkflowTool`, `createWorkspaceTool`, and `createAgentTool` each set `ToolInterface.summary` (`@orkestrel/tool`) to a frozen one-sentence constant (`WORKFLOW_TOOL_SUMMARY` / `WORKSPACE_TOOL_SUMMARY` / `AGENT_TOOL_SUMMARY`) alongside their unchanged full teaching `description`; `ToolManagerInterface.definitions()` advertises `summary ?? description`, so a model sees the lean text by default. `createDescribeTool(tools)` is the on-demand expansion: given a registered `name`, it looks the tool up via `tools.tool(name)` and returns its full `tool.description` (falling back to `tool.summary`, then a placeholder, when a tool has neither) — never truncated, never re-derived. Each summary's text points the model at `describe('<name>')` for the full schema.

14. **`createDatabaseTool` and `createRelationTool` are single-tool-many-operations, matching `createWorkspaceTool`'s shape.** `createDatabaseTool` dispatches 11 operations (`create` / `tables` / `get` / `records` / `count` / `aggregate` / `add` / `set` / `update` / `remove` / `destroy`) off `databaseToolShape`; `createRelationTool` dispatches 5 (`load` / `find` / `link` / `unlink` / `links`) off `relationToolShape`. Both set `ToolInterface.summary` (`DATABASE_TOOL_SUMMARY` / `RELATION_TOOL_SUMMARY`) alongside their full teaching `description`, retrievable via `createDescribeTool`, per invariant 13. Every `'get'` / `'add'` / `'set'` / `'update'` / `'remove'` and `'load'` operation's `key` field takes EITHER a single key OR an array of keys (AGENTS' batch overload mold, with the array form resolving first); a single-key call returns a singular result field (`row` / `key` / `updated` / `removed`), an array-key call returns the plural (`rows` / `keys` / `updated` / `removed` as arrays).

15. **The database tool's query form is SERIALIZED, never fluent.** `databaseToolShape`'s `query` is a flat object — `{ conditions?: [{ column, operator, values, connector? }], order?, limit?, offset? }` — where `values` is ALWAYS an array, even for a single-value operator (`{ column: 'age', operator: 'from', values: [18] }`), so a small model never chains method calls or guesses arity. `queryOf` normalizes the parsed form into a live `@orkestrel/database` `QueryInput`, defaulting an omitted condition `connector` to `'and'` (the wire form lets a caller drop `connector` on the LAST condition, since it joins nothing forward).

16. **The `TableSpec` column DSL is bounded to four primitive kinds.** A `ColumnSpec` is either a bare `ColumnKind` shorthand (`'string'` / `'integer'` / `'number'` / `'boolean'`) or `{ type, optional? }`; `expandTables` compiles a `TableSpec` into the `@orkestrel/database` `TableMap` `createDatabase` accepts via `columnShape` / `kindShape`, wrapping an `optional: true` column in `optionalShape`. There is no nested/composite column kind — a table's shape is a flat map of column name to `ColumnSpec`, never an object/array column.

17. **`'records'` / `'find'` / `'links'` truncate against a configured cap, never silently.** `createDatabaseTool`'s `'records'` (cap: `DatabaseToolOptions.limit`, default `DATABASE_TOOL_LIMIT`) and `createRelationTool`'s `'find'` / `'links'` (cap: `RelationToolOptions.limit`, default `RELATION_TOOL_LIMIT`) each PROBE one row past the effective limit (`clampQuery` for the database tool; the same idiom inline for `'find'`) to detect truncation without a separate count round trip, returning `{ rows, count, truncated, limit }` (`'links'`: `{ keys, count, truncated, limit }`) — `truncated` is `true` exactly when storage held more than `limit` matching rows/keys. A caller's own `query.limit` / `limit` can only LOWER the effective cap, never raise it past the configured ceiling.

18. **A typed upstream failure re-surfaces in-process as a typed `ToolboxError`, never passes through raw.** `createDatabaseTool` catches a `@orkestrel/database` `DatabaseError` and re-throws a typed `DATABASE` `ToolboxError` carrying the original `DatabaseErrorCode` in `context.code` (`databaseToolCode`); `createRelationTool` does the same for a `@orkestrel/relation` `RelationError` → `RELATION` (`relationToolCode`, checked FIRST) and, underneath it, a `DatabaseError` → `DATABASE` (mirroring the database tool's own mapping) — so an in-process catch or direct `tool.execute(args)` call sees exactly one of `TOOL` (this tool's own guards: malformed args, unknown manager/model/database/driver), `RELATION`, or `DATABASE`, never an unwrapped upstream error. A `ToolboxError` already thrown by this tool's own guards passes through UNWRAPPED (never re-mapped a second time). A `ToolManagerInterface.execute` registry caller does not receive that code or context; it receives only the flattened message string.

19. **`DatabaseToolOptions.readonly` gates every mutating operation up front.** When `true`, `createDatabaseTool` throws a typed `TOOL` `ToolboxError` for `'create'` / `'add'` / `'set'` / `'update'` / `'remove'` / `'destroy'` BEFORE resolving a database or touching storage — the non-mutating operations (`'tables'` / `'get'` / `'records'` / `'count'` / `'aggregate'`) are unaffected. The exported `DATABASE_TOOL_MUTATIONS` membership list is a runtime-frozen readonly array, so a consumer cannot mutate it to bypass this gate. There is no equivalent gate on `createRelationTool` — its `'link'` / `'unlink'` writes are ungated (relation-tool callers rely on the underlying database's own access controls, if any).

20. **A `DatabaseDefinition` is CONFIG-ONLY and round-trips through a `DefinitionStoreInterface` — never a live handle.** `createDatabaseTool`'s `'create'` persists `{ id, driver, tables, primary?, indexes?, version? }` (never the constructed `DatabaseInterface`) when `options.store` is supplied, and publishes the new live handle to its resolver only after persistence succeeds. Every other operation lazily `resolve`s an uncached id by reading the definition back and reconstructing a live database from it (`createDatabase` + `expandTables`) — the live handle itself is cached only in-process (`Map<string, DatabaseInterface>`), reconstructed fresh on the next process from the stored config. `primary` and `indexes` are paired schema metadata, while `version` is the target stamp a versioning driver writes after first use when it implements paired `metadata` / `stamp` capabilities. `isDatabaseDefinition` is the boundary guard a `DefinitionStoreInterface` applies to an untrusted persisted blob before trusting it. `MemoryDefinitionStore` structured-clones definitions on copy-in and copy-out; `DatabaseDefinitionStore` stores one opaque JSON column in a `@orkestrel/database` table. They remain exact `get` / `set` / `delete` twins while preventing caller mutation from aliasing stored state.

21. **The relation tool's `include` is a FLAT dot-path list, capped by `RelationToolOptions.depth`.** `'load'` / `'find'` accept `include?: string[]` — each path a dot-separated chain of relation names (`'contacts.account'`) — expanded by `expandInclude` into a live `@orkestrel/relation` `Include` tree; a longer path SUBSUMES a shorter sibling's bare `true` (`['contacts', 'contacts.account']` → `{ contacts: { account: true } }`). A path exceeding `depth` segments (default `RELATION_TOOL_DEPTH`), or carrying an empty segment (a leading/trailing/doubled `.`), throws a typed `TOOL` `ToolboxError` before any query runs. `relationManagerOf` resolves which registered `RelationManagerInterface` a call addresses (an explicit `manager` miss, or an omitted one with other-than-exactly-one registered, throws typed `TOOL`); `relationModelOf` resolves `model` against it the same way.

22. **`createDatabaseTool` durability and ownership are narrower than they look.** A lazily re-minted database over the DEFAULT in-memory driver yields an EMPTY database — only the `DatabaseDefinition` schema persists in `store`, never rows; durable rows need a persistent driver factory registered in `DatabaseToolOptions.drivers`. A cached live database is never evolved in place. To adopt a new target `version`, create a new database id backed by a versioned persistent driver, or close the old tool lifecycle and construct a new tool whose stored definition carries the new schema metadata and stamp. `'destroy'` closes whatever handle is cached for the id, INCLUDING an embedder-supplied `DatabaseToolOptions.databases` handle — the embedder relinquishes that handle's lifecycle to this tool for any id it wires in. `timeout`, when present, must be a nonnegative safe integer and is validated when the tool is constructed. Its fresh abort signal is passed only to `records`, `count`, `aggregate`, `add`, `set`, `update`, and `remove`, whose current table APIs accept operation options; it does not bound store resolution, construction, schema inspection, `get`, or `close`, and is not an outer deadline. The tool assumes the single-writer, non-reentrant model `@orkestrel/database` itself assumes — concurrent tool calls against one id are NOT serialized by this tool. Unlike `'records'` / `'find'` / `'links'`, `'get'` is UNCAPPED by `DatabaseToolOptions.limit` (bounded only by the caller's `key` array size).

23. **`createEndpointTool` ENFORCES its advertised inferred schema via a NORMALIZING parse by default (`@orkestrel/contract` 0.0.7's `schemaToShape`), with an explicit `validate: false` opt-out.** `parameters` is inferred ONCE at construction (`samplesToSchema` + `schemaToObject` over `definition.samples`, tuned by `EndpointToolOptions.format`/`enum`) — the SAME object-rooted schema is compiled ONCE (`schemaToShape` → `createContract`) into the contract `execute` `parse`s every call's `args` through before `definition.invoke` runs. The parse COERCES a scalar to its inferred type where the house parsers coerce (a number to/from a numeric string, a boolean from `'1'`/`'0'`/`'true'`/`'false'`/`1`/`0`) — `invoke` receives the COERCED values (e.g. `7` sent for a string slot arrives at `invoke` as `'7'`), not the raw call args. A call whose `args` fails to parse into a record — a required key missing, or a value not coercible to its slot's type — THROWS a typed `TOOL` `ToolboxError` carrying the compiled contract's structured `explain` faults (via `contract.explain(args)`), and `invoke` is never called. Beyond that coercion, enforcement is STRUCTURAL: required keys, `enum` membership, and numeric bounds — `format` annotations (`email`, `date-time`, `uuid`, `uri`, ...) are NEVER asserted, mirroring `@orkestrel/contract`'s own widening-only law for `schemaToShape` (a `format: true`-tuned endpoint still accepts a non-conforming string in that slot); a key outside the closed inferred schema is SILENTLY DROPPED, not rejected — `@orkestrel/contract`'s own `parse` grants that same leniency to any closed object. `EndpointToolOptions.validate: false` restores the PRE-0.0.7 behavior exactly: `execute` calls `definition.invoke(args)` with the model-supplied `args` EXACTLY as received, never re-parsed, coerced, or checked against the advertised schema — the capability this package shipped before 0.0.7 added `schemaToShape`, kept as an explicit, documented escape hatch. `createInferTool`'s own call args are, as before, ALWAYS validated against `inferToolShape` (a hand-written shape) regardless — it is the schema INFERENCE's caller, not an inferred schema's consumer. Both factories' inferred schemas surface sample-derived strings VERBATIM (property names, and enum entries when opted in), so sample data intended for schema inference should be treated as untrusted content whenever the resulting schema will be advertised to other agents. `createInferTool`'s OPTIONAL `candidates` call arg is the OPPOSITE seam: it checks values against the SAME call's freshly inferred schema (compiled per-call, since the schema itself is derived from that call's `samples`) and returns a UNIFORM `{ index, valid, coercible, faults? }` entry per candidate. `valid` is a STRICT `.is` guard verdict, not a normalizing `.parse` — `7` against an inferred string slot is INVALID (no coercion), where the same value would be silently coerced to `'7'` by `createEndpointTool`'s enforcement. `coercible` (`checker.parse(candidate) !== undefined`) answers that SEPARATE question directly — would `createEndpointTool`'s default enforcement admit this value — and, by the house parse/guard round-trip guarantee, is ALWAYS `true` on a `valid: true` entry. Because `@orkestrel/contract` 0.0.7's `.explain` mirrors `.parse`'s leniency, not `.is`'s strictness, a strictly-invalid but coercible candidate (`7` against a string slot) yields `{ valid: false, coercible: true, faults: [] }` — EMPTY faults, since the mismatch normalization would silently fix is not one `.explain` reports; `faults` populates only for a NON-coercible mismatch (`coercible: false`). `checker.is` / `.parse` / `.explain` are total over JSON-safe input — a JSON-safe hostile candidate (a `__proto__`-carrying object, deep nesting) reaches all three and yields a bounded, non-throwing per-candidate verdict; a NON-JSON-safe candidate (a throwing-getter `Proxy`) never reaches the checker — it fails the OUTER `args` parse and rejects the WHOLE call as a `TOOL` error, with no per-candidate verdict. `candidates` is uncapped in COUNT (any array length is accepted), but each individual check is bounded (`.explain`'s fault list and the checker's own schema are both bounded by the inference limits already governing `samples`), so the total per-call cost is LINEAR in `candidates.length`.

## Patterns

These patterns follow the arc — author + run a workflow through the tool; persist its snapshot; drive a workspace through the tool; delegate to a sub-agent; compose the adapters into a workflow's own registry.

### Authoring + running a workflow through the tool, via a real `ToolManager`

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

// A small model authors the SIMPLE flat shape — no ids/names required.
const result = await tools.execute({
	id: 'call-1',
	name: 'workflow',
	arguments: { name: 'release', steps: [{ name: 'compile' }, { name: 'publish' }] },
})
if (!result.success) throw new Error(result.error)
result.value // { status: 'completed', count: 2 } — the single-level envelope; no nested { id, name, value }
```

### Plugging a `WorkflowStoreInterface` and retrieving the persisted snapshot

```ts
import { createWorkflowTool } from '@orkestrel/toolbox'
import {
	createMemoryWorkflowStore,
	createWorkflowRunner,
	restoreWorkflow,
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
const restored = snapshot === undefined ? undefined : restoreWorkflow(snapshot)
restored?.status // 'completed' — the persisted run, rebuilt from its own snapshot
```

### Driving the workspace tool with a plugged store

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

### Persisting a delegation's conversation via the agent tool's own `store` slot

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

### Lean advertisement + on-demand expansion via `createDescribeTool`

```ts
import { createDescribeTool, createWorkflowTool, createWorkspaceTool } from '@orkestrel/toolbox'
import { createToolManager } from '@orkestrel/tool'
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

### Composing opaque leaves and raw agents into a workflow registry

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
		{ id: 'review', name: 'Review', tasks: [{ id: 'r', name: 'Review', run: 'review' }] },
		{ id: 'publish', name: 'Publish', tasks: [{ id: 'p', name: 'Publish', run: 'publish' }] },
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

```ts
import {
	agentTag,
	completeDraft,
	completePhaseDraft,
	completeTaskDraft,
	createWorkflowDraftContract,
	deriveWorkflowDepth,
	extendLineage,
	expandSteps,
	isAgentFunction,
	isWorkflowLineage,
	lineageOf,
	workflowTag,
	workflowToolSummary,
} from '@orkestrel/toolbox'

workflowTag('release') // 'workflow:release'
agentTag('reviewer') // 'agent:reviewer'

const root = lineageOf(['workflow:release'])
const agent = extendLineage(root, agentTag('reviewer'))
isWorkflowLineage(agent) // true
deriveWorkflowDepth(root) // 0
isAgentFunction(() => 'opaque') // false

createWorkflowDraftContract().parse({ phases: [{ tasks: [{ run: 'compile' }] }] })

completeTaskDraft({ run: 'compile' }, 'phase-0', 0) // { id: 'phase-0-task-0', name: 'phase-0-task-0', run: 'compile' }
completePhaseDraft({ tasks: [{ run: 'compile' }] }, 0) // { id: 'phase-0', name: 'phase-0', tasks: [...] }
completeDraft({ phases: [{ tasks: [{ run: 'compile' }] }] }) // a complete WorkflowDefinition, ids/names filled positionally

expandSteps({ steps: [{ name: 'compile' }] }) // one one-task phase whose task's `run` is 'compile'

// workflowToolSummary preserves the runner's optional durability/fault fields exactly:
declare const result: Parameters<typeof workflowToolSummary>[0]
workflowToolSummary(result) // { status, count, durable?, fault? }
```

### Recovering a typed `ToolboxError`

```ts
import { ToolboxError, isToolboxError } from '@orkestrel/toolbox'

try {
	throw new ToolboxError('TOOL', 'task is required')
} catch (error) {
	if (isToolboxError(error)) console.log(error.code) // 'TOOL'
}
```

### Asking + answering through the terminal seam

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
import { coerceAnswer, terminalToolCode } from '@orkestrel/toolbox'
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
import { createTerminalRoutes } from '@orkestrel/toolbox/server'
import { createTerminalManager } from '@orkestrel/terminal'

const manager = createTerminalManager()
manager.add('assistant')
const routes = createTerminalRoutes(manager, { token: 'secret' })
// mount `routes` (GET SSE + POST answer, one shared `:name`-templated path) against
// any router that accepts a `{ method, path, handler }` structural record —
// byte-compatible with `@orkestrel/terminal`'s own `PromptClient`.
```

### Driving the database tool: create with metadata, add a row, query with a serialized condition

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
					notes: { type: 'string', optional: true },
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

### Persisting database definitions via `DefinitionStoreInterface`

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
definition?.driver // 'memory' — the CONFIG-ONLY blueprint, never a live handle

await durable.set({ id: 'audit', driver: 'memory', tables: {} })
const restored = await durable.get('audit')
await durable.delete('audit')
restored?.id // 'audit'
```

### Wiring the relation tool over a live `RelationManagerInterface` and loading nested includes

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
	columnShape,
	databaseToolCode,
	expandTables,
	isColumnKind,
	isColumnSpec,
	isDatabaseDefinition,
	kindShape,
	queryOf,
	relationManagerOf,
	relationModelOf,
	relationToolCode,
} from '@orkestrel/toolbox'
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

queryOf({ conditions: [{ column: 'age', operator: 'from', values: [18] }] })
// { conditions: [{ column: 'age', operator: 'from', values: [18], connector: 'and' }] }

declare const managers: Readonly<
	Record<string, import('@orkestrel/relation').RelationManagerInterface>
>
const resolved = relationManagerOf(managers, undefined) // the sole registered manager, or throws
relationModelOf(resolved, 'accounts') // the resolved model, or throws on an unknown name
```

### Inferring a JSON Schema from example values, via a real `ToolManager`

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
// runs (see Contract invariant 23) — a nonconforming call throws a typed `TOOL` `ToolboxError`
// with structured faults instead of reaching `invoke`. Pass `{ validate: false }` as the second
// argument to `createEndpointTool` to restore raw passthrough.
```

## Tests

- [`tests/guides.test.ts`](../../tests/guides.test.ts) — the `## Surface` ↔ `src/core` + `src/server` bijection (value + type exports, spanning both barrels), and this guide's `## Patterns` fences resolving to real exports (per-specifier) with resolving imports.
- [`tests/src/core/factories.test.ts`](../../tests/src/core/factories.test.ts) — every factory returning a working instance or value; workflow coverage composes real runners, agents, tools, stores, and scripted providers across direct roots, top-level authoring tools, opaque-leaf propagation, frozen null-prototype registry isolation/collisions, inherited-name `TRANSITION` refusals, explicitly registered dangerous own keys, depth 8/9 boundaries, repeated workflow ids, bound no-arg cycle refusal, self-recursion, A→B→A, same-agent concurrency, native per-run cancellation (including already-aborted provider exclusion), hostile argument containment before runner/store entry, Agent-owned projection, malformed structural results, genuine error identity, and deterministic named-store replacement. Database coverage includes all 11 operations, frozen readonly-mutation membership, persistence-before-cache publication through a real failing database store, timeout validation, query truncation, and typed failures. Creation and resolver coverage prove `primary` / `indexes` reach real memory-driver metadata and `version` is stamped after first use.
- [`tests/src/core/databases/DatabaseResolver.test.ts`](../../tests/src/core/databases/DatabaseResolver.test.ts) — caller-map isolation, explicit cache operations, stored-definition construction and reuse, and the typed unknown-database failure.
- [`tests/src/core/helpers.test.ts`](../../tests/src/core/helpers.test.ts) — the reusable workflow, terminal, database, and relation helpers; lineage coverage proves alternating/nonempty/unique validation, hostile-boundary totality, copy/freeze isolation, extension, zero-based depth derivation, and `AgentFunction` metadata narrowing. Database coverage includes `TableSpec` expansion, strict `DatabaseDefinition` validation for `primary` / `indexes` / finite `version`, obsolete-field rejection, `queryOf` connector defaults, and `clampQuery` probe limits.
- [`tests/src/core/shapers.test.ts`](../../tests/src/core/shapers.test.ts) — every advertised shape, including valid samples of all 11 database operation arms, create-time `primary` / `indexes` / `version`, query inputs, single/array row-key forms, and malformed metadata rejection.
- [`tests/src/core/errors.test.ts`](../../tests/src/core/errors.test.ts) — `ToolboxError` carrying its `code` + optional `context`, and `isToolboxError` narrowing a caught value (accepting a real instance, rejecting a plain `Error` / non-error value).
- [`tests/src/core/stores.test.ts`](../../tests/src/core/stores.test.ts) — both definition-store twins run the same round-trip, replacement, deletion, optional-metadata, and nested copy-isolation scenarios; database-backed-only cases cover malformed stored blobs and a custom driver.
- [`tests/src/server/factories.test.ts`](../../tests/src/server/factories.test.ts) — `createTerminalRoutes` returning exactly two records (GET then POST) sharing one path; the GET route replaying every currently-pending prompt as a `pending` frame then live-forwarding `pending` / `expire` events scoped to `name`, arming a keepalive `: ` comment ping via an injected `timer` that RE-VALIDATES the connection's presented token on every tick (a `TerminalToken` function that starts rejecting mid-stream tears the stream down through the shared teardown and does not re-arm; a static string token is a no-op across ticks), ending the stream (unsubscribing + cancelling the keepalive) on the request's `AbortSignal` firing, and `401`/`404` on a token mismatch / unknown `name`; the POST route reading the body capped at `options.limit` bytes and parsing the JSON body and routing it through `manager.answer` — `204` on success, `413` an over-limit body (a lying small `Content-Length` on a big streamed body still capped, `manager.answer` never called), `400` invalid JSON, `422` a non-`{ id, value }` body or a `'unknown'`/`'rejected'` answer result, `404` an unknown `name` or a `'terminal'` answer result, `401` on a token mismatch; mount-churn pressure (50 sequential GET connect→abort cycles) proving zero leaked keepalive timers / manager listener subscriptions and no ghost duplicate `pending` frames; POST fuzz pressure over malformed/invalid-shape bodies, unknown endpoint, bad token, and an expired id; and consumer-side stream-close self-heal — a live `pending` event or a keepalive tick arriving on a stream closed WITHOUT the request `AbortSignal` ever firing runs the SAME teardown the abort path runs (listeners detached, keepalive cancelled), never re-arming or leaking.
- [`tests/src/server/routes/TerminalConnection.test.ts`](../../tests/src/server/routes/TerminalConnection.test.ts) — idempotent direct opening, already-aborted request teardown, and fail-closed handling when a direct token validator throws.

## See also

- [`tool.md`](tool.md) — the `ToolInterface` / `ToolManager` runtime every tool here plugs into.
- [`workspace.md`](workspace.md) — the `WorkspaceManagerInterface` / `WorkspaceStoreInterface`, workspace errors, search options, and replace result the workspace tool drives.
- [`agent.md`](agent.md) — the `AgentRegistryInterface` / `AgentInterface` the agent tool and `createAgentFunction` resolve and run.
- [`workflow.md`](workflow.md) — the `WorkflowDefinition` / `WorkflowRunnerInterface` / `WorkflowStoreInterface` / `WorkflowFunction` primitives the workflow-authoring tool and adapters consume; native runner `WorkflowError`s pass through unchanged, while Toolbox authoring/depth/JSON guards use `ToolboxError`.
- [`contract.md`](contract.md) — the shape DSL (`createContract`, `objectShape` / `unionShape` / …) every advertised `parameters` compiles through, and `schemaToParameters`.
- [`terminal.md`](terminal.md) — a byte-identical mirror of the guide for `@orkestrel/terminal`, the `TerminalManagerInterface` / `PromptType` / `TerminalError` primitives `createPromptTool` / `createAnswerTool` / `createTerminalRoutes` are built over, and the `PromptClient` `createTerminalRoutes` stays byte-compatible with.
- [`server.md`](server.md) — a byte-identical mirror of the guide for `@orkestrel/server`, the `openStream` SSE primitive `createTerminalRoutes`'s GET route is built over.
- [`database.md`](database.md) — a byte-identical mirror of the guide for `@orkestrel/database`, the `DatabaseInterface` / `DriverInterface` / `QueryInput` / `TableMap` primitives `createDatabaseTool` (and, underneath it, `createRelationTool`) is built over.
- [`relation.md`](relation.md) — a byte-identical mirror of the guide for `@orkestrel/relation`, the `RelationManagerInterface` / `ModelInterface` / `Include` primitives `createRelationTool` is built over.
- [`AGENTS.md`](../../AGENTS.md) — the rules; narrow untrusted input with guards, and keep documentation as an enforced contract.
- [`README.md`](../README.md) — the guides index.
