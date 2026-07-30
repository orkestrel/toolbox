# Workflow

> Orchestration as DATA: a JSON-serializable `Workflow → Phase → Task` tree — a strict three levels, positional, no DAG — that a UI or an LLM authors, persistence stores, and a thin engine drives by COMPOSING the shipped execution substrate. Not a general DAG engine: it trades arbitrary dependency graphs for a fixed, deterministic shape, and writes none of its own concurrency / retry / abort machinery — it reuses what already ships.

Read the module as five layers of one substrate, top to bottom:

- **The tree describes.** The **definition** family (`WorkflowDefinition → PhaseDefinition → TaskDefinition`) is pure JSON — behavior referenced BY NAME, never inline functions — so the whole tree serializes, round-trips, and is safe for a 2B model to emit. One compiled [contract](contract.md) (`createWorkflowContract`) keeps the JSON Schema + guard + parser + seeded generator in lockstep with the hand-written interfaces, so definition and runtime can never drift.
- **The entities control.** The live **entity** family (`Workflow` / `Phase` / `Task`) is the runtime mirror BUILT from a definition: each node is an [§13-observable](emitter.md) synchronous state machine whose status is DERIVED from its children, mutable through its own `add` / `remove` / `move` / `update`, pausable, and snapshot-able at any instant.
- **The engine drives.** The `WorkflowRunner` is a PURE engine that walks the live tree — phases sequentially, each phase's tasks concurrently — COMPOSING the substrate rather than re-implementing status / concurrency / retries / abort, under a `bail` failure policy: `false` (graceful, the default) records each leaf failure as data and finishes every phase; `true` (the database-transaction halt) aborts the in-flight siblings on the first failure and skips the rest.
- **The substrate executes.** Underneath sit the shipped primitives the engine composes: the `Scheduler` paces the host between work, the queue-backed `Runner` bounds and drives a set of units, and a `Controller` is the per-unit handle a handler receives. The engine folds [abort](abort.md) / [timeout](timeout.md) / [budget](budget.md) through this same substrate.
- **The consumer supplies behavior.** A task's `run` is a PLAIN STRING naming a behavior in the `WorkflowOptions.functions` registry — resolved ONCE at construction into the task's `handler` (a `WorkflowFunction`); the engine dispatches by invoking `task.handler` directly, carrying no registry or tool/agent knowledge of its own. Wiring a task to a tool or an agent is OPT-IN through the `@orkestrel/tool` package's adapter factories, composed into the caller's own `functions` registry — the depth + cycle guard against runaway `agent` → workflow-tool → workflow recursion lives in those closures, not the engine.

**Determinism is fixed by design, not configured: tasks within a phase run concurrently; phases run sequentially.** A dependency is expressed STRUCTURALLY — a task that needs another's output goes in a later phase — so the same tree always sequences the same way and there is no DAG to misconfigure. The only per-phase knob is an optional `concurrency` throttle (max-in-flight), never a sequencing control.

Workflow keeps ALL runtime/engine surface — the definition contract, the live entity tree, the PURE runner, and the durable store. The authoring-tool / adapter layer (wrapping a definition as an LLM-callable tool, wrapping a registered tool or a live agent as a `WorkflowFunction`) has moved to the `@orkestrel/tool` package, which depends on this one; see its guide for that surface.

Source: [`src/core`](../../src/core). Surfaced through the `@src/core` barrel.

## Surface

The 80% use case is two steps: author a `WorkflowDefinition` (pure JSON — phases in order, each phase's tasks concurrent, each task naming a registered behavior), then run it through a `WorkflowRunner` that builds the live tree and drives it to a `WorkflowResult`:

```ts
import { createWorkflowRunner } from '@orkestrel/workflow'
import type { WorkflowDefinition } from '@orkestrel/workflow'

const definition: WorkflowDefinition = {
	id: 'release',
	name: 'Release',
	phases: [
		{
			id: 'build',
			name: 'Build',
			tasks: [
				{ id: 'compile', name: 'Compile', run: 'compile' },
				{ id: 'lint', name: 'Lint', run: 'lint' },
			],
		},
		{
			id: 'ship',
			name: 'Ship',
			tasks: [{ id: 'publish', name: 'Publish', run: 'publish' }],
		},
	],
}

const runner = createWorkflowRunner() // a PURE engine — no registries

const result = await runner.execute(definition, {
	functions: {
		compile: async (controller) => `built ${controller.task.id}`,
		lint: async () => 'clean',
		publish: async () => 'published', // or an OPT-IN adapter from `@orkestrel/tool`
	},
})
result.status // 'completed'
result.workflow.phase('build')?.task('compile')?.status // 'completed'
result.results // every settled task's TaskResult, in positional order
```

Why this is safe: the definition is the SINGLE source of truth. `execute` builds the live tree from the definition itself — there is no separately-supplied tree to fall out of sync — so the executed entity can never drift from the `run` string / `concurrency` metadata, and the freshly-built live `workflow` is returned in the result. Each task's `run` string is resolved ONCE at construction against `options.functions` into its `handler`; the runner then simply invokes `task.handler`. Phase `ship` starts only once phase `build` has fully settled; within `build`, `compile` and `lint` run concurrently. A task whose handler is not found AUTO-COMPLETES (the no-handler rule) — an unregistered name is a no-op, not an error, so a partial registry still runs.

### Factories

| API                           | Kind     | Summary                                                                                                                                        |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWorkflowContract`      | function | Compile the workflow-definition `ContractInterface` — JSON Schema + guard + parser + seeded generator, all from one shape.                     |
| `createWorkflow`              | function | Build the live `WorkflowInterface` entity tree from a `WorkflowDefinition` (every node `pending`).                                             |
| `restoreWorkflow`             | function | Rebuild an equivalent live tree from a `WorkflowSnapshot` — the inverse of `snapshot()` (structure + status + results + order).                |
| `assertSnapshot`              | function | Validate a `WorkflowSnapshot`'s `bail` + every node's status / override against the lifecycle vocabulary (throws `RESTORE`).                   |
| `createMemoryWorkflowStore`   | function | Create the in-memory default `WorkflowStoreInterface` — persists `WorkflowSnapshot`s by id (the durable-store seam; no TTL, no options).       |
| `createDatabaseWorkflowStore` | function | Create the driver-pluggable `WorkflowStoreInterface` over a `databases` table (the snapshot as one JSON column; driver defaults to memory).    |
| `createWorkflowRunner`        | function | Create a PURE `WorkflowRunnerInterface` engine over an optional `scheduler` — no registries, no tool/agent knowledge.                          |
| `createWorkflowManager`       | function | Create a `WorkflowManagerInterface` — a store-backed registry of live workflows, with an optional `functions` registry for RUNNABLE hydration. |
| `createScheduler`             | function | Create the cross-environment `setTimeout`-based default `SchedulerInterface`.                                                                  |
| `createRunner`                | function | Create a `RunnerInterface` over a handler — drives a `Queue`, ordered + fail-fast `execute`.                                                   |
| `createDeferred`              | function | Create a `DeferredInterface` — a promise whose settlement (`resolve` / `reject`) is driven externally.                                         |

### The entity tree

The live runtime mirror of a definition. Each entity class implements its interface exactly, so the `## Methods` tables below double as its per-instance method surface (AGENTS §22).

| Class          | Kind  | Role                                                                                                                                                                                                                          |
| -------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Workflow`     | class | The live DERIVED root — status from its phases under `bail`, the cascade's top, `pause` / `resume` / `wait` / `destroy`, `add` / `remove` / `move` / `update` its phases, `snapshot()` / `skip` / `stop`, an owned `emitter`. |
| `Phase`        | class | The live DERIVED middle tier — status from its tasks, recomputes + escalates on a child transition, `pause` / `resume` / `wait`, `add` / `remove` / `move` / `update` / `patch` its tasks, an owned `emitter`.                |
| `Task`         | class | The live leaf state machine — guarded `start` / `complete` / `fail` / `skip` / `stop`, `patch` (pending-only), records a `TaskResult`, an owned `emitter`.                                                                    |
| `PhaseManager` | class | The lean child registry of a workflow's live phases — insertion-ordered `append` / `add` / `remove` / `move` / `update` / `phase` / `phases` / `count`.                                                                       |
| `TaskManager`  | class | The lean child registry of a phase's live tasks — insertion-ordered `append` / `add` / `remove` / `move` / `update` / `task` / `tasks` / `count` (order survives a `skip`).                                                   |

### The execution substrate

Beneath the engine sit the shipped primitives it composes — it re-implements none of them. The pure `WorkflowRunner` engine DRIVES the live entity tree and folds the run-level bounds; the queue-backed `Runner` bounds and drives a set of units under a fail-fast policy; a `Controller` is the per-unit handle a `Runner` handler receives; and `TaskController` mirrors `Controller` one tier up, as the handle a workflow-task `WorkflowFunction` receives. The engine carries NO `functions` / `tools` / `agents` registry of its own — each live task resolves its `run` string ONCE at construction into its own `handler`, and the engine simply invokes it.

| Class            | Kind  | Role                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowRunner` | class | The PURE engine — phases sequential (a plain await loop), each phase's tasks concurrent (one substrate `createRunner` per phase), dispatching each task's OWN resolved `handler`. `execute` has TWO overloads: build-and-drive from a `WorkflowDefinition`, or drive an ALREADY-BUILT caller-owned `WorkflowInterface` (re-reading its live phases/tasks every iteration so a mid-run `add` lands). |
| `Runner`         | class | The substrate orchestrator over a set of units — drives a `Queue`, ordered result aggregation, fail-fast, `pause` / `resume` / graceful `stop`, one-shot.                                                                                                                                                                                                                                           |
| `Controller`     | class | The per-unit handle a `Runner` handler receives — `id` / `input` / `signal` + `wait` / `spawn` / `abort`.                                                                                                                                                                                                                                                                                           |
| `TaskController` | class | The lean per-task handle a `WorkflowFunction` receives — a folded `signal` / `aborted`, the task's `input` + lineage, read-up `results()`.                                                                                                                                                                                                                                                          |

### Scheduler (pacing)

The cooperative host-yield primitive that paces the engine between phases: a loop decides WHAT to do; the scheduler decides WHEN the host regains control.

| API         | Kind  | Summary                                                                                      |
| ----------- | ----- | -------------------------------------------------------------------------------------------- |
| `Scheduler` | class | The cross-environment cooperative-yield default — `yield` / `delay` over `setTimeout` alone. |

### Environment backends

Beyond the cross-environment default, each host has a native cooperative-yield primitive a `yield()` should reach for; the backends are standalone `SchedulerInterface` implementations (no shared engine — unlike the [databases](database.md) query engine, there are only two methods to write per environment) that swap the `yield` primitive while keeping the **exact** abort semantics: a pending `yield` / `delay` rejects with `signal.reason` _verbatim_, an already-aborted signal rejects without arming, and either settle path clears the underlying handle and removes the abort listener (no leak, no double-settle). Each backend's `delay(ms)` is a real `setTimeout`; only the `yield` primitive differs.

The **Node** backend ships in [`src/server`](../../src/server), surfaced through `@src/server`. `NodeScheduler.yield()` waits on `setImmediate` — the canonical Node "give the event loop a turn", running after the current operation and pending I/O. It deliberately does **not** use `node:timers/promises` (whose `{ signal }` option rejects with a Node `AbortError`, `code: 'ABORT_ERR'`, _not_ the caller's `reason`); the timer and abort listener are hand-rolled to forward `signal.reason` verbatim. `priority` is accepted but a no-op — Node has no priority primitive.

The **browser** backends ship in [`src/browser`](../../src/browser), surfaced through `@src/browser`, one per host-turn strategy. All three feature-detect their native API through guards (`isRecord` / `isFunction` from `@src/core`), never an `as` (AGENTS §14), and fall back to a real macrotask where it is absent:

- `BrowserScheduler.yield()` posts to the **Prioritized Task Scheduling API** (`scheduler.postTask`) at the mapped priority (`user` → `'user-blocking'`, `normal` → `'user-visible'`, `background` → `'background'`) — so the urgency hint is honoured — falling back to a `setTimeout(0)` macrotask where `scheduler.postTask` is absent (Firefox today). The caller's `signal` is **not** handed to `postTask` (whose own abort rejects with a platform `AbortError`, not the caller's `reason`); an internal controller cancels the posted task while the scheduler rejects with the verbatim `signal.reason`.
- `FrameScheduler.yield()` resumes just before the next paint via `requestAnimationFrame` (and `cancelAnimationFrame` on abort) — for work that should batch per render frame and naturally pause while the tab is hidden. `priority` is a no-op.
- `IdleScheduler.yield()` resumes when the host is idle via `requestIdleCallback` (and `cancelIdleCallback` on abort), falling back to a `setTimeout(0)` macrotask where it is absent (Safari today) — for low-priority background work that must not contend with rendering or input. `priority` is a no-op.

| API                | Kind  | Summary                                                                                                                               |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `NodeScheduler`    | class | The Node backend — `yield` over `setImmediate`, verbatim abort fidelity (hand-rolled, not `node:timers/promises`); priority a no-op.  |
| `BrowserScheduler` | class | The browser backend — `yield` over `scheduler.postTask` at the mapped priority, falling back to a macrotask; verbatim abort fidelity. |
| `FrameScheduler`   | class | The frame-aligned browser backend — `yield` over `requestAnimationFrame` (resume before paint); priority a no-op; verbatim abort.     |
| `IdleScheduler`    | class | The idle-time browser backend — `yield` over `requestIdleCallback`, falling back to a macrotask; priority a no-op; verbatim abort.    |

| API                      | Kind     | Summary                                                                                                 |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------- |
| `createNodeScheduler`    | function | Create the Node-native `SchedulerInterface` (`yield` over `setImmediate`).                              |
| `createBrowserScheduler` | function | Create the browser-native `SchedulerInterface` (`yield` over `scheduler.postTask`, macrotask fallback). |
| `createFrameScheduler`   | function | Create the frame-aligned `SchedulerInterface` (`yield` over `requestAnimationFrame`).                   |
| `createIdleScheduler`    | function | Create the idle-time `SchedulerInterface` (`yield` over `requestIdleCallback`, macrotask fallback).     |

The browser backends also publish two supporting members through `@src/browser`: the `POST_TASK_PRIORITY` map `BrowserScheduler` reads to translate a portable `SchedulerPriority` into a `scheduler.postTask` priority level, and the `IdleAPI` shape of the feature-detected `requestIdleCallback` / `cancelIdleCallback` pair `IdleScheduler` narrows to (or resolves to `undefined`, falling back to a macrotask).

| Type      | Kind      | Shape                                                                                                            |
| --------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `IdleAPI` | interface | `{ request: (callback) => number; cancel: (handle) => void }` — the feature-detected `requestIdleCallback` pair. |

| API                  | Kind  | Summary                                                                                                                                               |
| -------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST_TASK_PRIORITY` | const | The `SchedulerPriority` → `scheduler.postTask` priority map (`user` → `'user-blocking'`, `normal` → `'user-visible'`, `background` → `'background'`). |

Each backend is a standalone `implements SchedulerInterface`, so its public methods are exactly `yield` / `delay` — the same [Methods](#methods) table below governs every one (AGENTS §22).

### Stores

The durable persistence seam (W-d) — a DUAL-store convention (the `QueueStore` / `SessionStore` pattern). A `WorkflowStoreInterface` persists the pure-JSON `WorkflowSnapshot` keyed by workflow id through two interchangeable backends: `MemoryWorkflowStore` (a plain `Map`, the zero-plumbing DEFAULT, `createMemoryWorkflowStore`) and `DatabaseWorkflowStore` (the opt-in, driver-pluggable twin over a `databases` table, the snapshot stored as ONE OPAQUE JSON column, `createDatabaseWorkflowStore`). Both live under `workflows/stores/`. The Database store's driver DEFAULTS to memory, so it ALSO works in memory out of the box; you opt into the durable plumbing (JSON / SQLite / IndexedDB) by passing a driver — and it swaps in through the SAME interface, without touching the engine or the entity tree. Restore stays the shipped `restoreWorkflow`.

| Class                   | Kind  | Role                                                                                                                                    |
| ----------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryWorkflowStore`   | class | The in-memory default `WorkflowStoreInterface` — a process-lifetime `Map` of `WorkflowSnapshot`s by id; NO TTL (durable until delete).  |
| `DatabaseWorkflowStore` | class | The driver-pluggable twin `WorkflowStoreInterface` — wraps a `databases` table, the snapshot one opaque JSON column (driver-swappable). |

### Registry

The additive manager tier (§9 + the `@orkestrel/agent` line's store standard): `WorkflowManager` (`createWorkflowManager`) is an insertion-ordered registry of live `WorkflowInterface`s keyed by `id`, mirroring `ConversationManager` / `WorkspaceManager` — with the SAME optional `store` seam (`open` hydrates on a registry miss, `save` persists) BUT no `active` / `switch` pointer (nothing in this domain renders "the current workflow"). The workflow-specific nuance: the manager also carries an optional `functions` registry threaded into every mint (`add`, via `createWorkflow`) AND every hydrate (`open`, via `restoreWorkflow`), so a rehydrated workflow is immediately RUNNABLE — not a dead snapshot mirror. This is PURELY ADDITIVE alongside direct `WorkflowStoreInterface` use and `restoreWorkflow` (both remain valid, unchanged) — a caller now has a third, higher-level option.

| Class             | Kind  | Role                                                                                                                                                  |
| ----------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowManager` | class | The store-backed registry of live workflows — insertion-ordered `add` / `workflow` / `workflows` / `count` / `remove` / `clear` PLUS `open` / `save`. |

### Errors

| API               | Kind     | Summary                                                                                                                           |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowError`   | class    | Carries a `WorkflowErrorCode` (`TRANSITION` / `RESTORE` / `DEPTH` / `TOOL` / `MUTATION`) + an optional `context` naming the node. |
| `isWorkflowError` | function | Narrow an unknown caught value to a `WorkflowError`.                                                                              |

### Helpers & guards

Pure, side-effect-free, exhaustively unit-tested (AGENTS §4.3 / §14). The status derivations encode the §10 / §14 truth-table logic; the lineage / snapshot builders seed the entity tree.

| API                         | Kind     | Behavior                                                                                                                                     |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `isWorkflowSnapshot`        | function | Narrow an `unknown` to a `WorkflowSnapshot` by shape — the §14 boundary guard `DatabaseWorkflowStore` uses to read back its JSON column.     |
| `isTerminalStatus`          | function | Whether a `LifecycleStatus` is terminal — the ONE check across all three tiers (`completed` / `failed` / `skipped` / `stopped`).             |
| `derivePhaseStatus`         | function | Derive a `PhaseStatus` from its tasks' statuses (order-insensitive; most-severe terminal wins; `bail`-agnostic).                             |
| `deriveWorkflowStatus`      | function | Derive a `WorkflowStatus` from its phases' statuses UNDER `bail` (`failed` reachable only when `bail: true`).                                |
| `deriveBoundary`            | function | Derive the PENDING SUFFIX boundary from a positional statuses list — the index of the first `pending` entry (or `length` if none).           |
| `canTransitionTask`         | function | Whether the live task state machine may move from one `TaskStatus` to another (reads `TASK_TRANSITIONS`).                                    |
| `success`                   | function | Box a value as a `Success` — the graceful outcome half of a `Result` (`{ success: true, value }`).                                           |
| `failure`                   | function | Box an error as a `Failure` — the graceful outcome half of a `Result` (`{ success: false, error }`).                                         |
| `findFailure`               | function | Find the first `TaskResult` in a positional list whose boxed outcome is a `Failure`, or `undefined` if none.                                 |
| `buildWorkflowContext`      | function | Build a `WorkflowContext` (the identity every level inherits) from a node's `id` / `name` / optional `description`.                          |
| `buildPhaseContext`         | function | Build a `PhaseContext` (own identity + the workflow back-reference) from the parent context + a phase node.                                  |
| `buildTaskContext`          | function | Build a `TaskContext` (own identity + the phase back-reference) from the parent phase context + a task node.                                 |
| `definitionToSnapshot`      | function | Convert a `WorkflowDefinition` into an INITIAL all-`pending` `WorkflowSnapshot` — the unified construction path.                             |
| `phaseDefinitionToSnapshot` | function | Convert one `PhaseDefinition` into an initial all-`pending` `PhaseSnapshot` (the per-phase step).                                            |
| `taskDefinitionToSnapshot`  | function | Convert one `TaskDefinition` into an initial `pending` `TaskSnapshot` (the per-task leaf step — no result, empty metadata).                  |
| `collectResults`            | function | Flatten per-phase `TaskResult` lists into one positional list — the workflow tier of the result tree.                                        |
| `parkSignal`                | function | Park until `signal` aborts — a promise that resolves on the abort event, never rejects (a one-shot listener, self-removing).                 |
| `insertEntry`               | function | Insert a `[key, value]` entry at `index` in a readonly entries array — the pure splice step behind an insertion-ordered registry's `add`.    |
| `moveEntry`                 | function | Reposition the entry keyed `key` to a new index in a readonly entries array — the pure remove-then-reinsert step behind a registry's `move`. |

### Shapes

The shape VALUES `createWorkflowContract` compiles into the four lockstep outputs. They agree with the hand-written definition interfaces (the source of truth, AGENTS §14); a round-trip parity test (`generate → is → parse`) guards against drift.

| API                | Kind  | Summary                                                                                                           |
| ------------------ | ----- | ----------------------------------------------------------------------------------------------------------------- |
| `taskShape`        | const | The `TaskDefinition` shape — identity + an optional `run` string behavior reference.                              |
| `phaseShape`       | const | The `PhaseDefinition` shape — identity + ordered `taskShape` tasks + an optional positive-integer `concurrency`.  |
| `workflowShape`    | const | The `WorkflowDefinition` shape (the contract root) — identity + ordered `phaseShape` phases + an optional `bail`. |
| `taskUpdateShape`  | const | The `TaskUpdate` shape — a partial edit to a `pending` task's `name` / `description`, both optional.              |
| `phaseUpdateShape` | const | The `PhaseUpdate` shape — a partial edit to a `pending` phase's `name` / `description` / `concurrency` / `bail`.  |

### Constants

| Constant                    | Kind  | Value                                                                                                              |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| `DEFAULT_BAIL`              | const | The default `bail` — `false` (graceful: continue on a leaf failure).                                               |
| `TASK_STATUSES`             | const | Every `TaskStatus`, frozen (`pending` → `running` → the four terminals).                                           |
| `PHASE_STATUSES`            | const | Every `PhaseStatus`, frozen.                                                                                       |
| `WORKFLOW_STATUSES`         | const | Every `WorkflowStatus`, frozen.                                                                                    |
| `TERMINAL_TASK_STATUSES`    | const | The terminal `TaskStatus` values, frozen (`completed` / `failed` / `skipped` / `stopped`).                         |
| `TASK_TRANSITIONS`          | const | The legal `TaskStatus` transition graph — each status mapped to those it may move to directly, frozen.             |
| `DEFAULT_PHASE_CONCURRENCY` | const | The per-phase task concurrency when a `PhaseDefinition` omits `concurrency` — a large cap (effectively unbounded). |

### Types

| Type                       | Kind      | Shape                                                                                                                                                                                                                                                             |
| -------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskDefinition`           | interface | `{ id, name, description?, run?, retries?, timeout? }` — one task's serializable definition (`run` = an optional plain behavior-name string; `retries` / `timeout` are per-task reliability overrides).                                                           |
| `PhaseDefinition`          | interface | `{ id, name, description?, tasks, concurrency?, bail? }` — ordered tasks (concurrent) + an optional throttle + an optional per-phase `bail` override.                                                                                                             |
| `WorkflowDefinition`       | interface | `{ id, name, description?, phases, bail? }` — the root a UI/LLM authors and the contract validates.                                                                                                                                                               |
| `WorkflowContext`          | interface | `{ id, name, description? }` — the ambient identity every level inherits (the context chain's root).                                                                                                                                                              |
| `PhaseContext`             | interface | `WorkflowContext` + `{ workflow }` — a phase's identity plus the back-reference UP the tree.                                                                                                                                                                      |
| `TaskContext`              | interface | `WorkflowContext` + `{ phase }` — a task's identity plus its full lineage (workflow → phase → task).                                                                                                                                                              |
| `WorkflowInput`            | type      | `Partial<WorkflowContext>` — the minimal data to create a workflow context.                                                                                                                                                                                       |
| `PhaseInput`               | type      | `Partial<PhaseContext>` — the minimal data to create a phase context.                                                                                                                                                                                             |
| `TaskInput`                | interface | `Partial<TaskContext>` + `{ metadata? }` — plus the open consumer bag stored + snapshotted, never interpreted.                                                                                                                                                    |
| `TaskUpdate`               | interface | `{ name?, description? }` — a declarative partial edit to a `pending` task, accepted by `TaskInterface.patch` / `TaskManagerInterface.update`.                                                                                                                    |
| `PhaseUpdate`              | interface | `{ name?, description?, concurrency?, bail? }` — a declarative partial edit to a `pending` phase, accepted by `PhaseInterface.patch` / `PhaseManagerInterface.update`.                                                                                            |
| `WorkflowErrorCode`        | type      | `'TRANSITION' \| 'RESTORE' \| 'DEPTH' \| 'TOOL' \| 'MUTATION'` — the machine-readable code of a `WorkflowError` (`MUTATION` = a refused structural/patch edit).                                                                                                   |
| `LifecycleStatus`          | type      | `'pending' \| 'running' \| 'completed' \| 'failed' \| 'skipped' \| 'stopped'` — the ONE vocabulary the three tiers alias.                                                                                                                                         |
| `TaskStatus`               | type      | A semantic tier of `LifecycleStatus` — a task's lifecycle status.                                                                                                                                                                                                 |
| `PhaseStatus`              | type      | A semantic tier of `LifecycleStatus` — a phase's status, derived from its tasks.                                                                                                                                                                                  |
| `WorkflowStatus`           | type      | A semantic tier of `LifecycleStatus` — a workflow's status, derived from its phases under `bail`.                                                                                                                                                                 |
| `PhaseDerivation`          | interface | `{ status, bail }` — one phase's contribution to the workflow-status derivation (its status + the EFFECTIVE bail it ran under); the input shape of `deriveWorkflowStatus`.                                                                                        |
| `TaskResult`               | interface | `{ task, phase, workflow, status, result?, timestamp }` — lineage + the boxed `Result` outcome (present for `completed` / `failed`).                                                                                                                              |
| `TaskSnapshot`             | interface | `{ id, name, description?, status, result?, metadata, run?, retries?, timeout? }` — the leaf of the snapshot tree (pure JSON); `run`/`retries`/`timeout` PERSIST like a `PhaseSnapshot`'s `bail`/`concurrency`, re-resolved on restore.                           |
| `PhaseSnapshot`            | interface | `{ id, name, description?, status, override?, bail, concurrency?, tasks }` — `bail` + `concurrency` are the effective per-phase policy/throttle (both persisted); `override` present only when a whole-phase `skip` / `stop` forced it.                           |
| `WorkflowSnapshot`         | interface | `{ id, name, description?, status, override?, bail, phases, created, updated }` — the COMPLETE self-contained durable payload.                                                                                                                                    |
| `WorkflowStoreInterface`   | interface | The durable persistence seam — async `get` / `set` / `delete` over a `WorkflowSnapshot` by id (the `SessionStore` driver-swap pattern; no TTL).                                                                                                                   |
| `WorkflowSnapshotRow`      | interface | `{ id, snapshot }` — one row of the `DatabaseWorkflowStore` table, the snapshot held as one opaque JSON column (`unknown`, narrowed on `get`); keeps the row flat to dodge TS2589.                                                                                |
| `WorkflowEventMap`         | type      | The workflow's §13 push surface — `start(id)` · `complete()` · `fail(result)` · `stop()`.                                                                                                                                                                         |
| `PhaseEventMap`            | type      | The phase's §13 push surface — `start(id)` · `complete()` · `fail(result)` · `stop()`.                                                                                                                                                                            |
| `TaskEventMap`             | type      | The task's §13 push surface — `start(id)` · `complete(result)` · `fail(result)` · `skip()` · `stop()`.                                                                                                                                                            |
| `WorkflowHooks`            | type      | `EmitterHooks<WorkflowEventMap>` — initial workflow listeners (the reserved `on` option).                                                                                                                                                                         |
| `PhaseHooks`               | type      | `EmitterHooks<PhaseEventMap>` — initial phase listeners.                                                                                                                                                                                                          |
| `TaskHooks`                | type      | `EmitterHooks<TaskEventMap>` — initial task listeners.                                                                                                                                                                                                            |
| `TaskOptions`              | interface | `{ on?, error?, metadata? }` — the live task's construction bag (§8 / §13).                                                                                                                                                                                       |
| `PhaseOptions`             | interface | `{ on?, error?, tasks? }` — the live phase's bag; `tasks` keys per-task `TaskOptions` by id.                                                                                                                                                                      |
| `WorkflowOptions`          | interface | `{ on?, bail?, error?, phases?, functions? }` — the live workflow's bag; `phases` keys per-phase `PhaseOptions` by id; `functions` is the `function`-task behavior registry each live task's `run` name resolves against ONCE at construction into its `handler`. |
| `WorkflowInterface`        | interface | The live DERIVED root entity — `emitter` / `status` / `bail` / `phases` / `paused` / `destroyed` / `signal` + the methods (see [Methods](#workflowinterface)).                                                                                                    |
| `PhaseInterface`           | interface | The live DERIVED phase entity — `emitter` / `status` / `bail` / `concurrency` / `paused` / `tasks` + the methods (see [Methods](#phaseinterface)).                                                                                                                |
| `TaskInterface`            | interface | The live leaf state-machine entity — `emitter` / `status` / `result` / `run` / `handler` / `retries` / `timeout` + the methods (see [Methods](#taskinterface)).                                                                                                   |
| `TaskManagerInterface`     | interface | The lean tasks manager — `count` + `append` / `add` / `remove` / `move` / `update` / `task` / `tasks`.                                                                                                                                                            |
| `PhaseManagerInterface`    | interface | The lean phases manager — `count` + `append` / `add` / `remove` / `move` / `update` / `phase` / `phases`.                                                                                                                                                         |
| `WorkflowFunction`         | type      | `(controller: TaskControllerInterface) => Promise<unknown> \| unknown` — the behavior a `function`-form task runs.                                                                                                                                                |
| `WorkflowFunctions`        | type      | `Readonly<Record<string, WorkflowFunction>>` — the `function`-task registry (a name absent ⇒ auto-complete).                                                                                                                                                      |
| `TaskControllerInterface`  | interface | The per-task handle — `signal` / `aborted` / `input` / `task` + `results()` (read-up the result tree).                                                                                                                                                            |
| `WorkflowResult`           | interface | `{ workflow, status, results }` — the settled live workflow + its terminal status + the flattened result tree.                                                                                                                                                    |
| `WorkflowRunOptions`       | type      | `WorkflowOptions` + `{ signal?, timeout?, budget? }` — construction options PLUS the per-run bounds; the engine's depth/cycle bookkeeping lives in the adapter factories' own closures (in `@orkestrel/tool`), not here.                                          |
| `WorkflowRunnerOptions`    | interface | `{ scheduler? }` — the PURE engine's only option (pacing); no `functions` / `tools` / `agents` registry — a task resolves its own `handler` at construction.                                                                                                      |
| `WorkflowRunnerInterface`  | interface | The PURE-engine orchestrator — `execute(definition, options?)` builds + drives a live tree to a `WorkflowResult`; `execute(workflow, options?)` drives an already-built, caller-owned live tree instead.                                                          |
| `WorkflowManagerOptions`   | interface | `{ store?, functions? }` — the optional durable `WorkflowStoreInterface` seam + the `WorkflowFunctions` registry every minted/hydrated workflow resolves its tasks' handlers against.                                                                             |
| `WorkflowManagerInterface` | interface | The store-backed registry — `count` + `workflow` / `workflows` + the methods (see [Methods](#workflowmanagerinterface)); NO `active` / `switch` (unlike its `ConversationManager` / `WorkspaceManager` twins).                                                    |
| `SchedulerPriority`        | type      | `'user' \| 'normal' \| 'background'` — a relative urgency hint (uniform in the default; backends honour it).                                                                                                                                                      |
| `SchedulerOptions`         | interface | `{ priority?: SchedulerPriority; signal?: AbortSignal }` — options for a single `yield` / `delay`.                                                                                                                                                                |
| `SchedulerInterface`       | interface | The `yield` / `delay` cooperative-yield methods.                                                                                                                                                                                                                  |
| `ControllerInterface`      | interface | The per-unit handle a runner handler receives — `id` / `input` / `signal` / `aborted` data members + `wait` / `spawn` / `abort` methods.                                                                                                                          |
| `RunnerHandler`            | type      | `(controller) => Promise<TResult> \| TResult` — runs one unit's work against its `Controller`.                                                                                                                                                                    |
| `RunnerOptions`            | interface | `createRunner` options — `handler` + `concurrency?` / `retries?` / `timeout?` / `entries?` / `on?` / `error?`.                                                                                                                                                    |
| `RunnerEntryOptions`       | interface | The per-entry reliability overrides for one unit — `{ retries?, timeout? }`, resolved from its input via `entries`.                                                                                                                                               |
| `RunnerInterface`          | interface | `emitter` / `active` / `stopped` / `paused` data members + `execute` / `spawn` / `abort` / `pause` / `resume` / `stop` / `destroy` methods.                                                                                                                       |
| `RunnerEventMap`           | type      | The `Runner`'s observable events — `start` / `unit` / `spawn` / `settle` / `fail` / `finish` / `abort`.                                                                                                                                                           |
| `RunnerUnit`               | interface | One tracked unit's queue payload — `id` (keys its order + value) + `input` (the handler's work).                                                                                                                                                                  |
| `UnitOutcome`              | type      | One unit's settled outcome — `{ ok: true; value }` \| `{ ok: false; error }`, so `undefined` is still a success.                                                                                                                                                  |
| `DeferredInterface`        | interface | `{ promise, resolve, reject }` — a promise whose settlement is driven externally, e.g. for deterministic async test scenarios.                                                                                                                                    |

## Methods

The public methods of each behavioral interface — one table per type, keyed by its backticked name, every call-signature member listed. Its `readonly` data members stay in the Surface rows above (`emitter` is the typed [§13](emitter.md) push surface — see [Observing the live tree](#observing-the-live-tree); `status` / `result` / `context` / `signal` / `aborted` / `input` / `task` / `count` are read-state). Each entity and substrate class implements its interface exactly, so this doubles as the per-instance method surface (AGENTS §22).

#### `WorkflowInterface`

The live DERIVED root. `status` is the override-or-derived workflow status (read-state, in the Surface row); the methods navigate down (`phase`), collect the result tree (`results`), force a terminal state (`skip` / `stop` / `complete`), pause/resume/park the run (`pause` / `resume` / `wait`), tear it down (`destroy`), mutate its pending-suffix phases (`add` / `remove` / `move` / `update`), and serialize (`snapshot`).

| Method     | Returns                                 | Behavior                                                                                                               |
| ---------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `phase`    | `PhaseInterface \| undefined`           | Look up one live phase by its `id`.                                                                                    |
| `results`  | `readonly TaskResult[]`                 | Every settled task's result across all phases, in positional order.                                                    |
| `skip`     | `void`                                  | FORCE the workflow `skipped` (an override, survives a snapshot).                                                       |
| `stop`     | `void`                                  | FORCE the workflow `stopped` (emits `stop`).                                                                           |
| `complete` | `void`                                  | FORCE the workflow `completed` (emits `complete`) — the runner settles an executed no-op tree.                         |
| `pause`    | `void`                                  | Suspend the workflow (RUNTIME-ONLY, resumable, idempotent); a no-op once terminal or `destroyed`.                      |
| `resume`   | `void`                                  | Continue a paused workflow (idempotent); releases any parked `wait`.                                                   |
| `destroy`  | `void`                                  | Terminal teardown — aborts `signal`, stops every non-terminal phase, forces `stop`, releases waiters; idempotent.      |
| `wait`     | `Promise<void>`                         | Park until not `paused` — promise-parked, resolves immediately when unpaused; NEVER rejects.                           |
| `add`      | `Result<PhaseInterface, WorkflowError>` | MINT a live phase from a `PhaseDefinition` and insert it within the pending suffix; a `MUTATION` failure when refused. |
| `remove`   | `Result<PhaseInterface, WorkflowError>` | Remove the `pending` phase `id` (within the pending suffix); a `MUTATION` failure when refused.                        |
| `move`     | `Result<PhaseInterface, WorkflowError>` | Reposition the `pending` phase `id` to `index`; a `MUTATION` failure when refused.                                     |
| `update`   | `Result<PhaseInterface, WorkflowError>` | Apply a validated `PhaseUpdate` patch to the `pending` phase `id`; a `MUTATION` failure when refused.                  |
| `snapshot` | `WorkflowSnapshot`                      | Serialize the whole live tree to a pure-JSON `WorkflowSnapshot`.                                                       |

#### `PhaseInterface`

The live DERIVED middle tier. `status` is derived from its tasks (override-or-derived).

| Method     | Returns                                | Behavior                                                                                                                                     |
| ---------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `task`     | `TaskInterface \| undefined`           | Look up one live task by its `id`.                                                                                                           |
| `results`  | `readonly TaskResult[]`                | The settled tasks' results, in positional order (the phase tier).                                                                            |
| `skip`     | `void`                                 | FORCE the phase `skipped`.                                                                                                                   |
| `stop`     | `void`                                 | FORCE the phase `stopped` (emits `stop`).                                                                                                    |
| `pause`    | `void`                                 | Suspend the phase (RUNTIME-ONLY, resumable, idempotent); a no-op once terminal.                                                              |
| `resume`   | `void`                                 | Continue a paused phase (idempotent); releases any parked `wait`.                                                                            |
| `wait`     | `Promise<void>`                        | Park until not `paused` — promise-parked, resolves immediately when unpaused; NEVER rejects.                                                 |
| `add`      | `Result<TaskInterface, WorkflowError>` | MINT a live task from a `TaskDefinition` and insert it — `pending` phase: any index; `running` phase: APPEND-ONLY; terminal: always refused. |
| `remove`   | `Result<TaskInterface, WorkflowError>` | Remove the `pending` task `id`; only while this phase is `pending`.                                                                          |
| `move`     | `Result<TaskInterface, WorkflowError>` | Reposition the `pending` task `id` to `index`; only while this phase is `pending`.                                                           |
| `update`   | `Result<TaskInterface, WorkflowError>` | Apply a validated `TaskUpdate` patch to the `pending` task `id`; only while this phase is `pending`.                                         |
| `patch`    | `void`                                 | Apply a validated `PhaseUpdate` to SELF (`name`/`description`/`bail`/`concurrency`); throws `MUTATION` unless `pending`.                     |
| `snapshot` | `PhaseSnapshot`                        | Serialize the phase + its tasks to a `PhaseSnapshot`.                                                                                        |

#### `TaskInterface`

The live leaf state machine — each transition is GUARDED (an illegal move throws a `TRANSITION` `WorkflowError`) and records a `TaskResult` on a terminal outcome.

| Method     | Returns        | Behavior                                                                                           |
| ---------- | -------------- | -------------------------------------------------------------------------------------------------- |
| `start`    | `void`         | `pending → running`; emits `start`, then cascades up.                                              |
| `complete` | `void`         | `running → completed`; boxes the value as a `Success`, emits `complete`.                           |
| `fail`     | `void`         | `running → failed`; boxes the reason as a `Failure`, emits `fail`.                                 |
| `skip`     | `void`         | → `skipped` (intentionally not run); emits `skip`.                                                 |
| `stop`     | `void`         | → `stopped` (ended early); emits `stop`.                                                           |
| `patch`    | `void`         | Apply a validated `TaskUpdate` to SELF (`name`/`description`); throws `MUTATION` unless `pending`. |
| `snapshot` | `TaskSnapshot` | Serialize identity + status + the recorded result + metadata.                                      |

#### `PhaseManagerInterface`

The lean phases manager (AGENTS §9) — `count` is read-state (in the Surface row).

| Method   | Returns                                 | Behavior                                                                                                                        |
| -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `append` | `void`                                  | Add one live phase at the end (throws `MUTATION` on a duplicate id).                                                            |
| `add`    | `Result<PhaseInterface, WorkflowError>` | Insert `phase` at `index` (default end); a `MUTATION` failure on a duplicate id or out-of-bounds index.                         |
| `remove` | `Result<PhaseInterface, WorkflowError>` | Remove the `pending` phase `id`; a `MUTATION` failure when absent or not `pending`.                                             |
| `move`   | `Result<PhaseInterface, WorkflowError>` | Reposition the `pending` phase `id` to `index`; a `MUTATION` failure when absent, not `pending`, or out of bounds.              |
| `update` | `Result<PhaseInterface, WorkflowError>` | Apply a validated `PhaseUpdate` patch to the `pending` phase `id`; a `MUTATION` failure when absent, not `pending`, or invalid. |
| `phase`  | `PhaseInterface \| undefined`           | Look up one phase by `id`.                                                                                                      |
| `phases` | `readonly PhaseInterface[]`             | List the phases in positional order.                                                                                            |

#### `TaskManagerInterface`

The lean tasks manager (AGENTS §9) — `count` is read-state (in the Surface row). Order survives an interior `skip` (a skip is a status change, never a removal).

| Method   | Returns                                | Behavior                                                                                                                      |
| -------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `append` | `void`                                 | Add one live task at the end (throws `MUTATION` on a duplicate id).                                                           |
| `add`    | `Result<TaskInterface, WorkflowError>` | Insert `task` at `index` (default end); a `MUTATION` failure on a duplicate id or out-of-bounds index.                        |
| `remove` | `Result<TaskInterface, WorkflowError>` | Remove the `pending` task `id`; a `MUTATION` failure when absent or not `pending`.                                            |
| `move`   | `Result<TaskInterface, WorkflowError>` | Reposition the `pending` task `id` to `index`; a `MUTATION` failure when absent, not `pending`, or out of bounds.             |
| `update` | `Result<TaskInterface, WorkflowError>` | Apply a validated `TaskUpdate` patch to the `pending` task `id`; a `MUTATION` failure when absent, not `pending`, or invalid. |
| `task`   | `TaskInterface \| undefined`           | Look up one task by `id`.                                                                                                     |
| `tasks`  | `readonly TaskInterface[]`             | List the tasks in positional order.                                                                                           |

#### `WorkflowRunnerInterface`

| Method    | Returns                   | Behavior                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute` | `Promise<WorkflowResult>` | TWO overloads: `execute(definition, options?)` BUILDS the live tree from a definition + drives it; `execute(workflow, options?)` drives an ALREADY-BUILT, caller-owned live `WorkflowInterface` instead (throws `TRANSITION` unless `pending` && `!destroyed`), re-reading its live phases/tasks every iteration so a mid-run `add` is picked up. Both: phases sequential, tasks concurrent. |

#### `WorkflowManagerInterface`

The store-backed registry (§9 + the store standard) — `count` is read-state (in the Surface row). `add` mints from a `WorkflowDefinition` (flowing the manager's `functions` in); `open` / `save` are the optional `store` seam, EXACTLY analogous to `ConversationManagerInterface.open` / `.save`, except `open`'s hydration path ALSO flows `functions` in so the rehydrated workflow is RUNNABLE.

| Method      | Returns                                   | Behavior                                                                                                                                                                    |
| ----------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow`  | `WorkflowInterface \| undefined`          | Look up one registered workflow by `id`.                                                                                                                                    |
| `workflows` | `readonly WorkflowInterface[]`            | List the registered workflows in insertion order.                                                                                                                           |
| `add`       | `WorkflowInterface`                       | MINT a live workflow from a `WorkflowDefinition` (via `createWorkflow`, flowing `functions` in) and register it under `definition.id`; an already-registered id OVERWRITES. |
| `open`      | `Promise<WorkflowInterface \| undefined>` | Resolve a registered workflow directly, else HYDRATE from the optional `store` (via `restoreWorkflow`, flowing `functions` in — RUNNABLE); `undefined` when neither.        |
| `save`      | `Promise<boolean>`                        | Persist a REGISTERED workflow's `snapshot()` to the optional `store`; `false` (no-op) when no store or an unknown id.                                                       |
| `remove`    | `boolean`                                 | Drop one by `id`, or a batch by `readonly string[]` (§9.2, array overload first); `true` when any was removed.                                                              |
| `clear`     | `void`                                    | Empty the registry.                                                                                                                                                         |

#### `TaskControllerInterface`

The per-task handle a `WorkflowFunction` receives. `signal` / `aborted` / `input` / `task` are read-state (in the Surface row).

| Method    | Returns                 | Behavior                                                                         |
| --------- | ----------------------- | -------------------------------------------------------------------------------- |
| `results` | `readonly TaskResult[]` | Every settled task's result across already-finished phases (read-up, read-only). |

#### `SchedulerInterface`

`yield` hands the host a turn (a macrotask, so the host actually runs) and resumes; `delay` resumes after a minimum interval. Both reject with `signal.reason` when an optional `options.signal` aborts.

| Method  | Returns         | Behavior                                                                                                            |
| ------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `yield` | `Promise<void>` | Yield control to the host (a `setTimeout(0)` macrotask, NOT a microtask), then resume. Abort rejects with `reason`. |
| `delay` | `Promise<void>` | Resume after at least `ms` milliseconds. Abort before the deadline rejects with `reason` and clears the timer.      |

#### `RunnerInterface`

`execute` runs the declared units (and their spawns) once and resolves ordered results; `spawn` injects a unit into an in-flight run; `pause` / `resume` / `stop` are the §10 lifecycle verbs (`stop` is a GRACEFUL stop — in-flight finishes, never-dispatched pending entries settle without a fail-fast trip); `abort` / `destroy` remain the hard-cancel verbs. The `active` / `stopped` / `paused` members are Surface rows.

| Method    | Returns                         | Behavior                                                                                                                                                                 |
| --------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `execute` | `Promise<readonly TResult[]>`   | Run all `inputs` and their spawns to completion; resolve results in order (declared first, then spawns). One-shot; fail-fast.                                            |
| `spawn`   | `Promise<TResult> \| undefined` | Inject one more unit into an in-flight `execute` run; returns `undefined` (synchronous, non-throwing) when not started / drained / aborted / stopped / destroyed.        |
| `abort`   | `void`                          | Cancel every in-flight + pending unit (and the backing queue); a running `execute` rejects.                                                                              |
| `pause`   | `void`                          | Suspend dispatch (RUNTIME-ONLY, resumable); in-flight units finish, the next dispatch parks; a no-op when stopped; idempotent.                                           |
| `resume`  | `void`                          | Continue a paused runner; idempotent.                                                                                                                                    |
| `stop`    | `void`                          | GRACEFUL permanent stop — no further dispatch; in-flight units finish; never-dispatched pending units settle WITHOUT tripping fail-fast; `execute` RESOLVES. Idempotent. |
| `destroy` | `void`                          | Tear the runner down — `abort` then stop the backing queue; idempotent.                                                                                                  |

#### `ControllerInterface`

`wait` parks until the unit's signal aborts; `spawn` fans out a sibling unit; `abort` cancels this unit. The `id` / `input` / `signal` / `aborted` members are Surface rows.

| Method  | Returns            | Behavior                                                                                                                   |
| ------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `wait`  | `Promise<void>`    | Park until the unit's `signal` aborts — promise-parked, never a timer; resolves immediately if already aborted.            |
| `spawn` | `Promise<TResult>` | Add a sibling unit to the run through the same queue; returns its result promise. Fire-and-track — do NOT await it inline. |
| `abort` | `void`             | Cancel this unit — fires its `signal` with the optional reason.                                                            |

#### `WorkflowStoreInterface`

The durable persistence seam (W-d) — three async primitives over a `WorkflowSnapshot`, keyed by its own id. BOTH stores implement exactly these — the in-memory `MemoryWorkflowStore` and the driver-pluggable `DatabaseWorkflowStore` (the snapshot one opaque JSON column) — so a durable backend (JSON / SQLite / IndexedDB) swaps in through the same three. There is NO TTL / eviction — a persisted run-state lives until an explicit `delete`.

| Method   | Returns                                  | Behavior                                                           |
| -------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `get`    | `Promise<WorkflowSnapshot \| undefined>` | Resolve the persisted snapshot for `id`, or `undefined` if absent. |
| `set`    | `Promise<void>`                          | Insert or replace under the snapshot's own `id`.                   |
| `delete` | `Promise<void>`                          | Drop by id; an absent id is a no-op (no throw).                    |

## Contract

These invariants hold across `src/core/workflows` ↔ `workflows.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `const` / `class` / `interface` / `type` row in the `## Surface` tables is a real export of the workflows source tree (`src/core/workflows`), and every export appears as a Surface row — exhaustive, both directions (AGENTS §22).

2. **DOC ↔ SOURCE method bijection.** Every behavioral interface's `## Methods` table lists exactly its public methods (call-signature members) — exhaustive, both directions — and each implementing class (`Workflow` / `Phase` / `Task` / `WorkflowRunner` / `TaskController` / `PhaseManager` / `TaskManager` / `Runner` / `Controller`) exposes exactly its interface's methods, no extra public surface (AGENTS §22). The `readonly` data members (`emitter` / `status` / `result` / `context` / `signal` / `aborted` / `input` / `task` / `count` / `id` / `name` / `description` / `bail` / `phases` / `tasks` / `paused` / `destroyed` / `run` / `handler` / `retries` / `timeout` / `concurrency` / `active` / `stopped`) stay in the Surface rows.

3. **Definition is DATA; the runtime is the tree.** A `WorkflowDefinition → PhaseDefinition → TaskDefinition` is pure JSON — behavior referenced BY NAME through a registry, never inline functions — so it round-trips through `createWorkflowContract` (the LLM-tool-args / boundary-validation / restore / test-fixture spine) and persists unchanged. The `Workflow` / `Phase` / `Task` entity classes are the live mirror BUILT from a definition; the definition interfaces are hand-written (the source of truth, AGENTS §14), and the compiled contract's `is` / `parse` / `generate` narrow to them natively (no `as`) — a `generate → is → parse` round-trip parity test guards against drift between the two.

4. **Determinism is fixed by design.** Tasks within a phase run CONCURRENTLY; phases run SEQUENTIALLY. There is no per-task concurrent/sequential toggle and no dependency machinery — a dependency is structural (a later phase), so the same tree always sequences the same way. The per-phase knobs are `concurrency` (an optional resource THROTTLE — max-in-flight; omitted ⇒ `DEFAULT_PHASE_CONCURRENCY`, effectively unbounded) and `bail` (an optional per-phase failure-policy OVERRIDE; omitted ⇒ inherits the workflow `bail`), never a sequencing control; the per-task knobs are `retries` (extra attempts on failure) and `timeout` (per-attempt deadline ms), both reliability overrides threaded to the substrate per unit. The status derivations (`derivePhaseStatus` / `deriveWorkflowStatus`) are therefore order-insensitive set reductions, total (never throw), mirroring the contracts guards' totality (AGENTS §14).

5. **Status is derived from children, per-phase-bail-aware.** A `PhaseStatus` is derived from its tasks' statuses (`bail`-agnostic — a phase surfaces a task failure as `failed` so the policy can decide); a `WorkflowStatus` is derived from its phases' `PhaseDerivation`s (each phase's status paired with the EFFECTIVE `bail` it ran under, `effectiveBail = phase.bail ?? workflow.bail`). A `failed` phase propagates `failed` to the workflow ONLY when ITS effective `bail` is `true` — so a `bail: true` phase HALTS the run even under a graceful (`false`) workflow default, and a `bail: false` phase folds into completion (recorded as data in the result tree) even under a strict (`true`) workflow default. `deriveWorkflowStatus(PhaseDerivation[])` therefore takes the per-phase policy on each phase, not one scalar. The three §10 status tiers (`TaskStatus` / `PhaseStatus` / `WorkflowStatus`) alias ONE `LifecycleStatus` vocabulary, so the single `isTerminalStatus` predicate covers them all.

6. **The leaf is a guarded state machine; the override round-trips.** A `Task`'s transitions read the `TASK_TRANSITIONS` graph via `canTransitionTask` — an illegal move (completing a non-`running` task, starting a settled one) throws a `TRANSITION` `WorkflowError`, so the leaf can never reach an impossible state. A `skip` / `stop` on a DERIVED `Phase` / `Workflow` sets an `#override` that is PERSISTED in the snapshot's own `override` field and restored DIRECTLY (no fragile status-divergence guess); a leaf's terminal status IS its forced marker, so a `TaskSnapshot` needs no `override`.

7. **The result tree is lineage-navigable, three tiers.** A `TaskResult` carries its full lineage (`task` / `phase` / `workflow` contexts) and BOXES the produced outcome in a [`Result`](contract.md): present exactly for `completed` (a `Success`) / `failed` (a `Failure`), absent for `skipped` / `stopped` (terminal without an outcome) and for a non-terminal task. `Phase.results()` is the phase tier; `Workflow.results()` flattens every phase's via `collectResults` (the workflow tier). A `TaskController.results()` reads UP the live tree — every settled task across already-finished phases — so a later phase's `function` task reads an earlier phase's output (the result tree IS the inter-task data-flow map, read-only).

8. **`pause` / `resume` / `wait` are RUNTIME-ONLY at both tiers.** `Workflow.pause` / `Phase.pause` suspend the run; `paused` is NEVER a `LifecycleStatus` and NEVER persisted in a snapshot — a paused node's `status` still reports its ordinary derived value. `wait()` NEVER rejects: it resolves immediately when not paused, and while paused it parks (promise-parked, never a timer) until released. A `Workflow`'s waiter is released by `resume`, `skip`, `stop`, or `destroy`; a `Phase`'s waiter is released by `resume` or this phase's own `skip` / `stop` forcing a terminal status — a permanently-ended node has nothing left to pause for. A driving `WorkflowRunnerInterface.execute` gates at the next phase boundary AND before each task's own pre-dispatch (workflow gate, then phase gate) — an in-flight task body is never suspended mid-flight — each gate RACED against the folded run signal, so an external timeout / abort / destroy unparks a paused run promptly instead of hanging.

9. **`stop` (graceful) vs `destroy` (hard) — two different cancels, at two different tiers.** A `Workflow.stop()` / `Phase.stop()` FORCES a terminal status (an override) — the §10 forced-terminal verb. `Workflow.destroy()` is the STRONGER, TERMINAL teardown: it aborts `signal`, `stop`s every non-terminal live phase (so an engine parked on a phase's own gate unparks and the tree lands coherent), forces the `stop` override on the workflow itself if not already terminal, releases any parked `wait`, and marks `destroyed` — idempotent, and every structural mutator / `pause` / `resume` thereafter rejects or no-ops (never throws for calling `destroy` twice). The substrate `Runner.stop()` is a DIFFERENT, GRACEFUL verb at the execution-substrate tier: no further unit is dispatched, but every already-in-flight unit finishes normally, and a never-dispatched (still-pending) unit is rejected WITHOUT being recorded as a failure (it never trips fail-fast) — `execute()` RESOLVES (never rejects) with whatever settled. A driving `WorkflowRunnerInterface.execute(workflow)` folds `workflow.signal` into its run signal, so `destroy()` aborts in-flight work IMMEDIATELY, while `workflow.stop()` alone lets not-yet-started work skip gracefully and in-flight work finish.

10. **Observation is a pure side-channel (§13).** Each live `Workflow` / `Phase` / `Task` owns a typed `emitter` (`WorkflowEventMap` / `PhaseEventMap` / `TaskEventMap`) firing strictly AFTER each transition — a leaf's OWN event before the cascade re-derives the parents (cause before effect), so an observer sees the leaf changed before the phase / workflow does. The emitter isolates a listener throw and routes it to its OWN `error` handler (the `error` option, surfaced as `(error, event)`, NOT a domain event) — so a buggy observer can NEVER corrupt a transition or the cascade. The `WorkflowRunner` and `TaskController` are EVENT-FREE by design (the runner drives the entities' own emitters; the child managers `PhaseManager` / `TaskManager` are purely structural and observe nothing).

11. **Running-phase append-only; every structural edit is gated by the pending-suffix boundary.** `Phase.add` (and its manager delegate) accepts any `index` while the phase is `pending`, but ONLY a pure append (`index` omitted or `=== tasks.count`) while `running` — a live runner subscribed to the phase's own `add` event picks the new task up for same-run execution, and the derived-status model guarantees the phase cannot reach a terminal status while that newly-accepted `pending` task is still outstanding; a terminal phase always refuses. `remove` / `move` / `update` on a phase's tasks are allowed ONLY while the phase itself is `pending`. At the workflow tier, `Workflow.add` / `remove` / `move` / `update` on its phases are refused outright while the workflow is terminal or `destroyed`; otherwise every target index (and, for `add`, the effective insertion index `index ?? phases.count`) must fall within the PENDING SUFFIX — the contiguous trailing run of `pending` phases (phases run sequentially, so every already-started phase forms a contiguous leading prefix) — whose boundary is `deriveBoundary`. Every refusal (at either tier) is a graceful `Result` `MUTATION` failure, never a throw, and fires no `add` / `remove` / `move` / `update` event.

12. **The runner COMPOSES, never re-implements — a PURE engine.** `WorkflowRunner.execute` builds the live tree from the definition (the SINGLE source of truth — each task's `run` string / `retries` / `timeout` and per-phase `concurrency` / `bail` come from the same definition the tree is built from, so the executed tree can never drift) and drives it: phases SEQUENTIALLY (a plain await loop), each phase's tasks CONCURRENTLY through ONE substrate `createRunner` per phase (`concurrency` = the phase's throttle). It writes ZERO concurrency / retry / abort logic AND carries NO `functions` / `tools` / `agents` registry of its own — `#runPhase` reads the EFFECTIVE per-phase bail (`effectiveBail = phase.bail ?? workflow.bail`) and maps it onto that substrate Runner's fail-fast (`true`) vs settle-all (`false`), AND threads each task's `retries` / `timeout` through the Runner's per-entry `entries` resolver (the substrate's per-unit overrides); the run-level abort / [timeout](timeout.md) / [budget](budget.md) fold through `AbortSignal.any` (exactly as the agent runtime folds its bounds); pacing is the shipped scheduler. The runner DRIVES the live entity (`start` → `complete` / `fail` / `skip`), invoking each task's OWN already-resolved `handler` — never re-implementing status, never performing a by-name registry lookup itself. A run-level cancel halts the loop, `skip`s the remaining tasks / phases, and force-`stop`s the workflow (settles `stopped`); `execute` RESOLVES on a cancel (never rejects) — the partial outcome is read from the returned `WorkflowResult`. The three cancellation causes folded onto a task's signal are TOLD APART (`#runTask`'s `#skipping` discriminator, the runner `Controller`'s unit-`aborted` vs its attempt `signal`): a per-attempt `timeout` is a RETRYABLE FAILURE — a non-final timed-out attempt drives the substrate retry leaving the leaf `running` (a later attempt can still `complete`), a final one `fail`s the leaf — so a timed-out task ends `failed`, never `skipped`; whereas a sibling fail-fast under `bail` and a run-level cancel (abort / run-`timeout` / budget) STILL `skip` the in-flight leaf.

13. **A task's behavior is a plain string, resolved ONCE into a `handler`; the engine dispatches by invoking it.** A live `TaskInterface`'s `run` (an optional plain name string, mirroring `TaskDefinition.run` / `TaskSnapshot.run`) is resolved AT CONSTRUCTION — on a fresh build, a restore (when `functions` is supplied), or a live `add` mint, all via the SAME path — against the workflow-level `WorkflowOptions.functions` registry into the task's own `handler: WorkflowFunction | undefined`. `#runTask` then simply invokes `task.handler` directly: `undefined` (an omitted `run`, or a `run` name absent from `functions`) AUTO-COMPLETES (the no-handler rule) — the engine performs no by-name lookup of its own. Wiring a `function`-form task to a registered TOOL or a live AGENT is an OPT-IN adapter concern that lives in the `@orkestrel/tool` package (a `createToolFunction` / `createAgentFunction` composed into the caller's OWN `functions` registry like any other behavior); the engine itself never imports a tool/agent package, and `WorkflowError`'s `TOOL` / `DEPTH` codes are public type surface those adapters construct.

14. **`WorkflowError`'s `TOOL` / `DEPTH` codes are public type surface for the `@orkestrel/tool` package's adapters.** `TOOL` is thrown by a malformed authored-args blob at a workflow-authoring tool boundary; `DEPTH` is thrown by an over-deep or cyclic nested `agent` → workflow-tool → workflow dispatch. Both codes are constructed OUTSIDE this package (by `@orkestrel/tool`'s adapter factories, which depend on `@src/core` for `WorkflowError` / `createWorkflowContract` / `WorkflowRunnerInterface`), never by anything in `src/core/workflows` itself — this package only defines and documents the codes; that package raises them.

15. **`WorkflowRunnerInterface.execute(workflow)` requires a fresh, non-destroyed tree.** The entity-driving overload requires `workflow.status === 'pending'` AND `!workflow.destroyed` — any other state (already started, already terminal, or torn down) is a programmer-timing error, so it THROWS a `TRANSITION` `WorkflowError` synchronously rather than silently no-opping or building a second tree. Once accepted, the phase loop RE-READS the live `workflow.phases.phases()` (and each phase's live `tasks`) EVERY iteration — a cursor over the live managers, not a one-time snapshot — so a caller's `workflow.add` mid-run is picked up and actually dispatched onto the SAME substrate runner (the same `retries` / `timeout` / signal path as a build-time task), and the post-settle sweep skips any task still `pending` when the phase loop catches up. The `definition`-building overload has its own programmer-error boundary (AGENTS §12 exception to the resolves-never-rejects contract): a PATHOLOGICAL `definition` — e.g. a duplicate phase or task `id` — THROWS SYNCHRONOUSLY while building the live tree (`PhaseManager.append` / `TaskManager.append`'s own duplicate-id `MUTATION` throw), before any phase runs and before the returned `Promise` is created.

16. **A run-level `timeout` / `budget` keeps counting while paused.** `pause` suspends DISPATCH, not the clock — an external `WorkflowRunOptions.timeout` deadline or `budget` ceiling continues to elapse / accumulate while a run sits paused, so a long pause can still fire the bound and unpark the run into a cancelled (`stopped`) outcome; pausing is not a way to freeze a run's external bounds.

17. **Cross-environment `setTimeout` default (scheduler).** `Scheduler` uses ONLY `setTimeout` / `clearTimeout` — universally available in browser and Node — so the default runs unchanged in either. It deliberately avoids env-specific fast paths (`setImmediate`, `scheduler.yield`, `requestAnimationFrame`, `node:timers/promises`, `MessageChannel`); those belong to the environment backends.

18. **`yield` is a macrotask host-turn, not a microtask.** `yield()` waits on a zero-delay `setTimeout`, not `queueMicrotask`. A microtask drains before the host regains control, so it would only defer within the current task — it would NOT let pending I/O, timers, or rendering run. A macrotask is the correct cross-environment "give the host a turn", so a microtask queued after a `yield()` call resolves before the yield does.

19. **Abort-aware, with full cleanup.** A pending `yield` / `delay` rejects with `signal.reason` (the standard `AbortSignal` convention) when its `options.signal` aborts. An already-aborted signal rejects immediately WITHOUT arming a timer. Either settle path — the timer firing or the signal aborting — clears the timer and removes the abort listener: no leaked timer, no leaked listener, and no double-settle.

20. **Priority accepted but uniform.** `options.priority` is part of the contract, but a `setTimeout`-based default cannot act on urgency, so it treats every priority the same. It is accepted without error and does not change behavior; environment backends honour it.

21. **Event-free (for now).** The scheduler primitive is pure and functional: no Emitter, no `EventMap`, no `on` hook. Observability is a separate deferred pass, so the surface above stays minimal.

22. **Environment backends honour priority and the native primitive; abort semantics are identical.** Each backend (`NodeScheduler` over `setImmediate`; `BrowserScheduler` over `scheduler.postTask`, `FrameScheduler` over `requestAnimationFrame`, `IdleScheduler` over `requestIdleCallback`) is a standalone `SchedulerInterface` that changes only the `yield` primitive — `delay(ms)` stays a real `setTimeout` — and preserves the contract's abort discipline byte-for-byte: reject with `signal.reason` verbatim, no arming when pre-aborted, full handle + listener cleanup on either settle path, settle-once. Native APIs are feature-detected through guards (`isRecord` / `isFunction`), never an `as` (AGENTS §14), with a real-macrotask fallback where absent. `NodeScheduler` does **not** delegate to `node:timers/promises` (it would replace `signal.reason` with a Node `AbortError`); the timer is hand-rolled. `BrowserScheduler` honours `priority` via `postTask`'s priority levels; the others accept `priority` as a documented no-op.

23. **DOC ↔ SOURCE method bijection (scheduler).** The `## Methods` table lists exactly `SchedulerInterface`'s public methods — exhaustive, both directions — and `Scheduler` plus every backend (`NodeScheduler` / `BrowserScheduler` / `FrameScheduler` / `IdleScheduler`) exposes the same public methods, no more (AGENTS §22).

24. **Snapshot is the durable payload — including per-task behavior config.** `Workflow.snapshot()` serializes the whole live tree to a `WorkflowSnapshot` — pure JSON (structure + each node's status + recorded results + the `#override` + positional order + the `bail` policy + creation/update stamps). It is COMPLETE and SELF-CONTAINED: it persists `bail` at BOTH tiers — the workflow default AND each `PhaseSnapshot`'s effective per-phase `bail` (REQUIRED, `phase.bail ?? workflow.bail`) — so `restoreWorkflow` re-derives status IDENTICALLY (per-phase-bail-aware) without a silent default; each `PhaseSnapshot` also persists `concurrency` (like `bail`, mirroring `PhaseDefinition.concurrency`), so a restore reinstates the same per-phase throttle. `restoreWorkflow` rebuilds an equivalent live tree (same status at every node, same recorded results, same positional order — an interior `skip` / `remove` survives); a structurally invalid snapshot (a status / override outside the lifecycle vocabulary, or a non-boolean `bail` at the workflow tier OR on any phase) is rejected loudly by `assertSnapshot` with a `RESTORE` `WorkflowError`, naming the offending node (the boundary-narrowing guard, AGENTS §14). Per-task `run` / `retries` / `timeout` also PERSIST on the `TaskSnapshot` — like `PhaseSnapshot.bail` / `.concurrency` — so a restore can RE-RESOLVE the same behavior reference and reliability overrides once paired with a `WorkflowOptions.functions` registry; `restoreWorkflow(snapshot, { functions })` therefore RESUMES REAL WORK (a restored task's `handler` is resolved fresh against `functions`), while a bare `restoreWorkflow(snapshot)` (no `functions`) is DECLARATIVE REPLAY — every restored task carries `run` but `handler: undefined`, so it AUTO-COMPLETES when dispatched (the existing no-handler rule). A `pause` / `destroyed` flag is runtime-only at both the workflow and phase tiers, never a `LifecycleStatus`, never snapshotted.

25. **The durable store is a DUAL-store convention.** A `WorkflowStoreInterface` persists the pure-JSON `WorkflowSnapshot` keyed by its own id through two interchangeable backends under `workflows/stores/` — the `QueueStore` / `SessionStore` pattern. `MemoryWorkflowStore` (`createMemoryWorkflowStore`) is the zero-plumbing DEFAULT: a process-lifetime `Map`, no encoding (the snapshot is already pure JSON). `DatabaseWorkflowStore` (`createDatabaseWorkflowStore`) is the opt-in, driver-pluggable twin over a `databases` table — it stores the snapshot as ONE OPAQUE JSON column (a `WorkflowSnapshotRow` `{ id; snapshot }`, the `snapshot` a `rawShape` blob — exactly as `DatabaseQueueStore` stores its `input`). Storing the snapshot whole is lossless (it is COMPLETE and self-contained) AND keeps the row type FLAT — a structured multi-column snapshot table would force the contract to `Infer` the deeply-nested snapshot shape (workflow → phases → tasks → results) and trip TS2589; the opaque column sidesteps it, reading back as `unknown` and narrowed to a `WorkflowSnapshot` on `get` by `isWorkflowSnapshot` (the AGENTS §14 boundary narrow — a total guard, never throwing). The Database store's driver DEFAULTS to memory (`createMemoryDriver()`), so it ALSO works in memory out of the box; you opt into durability by passing a JSON / SQLite / IndexedDB driver, and it swaps in behind the SAME three-method interface WITHOUT touching the engine or the entity tree. Restore stays the shipped `restoreWorkflow` (which applies the DEEPER `assertSnapshot` lifecycle-vocabulary gate — complementary to the shallow `isWorkflowSnapshot` shape guard).

What ships is **W-a → W-d**: the definition contract + the full type surface + the derivation helpers (W-a), the live entity tree + the result tree + snapshot/restore (W-b), the PURE `WorkflowRunner` engine + the `run`-string / `handler` model (W-c), and the durable `WorkflowStore` (W-d — `WorkflowStoreInterface` + BOTH the in-memory `MemoryWorkflowStore` / `createMemoryWorkflowStore` AND the driver-pluggable `DatabaseWorkflowStore` / `createDatabaseWorkflowStore`, persisting the `WorkflowSnapshot` by id; the `QueueStore` / `SessionStore` driver-swap pattern, so a JSON / SQLite / IndexedDB backend swaps in through the same interface without touching the engine). The tool/agent authoring adapters + the depth/cycle-bounded agent-native recursion (formerly W-c2) live in the separate `@orkestrel/tool` package, which depends on this one. Deliberately **not** part of this surface yet, by the "build only what earns its keep" discipline: a persistent server/browser driver wired in by default (the durable JSON / SQLite / IndexedDB driver lands with its environment — `DatabaseWorkflowStore` already takes any of them), `resource` (Pool / Worker) task adapters, and a top-level `WorkflowManager` registry + child-manager batch overloads. Those are additive — everything above is unchanged.

## Patterns

These patterns follow the layered arc — author, validate, and run a definition; then control a live run; then the execution substrate the engine composes; then the consolidated practices.

### Authoring a definition (pure JSON)

```ts
import type { WorkflowDefinition } from '@orkestrel/workflow'

// Behavior is referenced BY NAME — never an inline function. A UI builds this, an LLM emits
// it, persistence stores it; it round-trips through createWorkflowContract.
const definition: WorkflowDefinition = {
	id: 'ingest',
	name: 'Ingest',
	bail: false, // the default — graceful; omit it for the same effect
	phases: [
		{
			id: 'fetch',
			name: 'Fetch',
			concurrency: 4, // an optional resource throttle (max in flight); omit ⇒ unbounded
			tasks: [
				{ id: 'a', name: 'Fetch A', run: 'fetch' },
				{ id: 'b', name: 'Fetch B', run: 'fetch' },
			],
		},
		// `summarize` is placed in a LATER phase, so the fetch results are ready when it runs —
		// the phase boundary is the only dependency edge the model has.
		{
			id: 'reduce',
			name: 'Reduce',
			tasks: [{ id: 's', name: 'Summarize', run: 'summarizer' }],
		},
	],
}
```

### Validating + seeding with the contract

```ts
import { createWorkflowContract } from '@orkestrel/workflow'

const contract = createWorkflowContract()
contract.is(definition) // true — a total guard (malformed input ⇒ false, never throws)
contract.parse({ id: '', phases: [] }) // undefined — an empty id fails the refinement
contract.generate() // a deterministic valid WorkflowDefinition (seed a RandomFunction for reproducibility)
contract.schema // the emitted JSON Schema for the full definition
```

### Running a workflow

```ts
import { createWorkflowRunner } from '@orkestrel/workflow'

const runner = createWorkflowRunner() // a PURE engine — no registries of its own

const result = await runner.execute(definition, {
	timeout: 30_000,
	functions: {
		// A function task receives a TaskController — its signal, input, lineage, and read-up results.
		fetch: async (controller) => {
			if (controller.aborted) return // race long work against controller.signal
			return `fetched ${controller.task.id}`
		},
		// OPT-IN: run a registered tool or a live agent through an `@orkestrel/tool` adapter
		// (`createToolFunction` / `createAgentFunction`), composed into this SAME registry.
		publish: async () => 'published',
	},
})
result.status // 'completed' (graceful) — even if a leaf failed
result.workflow.results() // every settled task's TaskResult, lineage-navigable
```

`execute` is single-source — it builds the live tree from `definition` itself and returns it in `result.workflow`. Each task's `run` string is resolved ONCE at construction against `options.functions` into its `handler`; a name omitted or absent from `functions` makes that task auto-complete (no handler).

### The `bail` policy — graceful vs halt

```ts
// bail: false (default) — failures are DATA. Every phase runs to the end; the workflow completes.
const graceful = await runner.execute(definition) // a failed leaf is recorded; status === 'completed'

// bail: true — the database-transaction halt. The first failure aborts in-flight siblings
// (their controller.signal fires) AND skips the remaining tasks / phases; status === 'failed'.
const transactional = await runner.execute(definition, { bail: true })
```

A `bail` override on `execute` wins over the definition's `bail` (which wins over `DEFAULT_BAIL`). Under `bail: true`, a mid-flight sibling sees its `controller.signal` fire and should stop promptly.

A phase may OVERRIDE the workflow policy per phase (`effectiveBail = phase.bail ?? workflow.bail`) — a strict phase halts even under a graceful workflow, and a graceful phase settles-all even under a strict one:

```ts
const definition: WorkflowDefinition = {
	id: 'pipeline',
	name: 'Pipeline',
	bail: false, // graceful by default…
	phases: [
		// …but THIS phase is transactional: a failure here HALTS the run (skips the rest).
		{
			id: 'migrate',
			name: 'Migrate',
			bail: true,
			tasks: [/* … */],
		},
		{
			id: 'notify',
			name: 'Notify',
			tasks: [/* … */],
		}, // inherits the workflow bail (false)
	],
}
```

A task may declare per-task reliability — extra attempts on failure and a per-attempt deadline (both override the phase Runner's defaults and PERSIST in the `TaskSnapshot`, like a phase's `bail` / `concurrency`):

```ts
{ id: 't', name: 'T', run: 'fetch', retries: 3, timeout: 5000 }
```

A per-attempt `timeout` is a RETRYABLE FAILURE of that attempt, NOT a skip: when an attempt exhausts its deadline the runner RETRIES it while `retries` remain (a non-final timed-out attempt leaves the leaf `running` and a later attempt can still recover to `completed`), and only the FINAL attempt's timeout `fail`s the leaf — so a timed-out task ends `failed` (visible to `bail` and `deriveWorkflowStatus`), never `skipped`. A run-level cancel (abort / run-`timeout` / budget) and a sibling fail-fast under `bail` still `skip` the in-flight leaf — only a bare per-attempt deadline counts as a timeout failure.

### Bounding a run (abort / timeout / budget)

```ts
import { createAbort } from '@orkestrel/abort'
import { createBudget } from '@orkestrel/budget'

const abort = createAbort()
const result = await runner.execute(definition, {
	signal: abort.signal, // an external cancellation
	timeout: 10_000, // a whole-run deadline (a non-positive value ⇒ NO deadline)
	budget: createBudget({ max: 50_000, consume: (usage) => usage.total }), // a cost ceiling
})
// A fire of ANY bound folds via AbortSignal.any: it cancels every in-flight task, skips the rest,
// and force-stops the workflow → status === 'stopped'. `execute` RESOLVES (never rejects) on a cancel.
```

See the `@orkestrel/tool` package's guide for authoring a definition through an LLM-callable tool (the FLAT / draft / nested authoring surface) and for wiring a `function`-form task to a registered tool or a live agent (`createToolFunction` / `createAgentFunction`, plus the depth/cycle guard against runaway `agent` → workflow-tool → workflow recursion).

**Control the live run.** The engine returns the live tree, but you can also drive, force, pause, mutate, observe, and serialize it directly:

### Driving the live entity tree directly

```ts
import { createWorkflow, isWorkflowError } from '@orkestrel/workflow'

const workflow = createWorkflow(definition)
const task = workflow.phase('fetch')?.task('a')
task?.start() // pending → running
task?.complete('done') // running → completed, records a Success; cascades up the tree

// Transitions are guarded — an illegal move throws a TRANSITION WorkflowError.
try {
	task?.complete('again') // already completed
} catch (error) {
	if (isWorkflowError(error) && error.code === 'TRANSITION') retry()
}
```

The cascade is reactive: a leaf transition recomputes its phase, which escalates to the workflow, each re-deriving its status (and emitting on a change). `skip` / `stop` on a phase or workflow FORCE its status (an override).

### Forcing a terminal status — `skip` / `stop`

```ts
import { createWorkflow } from '@orkestrel/workflow'

const workflow = createWorkflow(definition)
const phase = workflow.phase('optional-step')
const task = phase?.task('probe')

task?.skip() // leaf → 'skipped'; emits `skip` — never run, distinct from a stop
task?.stop() // leaf → 'stopped'; emits `stop` — ended early (guarded: only from a live status)

phase?.skip() // FORCE the whole phase 'skipped' — an override, survives a snapshot
phase?.stop() // FORCE the whole phase 'stopped'; emits `stop`

workflow.skip() // FORCE the whole workflow 'skipped' — overrides the derived status
workflow.stop() // FORCE the whole workflow 'stopped'; emits `stop`
```

A `skip` / `stop` at the phase / workflow tier is an OVERRIDE — it forces the node's status regardless of its children's derived value, and the override is persisted in `snapshot()`'s `override` field so `restoreWorkflow` restores it directly. A leaf's `skip` / `stop` is a real guarded transition (no override needed — its terminal status IS the marker).

### Pausing, resuming, and parking on a run — `pause` / `resume` / `wait` / `destroy`

`pause` / `resume` / `wait` are RUNTIME-ONLY at both the workflow and phase tiers — never a `LifecycleStatus`, never persisted. `destroy` is the workflow's TERMINAL teardown (a `Phase` has no `destroy` — only the workflow owns the cascade):

```ts
import { createWorkflow } from '@orkestrel/workflow'

const workflow = createWorkflow(definition)

workflow.pause() // suspend the run at the next phase boundary / task pre-dispatch
workflow.paused // true

const waiter = workflow.wait() // promise-parked; NEVER rejects
workflow.resume() // releases the parked waiter
await waiter // resolves once unpaused

workflow.phase('build')?.pause() // pause just this phase
workflow.phase('build')?.paused // true
workflow.phase('build')?.resume()

// destroy is the hard teardown: aborts `signal`, stops every non-terminal phase,
// forces the workflow to `stopped` if not already terminal, and releases every waiter.
workflow.signal.addEventListener('abort', () => cleanup())
workflow.destroy()
workflow.destroyed // true
workflow.destroy() // idempotent — a second call is a no-op
```

A driving `WorkflowRunnerInterface.execute(workflow)` gates a `pause` at the next phase boundary AND before each task's own dispatch (an in-flight task body is never suspended mid-flight); an external `timeout` / `budget` / `signal` unparks a paused run promptly rather than hanging, and keeps counting while paused.

### Mutating the live tree — `add` / `remove` / `move` / `update` / `patch`

`Workflow.add` / `remove` / `move` / `update` mutate the workflow's PENDING SUFFIX of phases; `Phase.add` / `remove` / `move` / `update` mutate a phase's tasks (a `running` phase accepts only a pure `add` append); both return a `Result` rather than throwing, and both fire their event on success only:

```ts
import { createWorkflow } from '@orkestrel/workflow'
import type { PhaseDefinition, TaskDefinition } from '@orkestrel/workflow'

const workflow = createWorkflow({ id: 'wf', name: 'Wf', phases: [] })

const phaseDefinition: PhaseDefinition = { id: 'p1', name: 'P1', tasks: [] }
const added = workflow.add(phaseDefinition) // MINT a live phase + insert it — Result<PhaseInterface, WorkflowError>
if (added.success) {
	const phase = added.value

	const taskDefinition: TaskDefinition = {
		id: 't1',
		name: 'T1',
		run: 'noop',
	}
	const addedTask = phase.add(taskDefinition) // MINT a live task + insert it into this phase
	if (addedTask.success) {
		phase.update(addedTask.value.id, { name: 'Renamed task' }) // patch a pending task
		phase.move(addedTask.value.id, 0) // reposition within the phase
		phase.remove(addedTask.value.id) // remove a pending task
	}

	workflow.update(phase.id, { concurrency: 4, bail: true }) // patch a pending phase
	workflow.move(phase.id, 0) // reposition within the workflow
	workflow.remove(phase.id) // remove a pending phase
}

// A direct entity `patch` is the defense-in-depth self-check the manager's `update` delegates to.
phase.patch({ concurrency: 2 }) // throws MUTATION unless this phase is `pending`
```

Every one of these is refused gracefully (a `MUTATION` `Result` failure, never a throw) when the container is terminal / `destroyed`, the target does not exist or is not `pending`, or the position falls outside the pending suffix; a `running` phase accepts an `add` ONLY as a pure append — a live runner subscribed to that phase's own `add` event picks the new task up for same-run execution.

### Building the live tree by hand — `append`

`createWorkflow` builds every phase/task from the definition via `PhaseManagerInterface.append` / `TaskManagerInterface.append` internally — the same methods are available directly on an already-built tree's managers, e.g. to graft a live phase (or task) built elsewhere onto it:

```ts
import { createWorkflow } from '@orkestrel/workflow'

const main = createWorkflow({ id: 'wf', name: 'Wf', phases: [{ id: 'p1', name: 'P1', tasks: [] }] })
const extra = createWorkflow({
	id: 'extra',
	name: 'Extra',
	phases: [
		{
			id: 'p2',
			name: 'P2',
			tasks: [{ id: 't1', name: 'T1', run: 'noop' }],
		},
	],
})

const phase = extra.phase('p2')
if (phase) main.phases.append(phase) // adds one live phase at the end, preserving order
main.phases.count // 2

const task = phase?.task('t1')
const target = main.phase('p1')
if (task && target) target.tasks.append(task) // adds one live task at the end
target?.tasks.count // 1
```

`append` adds one live child at the end, preserving positional order; `PhaseManagerInterface` / `TaskManagerInterface` otherwise stay lean (an accessor + `count`, no batch matrix, AGENTS §9.2).

### Observing the live tree

Each live `Workflow` / `Phase` / `Task` exposes a typed `emitter` (AGENTS §13) carrying its lifecycle for fire-and-forget observers — logging, metrics, progress UI. Subscribe via `entity.emitter.on(...)`, or wire initial listeners through the reserved `on` option (per-node, keyed by id under `WorkflowOptions.phases[id]` / `.tasks[id]`). Emitting is observation-only — every event fires strictly AFTER the relevant transition, so a listener can never change what a transition does:

```ts
import { createWorkflow } from '@orkestrel/workflow'

const workflow = createWorkflow(definition, { on: { complete: () => log('workflow done') } })
workflow.emitter.on('fail', (result) => log.warn('workflow failed under bail', result)) // the failing TaskResult
workflow
	.phase('fetch')
	?.task('a')
	?.emitter.on('complete', (result) => report(result))
```

The event vocabulary:

| Entity     | Event map          | Events                                                                                                                                  |
| ---------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Workflow` | `WorkflowEventMap` | `start(id)` · `complete()` · `fail(result)` · `stop()` · `add(phase, index)` · `remove(phase)` · `move(phase, index)` · `update(phase)` |
| `Phase`    | `PhaseEventMap`    | `start(id)` · `complete()` · `fail(result)` · `stop()` · `add(task, index)` · `remove(task)` · `move(task, index)` · `update(task)`     |
| `Task`     | `TaskEventMap`     | `start(id)` · `complete(result)` · `fail(result)` · `skip()` · `stop()`                                                                 |

A `start` fires when a node begins (enters `running`); `complete` when it settles successfully; `fail` carries the failing `TaskResult` (a `Workflow` / `Phase` derives `fail` only under `bail: true`); `stop` when it is force-stopped. A `Task` adds `skip`. A `Workflow` / `Phase` additionally fires `add` / `remove` / `move` / `update` on a successful structural or patch edit through its own `add` / `remove` / `move` / `update` methods — NEVER on a refused/gated one (a `Result` failure fires nothing). The leaf's own event fires BEFORE the cascade re-derives its parents (cause before effect). A listener throw is isolated by the emitter and routed to its `error` handler, never the domain surface — so a buggy observer can't corrupt a transition.

### Snapshot & restore (the durable payload)

```ts
import { createWorkflow, restoreWorkflow } from '@orkestrel/workflow'

const functions = { fetch: async (controller) => `fetched ${controller.task.id}` }
const workflow = createWorkflow(definition, { functions }) // a live tree, every node pending
workflow.phase('fetch')?.task('a')?.start() // pending → running (cascades up)

const snapshot = workflow.snapshot() // pure JSON — write to disk, send to a prompt, load across sessions

// Restore WITH the same `functions` registry: each task's `run` re-resolves into a fresh
// `handler`, so the restored tree can RESUME REAL WORK.
const resumed = restoreWorkflow(snapshot, { functions })
resumed.status === workflow.status // true — bail comes from the snapshot itself

// Restore WITHOUT `functions`: DECLARATIVE REPLAY — every restored task carries its `run`
// name but no `handler`, so it auto-completes if driven again.
const replayed = restoreWorkflow(snapshot)
```

The snapshot is self-contained (it persists `bail` + each node's `override` + per-task `run` / `retries` / `timeout`), so a restore re-derives status identically. An explicit `options.bail` on restore still wins (to deliberately re-run under a different policy).

### Persisting & restoring (the durable store)

The `WorkflowStoreInterface` seam (`get` / `set` / `delete`, async, keyed by a snapshot's own id) has a DUAL-store convention — pick the backend, the seam is identical. `createMemoryWorkflowStore` is the zero-plumbing default (a plain `Map`); `createDatabaseWorkflowStore` is the driver-pluggable twin over a `databases` table (the snapshot one opaque JSON column, driver defaulting to memory). Both persist the `WorkflowSnapshot` from the section above unchanged; reading one back and rebuilding the live tree is the shipped `restoreWorkflow`. A durable backend (JSON / SQLite / IndexedDB) swaps in by passing the driver to `createDatabaseWorkflowStore` — without touching the engine or the entity tree (the `SessionStore` / `QueueStore` driver-swap pattern).

```ts
import {
	createDatabaseWorkflowStore,
	createMemoryWorkflowStore,
	createWorkflow,
	restoreWorkflow,
} from '@orkestrel/workflow'
import { createMemoryDriver } from '@orkestrel/database'

// The zero-plumbing default (a plain Map) — or the driver-pluggable twin (one opaque JSON column):
const store = createMemoryWorkflowStore()
// const store = createDatabaseWorkflowStore(createMemoryDriver()) // pass a JSON / SQLite / IndexedDB driver for durability
const workflow = createWorkflow(definition)

await store.set(workflow.snapshot()) // persist the run state under its own id
// …later, in another turn / process …
const snapshot = await store.get(definition.id) // the persisted snapshot, or undefined if absent
const restored = snapshot && restoreWorkflow(snapshot) // an identical live tree
await store.delete(definition.id) // drop it (an absent id is a no-op)
```

The store has NO TTL / eviction — a persisted workflow run-state is durable until an explicit `delete` (unlike a session store), so a long-paused run never silently expires.

### Managing workflows (registry + store seam)

`WorkflowManager` (`createWorkflowManager`) is the additive manager tier over the section above — a store-backed REGISTRY of live workflows, mirroring the `@orkestrel/agent` line's `ConversationManager` / `WorkspaceManager`. It is PURELY ADDITIVE: direct `WorkflowStoreInterface` use and `restoreWorkflow` (both sections above) remain valid — a caller now has a THIRD, higher-level option that also tracks a `functions` registry so a hydrated workflow stays RUNNABLE.

```ts
import { createMemoryWorkflowStore, createWorkflowManager } from '@orkestrel/workflow'

const store = createMemoryWorkflowStore() // or createDatabaseWorkflowStore(driver)
const functions = { compile: async (controller) => `built ${controller.task.id}` }
const manager = createWorkflowManager({ store, functions })

const workflow = manager.add(definition) // MINTED, registered, RUNNABLE (functions flow in)
manager.workflow(workflow.id) // the same live workflow
manager.workflows() // every registered workflow, insertion order

await manager.save(workflow.id) // persist its snapshot to the store

// …later, in another turn / process, a FRESH manager over the SAME store + functions…
const fresh = createWorkflowManager({ store, functions })
const reopened = await fresh.open(workflow.id) // HYDRATED from the store, RUNNABLE again

manager.remove(workflow.id) // drop one; remove(['a', 'b']) drops a batch
manager.clear() // empty the registry
```

Unlike its `ConversationManager` / `WorkspaceManager` twins, there is NO `active` / `switch` pointer — nothing in the workflow domain renders "the current workflow" the way an agent context renders the active conversation/workspace, so carrying one would be a speculative extra (AGENTS §21). `open` / `save` are otherwise the EXACT lenient store seam: `open` resolves a registered workflow directly (no store hit), else hydrates from `store` on a miss (`undefined` on a store miss or no store); `save` persists a registered workflow (`false` on an unknown id or no store) — never a throw.

### The helper functions — guards, derivation, lineage & synthesis

The pure functions the entity tree / runner / tool are built from (AGENTS §4.3 / §14) — exported directly, so a caller can reuse the same derivation or synthesis logic outside the shipped classes:

```ts
import {
	assertSnapshot,
	buildPhaseContext,
	buildTaskContext,
	buildWorkflowContext,
	canTransitionTask,
	collectResults,
	definitionToSnapshot,
	deriveBoundary,
	derivePhaseStatus,
	deriveWorkflowStatus,
	findFailure,
	isTerminalStatus,
	isWorkflowSnapshot,
	parkSignal,
	phaseDefinitionToSnapshot,
	taskDefinitionToSnapshot,
} from '@orkestrel/workflow'

// Status predicates + derivations — pure, order-insensitive reductions (never throw).
isTerminalStatus('completed') // true
derivePhaseStatus(['completed', 'skipped']) // 'completed'
deriveWorkflowStatus([{ status: 'failed', bail: false }]) // 'completed' — a graceful-bail failure folds in
canTransitionTask('pending', 'running') // true — reads the TASK_TRANSITIONS graph

// Lineage context builders — each level's identity plus a back-reference up the tree.
const workflowContext = buildWorkflowContext({ id: 'wf', name: 'Wf' })
const phaseContext = buildPhaseContext(workflowContext, { id: 'p1', name: 'P1' })
buildTaskContext(phaseContext, { id: 't1', name: 'T1' })

// Definition → initial snapshot — the unified construction path `createWorkflow` builds from.
const snapshot = definitionToSnapshot(definition) // every node 'pending'
phaseDefinitionToSnapshot(definition.phases[0], snapshot.bail)
taskDefinitionToSnapshot(definition.phases[0].tasks[0])
assertSnapshot(snapshot) // throws a RESTORE WorkflowError on an invalid snapshot; void on a valid one
isWorkflowSnapshot(JSON.parse(JSON.stringify(snapshot))) // true — the shape survives a JSON round-trip

// The pending-suffix boundary — the index of the first `pending` entry (or `length` if none).
deriveBoundary(['completed', 'completed', 'pending', 'pending']) // 2

// Result-tree flattening.
collectResults([[], []]) // [] — no settled tasks yet
const result = await runner.execute(definition)
findFailure(result.results) // the first failing TaskResult, or undefined

// Park until an AbortSignal fires — never rejects, self-removing listener.
const abort = new AbortController()
const parked = parkSignal(abort.signal)
abort.abort()
await parked // resolves
```

Every one is pure and side-effect-free: the guards/predicates never throw (`assertSnapshot` is the sole exception — it validates the DEEPER lifecycle vocabulary and throws a `RESTORE` `WorkflowError`), and the builders/synthesizers are deterministic given the same input.

**The execution substrate.** Beneath the engine sit the shipped primitives it composes. The `Scheduler` paces the host between work; the queue-backed `Runner` bounds and drives a set of units; a `Controller` is the per-unit handle a handler receives; and the `WorkflowRunner` engine composes all of it over the entity tree — with `TaskController` mirroring `Controller` one tier up, as the handle a workflow-task `WorkflowFunction` receives (its read-up `results()` is the inter-task data-flow map). The patterns below build that stack up from pacing to driving to the per-unit handle.

### Pacing with the scheduler — a cooperative loop

The dominant use of the scheduler: a long-running loop that periodically hands the host control so it stays responsive, checking an abort signal each pass.

```ts
import { createScheduler } from '@orkestrel/workflow'
import { createAbort } from '@orkestrel/abort'

const abort = createAbort()
const scheduler = createScheduler()

async function pump(): Promise<void> {
	while (!abort.signal.aborted) {
		processOneItem()
		// Give the host a turn (I/O, timers, rendering); abort rejects out of the loop.
		await scheduler.yield({ signal: abort.signal })
	}
}
```

### Backoff — delay a growing interval between attempts

`delay(ms)` waits at least `ms`; pair it with an exponential interval for a retry backoff, and pass a `signal` to bail early.

```ts
import { createScheduler } from '@orkestrel/workflow'

const scheduler = createScheduler()

async function withBackoff(attempt: () => Promise<boolean>, signal?: AbortSignal): Promise<void> {
	for (let n = 0; n < 5; n += 1) {
		if (await attempt()) return
		await scheduler.delay(2 ** n * 100, { signal }) // 100ms, 200ms, 400ms, …
	}
}
```

### Swapping the scheduler backend

Every scheduler is the same `SchedulerInterface`, so consumers type against the interface and never name a concrete class. Pick the host-native backend once at the composition root; the loop is identical regardless of which `yield` primitive runs underneath.

```ts
import type { SchedulerInterface } from '@orkestrel/workflow'
import { createNodeScheduler } from '@orkestrel/workflow/server' // setImmediate yield
import { createIdleScheduler } from '@orkestrel/workflow/browser' // requestIdleCallback yield

// Choose per environment at the edge…
const scheduler: SchedulerInterface = isServer ? createNodeScheduler() : createIdleScheduler()

// …then write the loop once against the portable interface.
async function pump(work: () => void, signal: AbortSignal): Promise<void> {
	while (!signal.aborted) {
		work()
		await scheduler.yield({ signal })
	}
}
```

### Driving a set of units with the `Runner`

```ts
import { createRunner } from '@orkestrel/workflow'

// Ordered (concurrency defaults to 1): each unit runs to completion before the next.
const runner = createRunner<Job, Output>({ handler: (controller) => run(controller.input) })

const outputs = await runner.execute(jobs) // results in input order
```

### Bounded concurrency

```ts
// Up to 5 units in flight at once; the rest wait for a slot (the Queue's backpressure).
const runner = createRunner<string, Response>({
	concurrency: 5,
	handler: (controller) => fetch(controller.input, { signal: controller.signal }),
})

const responses = await runner.execute(urls)
```

### Per-entry retries and timeout

```ts
// The runner-level retries / timeout are the defaults; `entries` overrides them per unit
// (its result is a RunnerEntryOptions — { retries?, timeout? }). An omitted field falls back.
const runner = createRunner<Job, Output>({
	retries: 0, // the default for every unit…
	handler: (controller) => run(controller.input, controller.signal),
	entries: (job) => (job.flaky ? { retries: 3 } : {}), // …overridden per input
})
```

### Fanning out with `spawn`

```ts
// A handler discovers more work and fans it out as sibling units — they run through the
// same queue and their results join the output after the declared units, in spawn order.
const runner = createRunner<Task, Result>({
	concurrency: 8,
	handler: (controller) => {
		for (const child of discover(controller.input)) {
			controller.spawn(child) // fire-and-track — do NOT await inline (deadlock caveat)
		}
		return process(controller.input)
	},
})

const results = await runner.execute(roots) // declared roots first, then every spawn
```

`spawn` returns the sibling's result promise, but the run drains it whether or not you await it — so fan out and return. On a bounded runner, awaiting a spawn _inline_ from a slot-holding handler can deadlock; let the runner drain the closure instead.

### The per-unit `Controller` handle — `wait` / `spawn` / `abort`

A `Runner` handler receives a `Controller` — the per-unit handle: its `id` / `input` / `signal` data plus `wait` (park until this unit is cancelled), `spawn` (fan out a sibling), and `abort` (cancel THIS unit, firing its signal with an optional reason).

```ts
import { createRunner } from '@orkestrel/workflow'

const runner = createRunner<Job, Output>({
	concurrency: 4,
	handler: async (controller) => {
		for (const child of discover(controller.input)) {
			controller.spawn(child) // fan out a sibling unit through the same queue
		}
		const work = run(controller.input, controller.signal) // honour the signal
		await Promise.race([work, controller.wait()]) // wait() parks until cancelled — never a timer
		if (overBudget(controller.input)) controller.abort(new Error('over budget')) // cancel THIS unit
		return work
	},
})
```

A handler observes its `controller.signal` (pass it to `fetch` / child aborts) and may `await controller.wait()` to park until the unit is cancelled — promise-parked, so it costs nothing until the signal fires; `spawn` fans out siblings through the same queue, and `abort` cancels this unit outright.

### Fail-fast and abort

```ts
const runner = createRunner<Job, Output>({
	concurrency: 4,
	handler: (controller) => run(controller.input, controller.signal),
})
const run = runner.execute(jobs)

// The first unit to throw (after its retries) aborts the rest and rejects the run; an
// external abort does the same.
runner.abort(new Error('shutting down'))
await run.catch((error) => report(error))

// Tear the runner down when it's no longer needed — abort plus stop the backing queue.
// Idempotent: a second `destroy()` is a no-op.
runner.destroy()
```

### Deterministic async waits with `createDeferred`

`createDeferred` builds a `DeferredInterface` — a promise whose `resolve` / `reject` are exposed to the caller, for driving an async scenario's settlement externally instead of relying on a real delay:

```ts
import { createDeferred } from '@orkestrel/workflow'

const deferred = createDeferred<string>()

// Somewhere else, on your own schedule:
deferred.resolve('done')

await deferred.promise // 'done'
```

### Observing the `Runner`

The `Runner` exposes a typed `emitter` (AGENTS §13) carrying its run lifecycle for fire-and-forget observers — logging, metrics, tracing. Subscribe via `runner.emitter.on(...)`, or wire initial listeners through the reserved `on?` option; supply an `error?` handler to receive a listener's throw. **Emitting is observation-only**: every event fires strictly AFTER the relevant unit-launch / settle / drain transition, so a listener can never change what the run does — and a throwing listener can never corrupt it.

```ts
import { createRunner } from '@orkestrel/workflow'

const runner = createRunner<Job, Output>({
	handler: (controller) => run(controller.input),
	on: { finish: (results) => console.log(`done: ${results.length}`) }, // initial listener
})

runner.emitter.on('unit', (id) => trace.begin(id))
runner.emitter.on('fail', (id, error) => log.warn(`unit ${id} failed`, error))
```

The `RunnerEventMap<TResult>` vocabulary:

| Event    | Payload         | Fires when                                                                      |
| -------- | --------------- | ------------------------------------------------------------------------------- |
| `start`  | `[]`            | `execute` begins (once per run).                                                |
| `unit`   | `[id]`          | A unit's handler begins running (declared or spawned).                          |
| `spawn`  | `[id, parent?]` | A sub-unit is spawned — its id + the spawning parent's id.                      |
| `settle` | `[id]`          | A unit completed successfully (its value recorded).                             |
| `fail`   | `[id, error]`   | The FIRST unit failure (fail-fast) — its id + the error.                        |
| `finish` | `[results]`     | The batch settled OK — the ordered results (the same array `execute` resolves). |
| `abort`  | `[reason]`      | The run was aborted — fail-fast cascade, a user `abort`, or `destroy`.          |

A successful run fires `start` → `unit`/`settle` per unit → `finish`. A failure fires `fail` (the first failure only — later failures are ignored) then the run-level `abort`, and `execute` rejects WITHOUT a `finish`. A user `abort` fires `abort` (the units are cancelled, not failed, so no `fail`).

**The listener-isolation safety guarantee.** A listener throw is NEVER allowed to escape into the engine: the emitter isolates it and routes it to its OWN `error` handler (the `error` option, surfaced as `(error, event)`), NOT to a domain event — so a buggy observer is isolated yet not silently lost. Because every emit sits after the unit-launch / settle / drain transition AND is isolated, a buggy observer **cannot corrupt the one-shot / fail-fast / spawn-tracking engine**: the outstanding-unit count gate stays balanced (the run still drains, never truncates or hangs) and fail-fast still rejects with the first error.

### Practices

- **Author the definition as DATA** — reference behavior BY NAME (`run: '…'`, a plain string); register the handlers in `options.functions` at `execute`, not in the definition.
- **Express a dependency structurally** — put a task that needs another's output in a LATER phase; the phase boundary is the only dependency edge, and it guarantees the inputs are ready.
- **Lean on the contract** — `createWorkflowContract().parse` an untrusted authored blob (an LLM tool arg) into a `WorkflowDefinition` or `undefined`; never trust raw JSON.
- **Choose `bail` deliberately** — `false` (graceful) when failures are useful data and every phase should run; `true` (halt) for transaction semantics where the first failure aborts the rest.
- **Hold the live tree the engine returns** — `result.workflow` is the source of truth; navigate it (`phase(id)?.task(id)?.status` / `.result`) and read the result tree (`results()`).
- **Snapshot for durability** — `workflow.snapshot()` is the pure-JSON payload; `restoreWorkflow` rebuilds an identical live tree, and the `WorkflowStore` seam persists it (W-d).
- **`yield` to stay cooperative** — between units of long-running work, `await scheduler.yield()` so the host can flush I/O, fire timers, and paint; never busy-loop a tight synchronous loop that starves the host.
- **Always thread a `signal` through the scheduler** — pass `options.signal` through `yield` / `delay` so cancellation rejects the pending wait at once (with the signal's `reason`) instead of stalling until the interval elapses; an aborted loop should fall out via that rejection, not a polled flag alone.
- **`delay` for spacing, `yield` for a turn** — reach for `delay(ms)` to space retries or paced work; reach for `yield()` (a zero-delay turn) when you only need to let the host run before continuing.
- **Type against `SchedulerInterface`** — depend on the interface, not a concrete class, and pick the backend at the composition root, so the same loop runs on any host.
- **Honour `controller.signal`** — pass it to `fetch` / child aborts and bail when it fires, so a fail-fast or an `abort` actually stops in-flight units instead of just abandoning their results.
- **Fan out, don't await inline** — `spawn` siblings and return; the run drains the whole closure. Awaiting a spawn inline from a bounded handler risks a slot-starvation deadlock.
- **`concurrency: 1` for ordering** — there is no separate sequential flag; a concurrency of one runs units one-at-a-time.
- **One-shot** — a `Runner` runs one `execute`; create a new one to run another set.
- **No events yet on the pacing primitive** — the scheduler is a functional primitive; do not reach for an Emitter here (observability is a separate deferred pass).
- **Observe, don't drive** — subscribe to a node's `emitter` for progress / metrics, and to `runner.emitter` for run-lifecycle moments; emitting is a pure side-channel, so a listener never changes what a transition or run does (and a throwing one can't corrupt it).

## Tests

- [`tests/guides/parity.test.ts`](../../tests/guides/src/parity.test.ts) — the `## Surface` ↔ source bijection across `src/core/workflows` (value + type exports), plus each behavioral interface's `## Methods` ↔ source-method bijection and each implementing-class ↔ interface method parity.
- [`tests/src/core/helpers.test.ts`](../../tests/src/core/helpers.test.ts) — the pure helpers: `isTerminalStatus`, the `derivePhaseStatus` / `deriveWorkflowStatus` truth tables (the latter taking `PhaseDerivation[]` — each phase's status + its effective `bail`; a graceful-bail `failed` phase folds into `completed` while a strict-bail `failed` phase propagates `failed`, mixed-bail permutations order-insensitive), `canTransitionTask`, the lineage builders, `definitionToSnapshot` + variants (`phaseDefinitionToSnapshot` persisting the effective per-phase `bail`; `taskDefinitionToSnapshot` carrying `run` / `retries` / `timeout` verbatim), `collectResults`, `parkSignal` (resolves on abort, never rejects), and `isWorkflowSnapshot` (the §14 boundary narrow `DatabaseWorkflowStore` uses to read back its opaque JSON column — accepting a real snapshot + its JSON-revived form, rejecting off-shape values without throwing).
- [`tests/src/core/shapers.test.ts`](../../tests/src/core/shapers.test.ts) — the shape descriptors: the `taskShape` / `phaseShape` / `workflowShape` mirroring the hand-written definition interfaces, the per-field `description`s riding the `run` string + key fields (Rank 1), `describedLiteral`.
- [`tests/src/core/tasks/Task.test.ts`](../../tests/src/core/tasks/Task.test.ts) — the leaf state machine: guarded `start` / `complete` / `fail` / `skip` / `stop`, the recorded `TaskResult` (the boxed `Success` / `Failure`), the `TRANSITION` `WorkflowError` on an illegal move, the snapshot, and the `emitter` (`TaskEventMap`) + emit-safety.
- [`tests/src/core/phases/Phase.test.ts`](../../tests/src/core/phases/Phase.test.ts) — the derived middle tier: `derivePhaseStatus` reacting to child transitions (the cascade), the `skip` / `stop` override, `results()`, the snapshot → restore round-trip (the `#override` + positional order after an interior `skip`), and the `emitter` (`PhaseEventMap`) + emit-safety.
- [`tests/src/core/Workflow.test.ts`](../../tests/src/core/Workflow.test.ts) — the derived root: `deriveWorkflowStatus` under both `bail` modes, the cascade propagating up, the result tree (`results()` flattening every phase), the override, the full `snapshot()` → `restoreWorkflow()` round-trip (self-contained `bail` + override), and the `emitter` (`WorkflowEventMap`) + emit-safety.
- [`tests/src/core/phases/PhaseManager.test.ts`](../../tests/src/core/phases/PhaseManager.test.ts) — the lean phases registry: `append` / `phase` / `phases` / `count`, insertion order preserved.
- [`tests/src/core/tasks/TaskManager.test.ts`](../../tests/src/core/tasks/TaskManager.test.ts) — the lean tasks registry: `append` / `task` / `tasks` / `count`, order surviving an interior `skip`.
- [`tests/src/core/WorkflowManager.test.ts`](../../tests/src/core/WorkflowManager.test.ts) — the store-backed registry: `add` / `workflow` / `workflows` / `count`, `remove` (id + batch) / `clear`, the `functions` registry producing RUNNABLE workflows (a resolved `handler`, driven to `completed` via `createWorkflowRunner`) vs auto-completing without one, and the `open` / `save` store seam parametrized over BOTH `MemoryWorkflowStore` and `DatabaseWorkflowStore` — a registry hit skipping the store, a registry-miss `open` hydrating an IDENTICAL + RUNNABLE workflow, `save` persisting + upserting, and lenient `undefined` / `false` misses (no store, unknown id) throughout.
- [`tests/src/core/tasks/TaskController.test.ts`](../../tests/src/core/tasks/TaskController.test.ts) — the per-task handle: `signal` / `aborted`, the `input` bag, the lineage `task`, and `results()` reading up the live tree.
- [`tests/src/core/WorkflowRunner.test.ts`](../../tests/src/core/WorkflowRunner.test.ts) — the PURE-engine runner end-to-end: phases-sequential / tasks-concurrent, a no-handler task auto-completing, the per-phase `concurrency` throttle, `bail: false` recording failures while finishing vs `bail: true` aborting on the first failure (incl. a fail-while-a-sibling-is-mid-flight), per-task `retries` recovering a divergent task while a no-retry sibling fails + a per-task `timeout` FAILING a parked leaf (never skipping it, the failure recorded under `bail: false`) + a retries+timeout attempt RECOVERING (attempt 1's deadline retries, attempt 2 `completes` — the recovered value kept) + a `bail: true` timeout-only fault deriving `failed` and halting a later phase + the sibling-fail-fast still SKIPPING a parked sibling (the timeout distinguisher does not break skip-on-fail-fast) + an omission-regression (neither field = today's behavior), the per-phase `bail` override (a strict phase halting under a graceful workflow / a graceful phase settling-all under a strict workflow / the `effectiveBail = phase.bail ?? workflow.bail` inheritance pair), the abort / timeout / budget fold (settling `stopped`), and dispatch by a task's own resolved `handler` (a plain function) — the tool/agent adapter dispatch coverage lives in the `@orkestrel/tool` package.
- [`tests/src/core/factories.test.ts`](../../tests/src/core/factories.test.ts) — `createWorkflowContract` / `createWorkflow` / `restoreWorkflow` / `assertSnapshot` / `createWorkflowRunner` each return a working instance / value (a round-trip), and `assertSnapshot` rejecting an invalid snapshot with a `RESTORE` `WorkflowError`; `restoreWorkflow(snapshot, { functions })` resuming real work vs a bare `restoreWorkflow(snapshot)` staying declarative replay.
- [`tests/src/core/stores/MemoryWorkflowStore.test.ts`](../../tests/src/core/stores/MemoryWorkflowStore.test.ts) — the in-memory store (W-d): a `set` → `get` round-trip returning the same `WorkflowSnapshot` and `restoreWorkflow`'ing an IDENTICAL live tree, for BOTH an all-pending snapshot (`createWorkflow(...).snapshot()`) and a real SETTLED one driven through `createWorkflowRunner().execute` (real `completed` statuses + recorded results); the driver-swap parity case (the retrieved payload survives `JSON.parse(JSON.stringify(...))` AND restores identically from the JSON-revived form — proving it persists unchanged across any JSON / SQLite / IndexedDB backend); `set` replacing under the same id; and `delete` (then `get` ⇒ `undefined`, an absent-id `delete` a no-op, an absent-id `get` ⇒ `undefined`). REAL data throughout (a real `WorkflowDefinition` + real `WorkflowFunction` handlers), no mocks.
- [`tests/src/core/stores/DatabaseWorkflowStore.test.ts`](../../tests/src/core/stores/DatabaseWorkflowStore.test.ts) — the driver-pluggable twin (W-d): the SAME `WorkflowStoreInterface` contract over a REAL `databases` table (a memory driver), with the snapshot stored as one opaque JSON column — a `set` → `get` round-trip returning the same `WorkflowSnapshot` and `restoreWorkflow`'ing an IDENTICAL live tree (all-pending AND a real SETTLED snapshot driven through `createWorkflowRunner().execute`); `set` replacing under the same id; `delete` (+ absent-id `delete` no-op, absent-id `get` ⇒ `undefined`); and the driver-swap smoke (the default-driver factory builds an equivalent memory-backed store; two distinct workflow ids coexist without cross-contamination). REAL `WorkflowSnapshot` values throughout (a real `WorkflowDefinition` + real `WorkflowFunction` handlers), NO mocks.
- [`tests/src/core/Runner.test.ts`](../../tests/src/core/Runner.test.ts) — `execute` runs every input and returns results in declared order (even with out-of-order completion); spawned siblings actually run and order after the declared units; nested spawns drain transitively; bounded concurrency caps handlers in flight; `retries` re-run a flaky unit; fail-fast (one unit throwing rejects `execute` AND fires the siblings' signals); `abort()` mid-run rejects `execute` and aborts every unit; one-shot (a second `execute` throws); `spawn` outside a run throws; empty `execute([])` resolves to `[]`; `active` / `stopped` reporting; idempotent `destroy`.
- [`tests/src/core/Controller.test.ts`](../../tests/src/core/Controller.test.ts) — `wait()` resolves when the unit's signal aborts and stays pending across real delays until it does (promise-parked, not timer-polled), resolving immediately if already aborted; `id` / `input` / `signal` / `aborted` reflect the unit; `abort(reason)` fires the signal with the reason; `spawn` delegates to the injected callback.
- [`tests/src/core/factories.test.ts`](../../tests/src/core/factories.test.ts) — `createRunner` round-trip: fan-out via `spawn` with ordered results, and concurrency / retries options honoured end to end — alongside the scheduler + workflow-runner + tool factories.

- [`tests/src/core/Scheduler.test.ts`](../../tests/src/core/Scheduler.test.ts) — `yield()` resolves asynchronously and as a macrotask (a microtask queued after it runs first), `yield` / `delay` reject with `signal.reason` when pre-aborted and when aborted while pending, `delay(ms)` resolves after `ms` (fake timers), an abort before the deadline clears the timer so it never later fires (no double-settle), a completed call leaves no pending timer or listener, and `priority` is accepted (across `yield` / `delay`, combined with `signal`) without changing behavior. Production-hardening: thousands of resolved AND aborted `yield` / `delay` calls never accumulate host timers (`vi.getTimerCount()` → 0) and the abort listener nets to zero across churn; one shared `AbortSignal` rejects ALL its pending operations with the reason and clears every timer/listener with no double-settle; many concurrent `delay`s at distinct deadlines each resolve at exactly their own time; abort-timing edges; the `ms` clamp for `0` / `1` / negative / `NaN` / very large; and the reason is forwarded verbatim.
- [`tests/src/core/factories.test.ts`](../../tests/src/core/factories.test.ts) — `createScheduler` returns a working `SchedulerInterface` whose `yield` and `delay` round-trip and whose `delay` is abort-aware, and returns independent stateless instances (aborting a signal bound to one does not affect another) — alongside the workflow-runner + tool factories.
- [`tests/src/server/NodeScheduler.test.ts`](../../tests/src/server/NodeScheduler.test.ts) — the Node backend over REAL `setImmediate` / `setTimeout`: `yield()` resolves as a `setImmediate` macrotask, `delay(ms)` resolves after `ms` with a `vi.getTimerCount()` leak proof, already-aborted `yield` / `delay` rejects with the EXACT `signal.reason` WITHOUT arming, an abort during a pending `delay` clears the timer, a completed call removes its abort listener, priority is an accepted no-op, and churn leaves zero pending timers / a balanced listener net.
- [`tests/src/server/factories.test.ts`](../../tests/src/server/factories.test.ts) — `createNodeScheduler` returns a working `SchedulerInterface` (shape + a real yield/delay round-trip), abort-aware, independent stateless instances.
- [`tests/src/browser/BrowserScheduler.test.ts`](../../tests/src/browser/BrowserScheduler.test.ts) — the browser backend in REAL headless Chromium (where `scheduler.postTask` exists): `yield()` resolves via the real `postTask` callback, every priority is accepted, abort rejects with the verbatim `signal.reason` and the posted task is cancelled, `delay` timing, and a completed call leaves no abort listener.
- [`tests/src/browser/FrameScheduler.test.ts`](../../tests/src/browser/FrameScheduler.test.ts) — the frame backend in REAL Chromium over `requestAnimationFrame`: `yield()` resolves in a real frame callback, abort cancels the rAF handle and rejects with the verbatim reason, `delay` timing, and no leaked listener.
- [`tests/src/browser/IdleScheduler.test.ts`](../../tests/src/browser/IdleScheduler.test.ts) — the idle backend in REAL Chromium over `requestIdleCallback`: `yield()` resolves in a real idle callback, abort cancels the idle handle and rejects with the verbatim reason, `delay` timing, and no leaked listener; the `setTimeout(0)` fallback is covered by the guard logic + a note.
- [`tests/src/browser/factories.test.ts`](../../tests/src/browser/factories.test.ts) — `createBrowserScheduler` / `createFrameScheduler` / `createIdleScheduler` each return a working `SchedulerInterface` (shape + a real yield/delay round-trip), abort-aware, independent instances, in real Chromium.

## See also

- [`contract.md`](contract.md) — the shape DSL and `createContract` the workflow definition contract is built on, and the `Result` a `TaskResult` boxes.
- The `@orkestrel/tool` package — the authoring-tool / adapter layer EXTRACTED from this package: wrapping a `WorkflowDefinition` as an LLM-callable tool, and wrapping a registered tool or a live agent as a `WorkflowFunction` (the OPT-IN `createToolFunction` / `createAgentFunction` adapters + the depth/cycle guard). It depends on `@src/core` for `WorkflowError`, `createWorkflowContract`, and `WorkflowRunnerInterface`.
- [`abort.md`](abort.md) · [`timeout.md`](timeout.md) · [`budget.md`](budget.md) — the run-level bounds the runner (`Runner` / `WorkflowRunner`) folds; the scheduler (pacing) is documented in this guide.
- [`emitter.md`](emitter.md) — the typed §13 emitter each live entity owns.
- [`AGENTS.md`](../../AGENTS.md) — the rules; §4.4 the `bail` boolean toggle, §10 the lifecycle vocabulary, §12 errors & `Result`, §14 totality, §22 documentation-as-contracts.
- [`README.md`](../README.md) — the guides index.
