# Workflow

> Orchestration as DATA: a JSON-serializable `Workflow → Phase → Task` tree — a strict three levels, positional, no DAG — that a UI or an LLM authors, persistence stores, and a thin engine drives by COMPOSING the shipped execution substrate. Not a general DAG engine: it trades arbitrary dependency graphs for a fixed, deterministic shape, and writes none of its own concurrency / retry / abort machinery — it reuses what already ships.

Read the module as five layers of one substrate, top to bottom:

- **The tree describes.** The **definition** family (`WorkflowDefinition → PhaseDefinition → TaskDefinition`) is pure JSON — behavior referenced BY NAME, never inline functions — so the whole tree serializes, round-trips, and is safe for a 2B model to emit. One compiled [contract](contract.md) (`createWorkflowContract`) keeps the JSON Schema + guard + parser + seeded generator in lockstep with the hand-written interfaces, so definition and runtime can never drift.
- **The entities control.** The live **entity** family (`Workflow` / `Phase` / `Task`) is the runtime mirror BUILT from a definition: each node is an [§13-observable](emitter.md) synchronous state machine whose status is DERIVED from its children, mutable through its own `add` / `remove` / `move` / `update`, pausable, and snapshot-able at any instant.
- **The engine drives.** The `WorkflowRunner` is a PURE engine that walks the live tree — phases sequentially, each phase's tasks concurrently — COMPOSING the substrate rather than re-implementing status / concurrency / retries / abort, under a `bail` failure policy: `false` (graceful, the default) records each leaf failure as data and finishes every phase; `true` (the database-transaction halt) aborts the in-flight siblings on the first failure and skips the rest.
- **The substrate executes.** Underneath sit the shipped primitives the engine composes: the `Scheduler` paces the host between work, the queue-backed `Runner` bounds and drives a set of units, and a `Controller` is the per-unit handle a handler receives. The engine folds [abort](abort.md) / [timeout](timeout.md) / [budget](budget.md) through this same substrate.
- **The consumer supplies behavior.** A task's `run` is a PLAIN STRING naming a behavior in the `WorkflowOptions.functions` registry — resolved ONCE at construction into the task's `handler` (a `WorkflowFunction`); the engine dispatches by invoking `task.handler` directly and carries no registry or provider knowledge of its own. Integrations compose real `WorkflowFunction`s at the application edge.

**Determinism is fixed by design, not configured: tasks within a phase run concurrently; phases run sequentially.** A dependency is expressed STRUCTURALLY — a task that needs another's output goes in a later phase — so the same tree always sequences the same way and there is no DAG to misconfigure. The only per-phase knob is an optional `concurrency` throttle (max-in-flight), never a sequencing control.

Workflow keeps ALL runtime/engine surface — the definition contract, live entity tree, PURE runner, and durable store. Provider, tool, terminal, and protocol integrations remain composition concerns outside this package.

Source: [`src/core`](../src/core). Published through `@orkestrel/workflow`.

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
		publish: async () => 'published',
	},
})
result.status // 'completed'
result.workflow.phase('build')?.task('compile')?.status // 'completed'
result.results // every settled task's TaskResult, in positional order
```

Why this is safe: the definition is the SINGLE source of truth. `execute` builds the live tree from the definition itself — there is no separately-supplied tree to fall out of sync — so the executed entity can never drift from the `run` string / `concurrency` metadata, and the freshly-built live `workflow` is returned in the result. Each task's `run` string is resolved ONCE at construction against `options.functions` into its `handler`; the runner then simply invokes `task.handler`. Phase `ship` starts only once phase `build` has fully settled; within `build`, `compile` and `lint` run concurrently. Omitting `run` deliberately creates a no-op task whose JSON result is `null`. A present `run` must resolve before execution; an absent registry entry is rejected rather than silently skipping named work.

### Factories

| API                           | Kind     | Summary                                                                                                                                     |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWorkflowContract`      | function | Compile the workflow-definition `ContractInterface` — JSON Schema + guard + parser + seeded generator, all from one shape.                  |
| `createWorkflow`              | function | Build the live `WorkflowInterface` entity tree from a `WorkflowDefinition` (every node `pending`).                                          |
| `createRestoredWorkflow`      | function | Build an equivalent live tree from a `WorkflowSnapshot` — the inverse of `snapshot()` (structure + status + results + order).               |
| `createRecoveredWorkflow`     | function | Build an interrupted tree back to life — running leaves return to their remaining retry budget, or normalize to recovery failures.          |
| `createMemoryWorkflowStore`   | function | Create the in-memory default `WorkflowStoreInterface` — persists `WorkflowSnapshot`s by id (the durable-store seam; no TTL, no options).    |
| `createDatabaseWorkflowStore` | function | Create the driver-pluggable `WorkflowStoreInterface` over a `databases` table (the snapshot as one JSON column; driver defaults to memory). |
| `createWorkflowRunner`        | function | Create a PURE `WorkflowRunnerInterface` engine over an optional `scheduler` — no behavior or provider registry.                             |
| `createWorkflowManager`       | function | Create a store-backed live-workflow registry; optional functions make hydrated named work runnable, while omission remains inspectable.     |
| `createScheduler`             | function | Create the cross-environment `setTimeout`-based default `SchedulerInterface`.                                                               |
| `createRunner`                | function | Create a `RunnerInterface` over a handler — drives a `Queue`, ordered + fail-fast `execute`.                                                |
| `createDeferred`              | function | Create a `DeferredInterface` — a promise whose settlement (`resolve` / `reject`) is driven externally.                                      |

### The entity tree

The live runtime mirror of a definition. Each entity class implements its interface exactly, so the `## Methods` tables below double as its per-instance method surface (AGENTS §22).

| Class          | Kind  | Role                                                                                                                                                                                                                          |
| -------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Workflow`     | class | The live DERIVED root — status from its phases under `bail`, the cascade's top, `pause` / `resume` / `wait` / `destroy`, `add` / `remove` / `move` / `update` its phases, `snapshot()` / `skip` / `stop`, an owned `emitter`. |
| `Phase`        | class | The live DERIVED middle tier — status from its tasks, recomputes + escalates on a child transition, `pause` / `resume` / `wait`, `add` / `remove` / `move` / `update` / `patch` its tasks, an owned `emitter`.                |
| `Task`         | class | The live leaf — guarded lifecycle, bounded current activity, task signal, cooperative pause gate, and silence observation.                                                                                                    |
| `PhaseManager` | class | The lean child registry of a workflow's live phases — insertion-ordered `append` / `add` / `remove` / `move` / `update` / `phase` / `phases` / `count`.                                                                       |
| `TaskManager`  | class | The lean child registry of a phase's live tasks — insertion-ordered `append` / `add` / `remove` / `move` / `update` / `task` / `tasks` / `count` (order survives a `skip`).                                                   |

### The execution substrate

Beneath the engine sit the shipped primitives it composes — it re-implements none of them. The pure `WorkflowRunner` engine DRIVES the live entity tree and folds the run-level bounds; the queue-backed `Runner` bounds and drives a set of units under a fail-fast policy; a `Controller` is the per-unit handle a `Runner` handler receives; and `TaskController` mirrors `Controller` one tier up, as the handle a workflow-task `WorkflowFunction` receives. The engine carries NO behavior or provider registry of its own — each live task resolves its `run` string ONCE at construction into its own `handler`, and the engine simply invokes it.

| Class                 | Kind  | Role                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowRunner`      | class | The PURE engine — phases sequential (a plain await loop), each phase's tasks concurrent (one substrate `createRunner` per phase), dispatching each task's OWN resolved `handler`. `execute` has TWO overloads: build-and-drive from a `WorkflowDefinition`, or drive an ALREADY-BUILT caller-owned `WorkflowInterface` (re-reading its live phases/tasks every iteration so a mid-run `add` lands). |
| `WorkflowPersistence` | class | Advanced runner-owned one-writer durability infrastructure, normally composed through `execute({ store })`; implements `WorkflowPersistenceInterface`.                                                                                                                                                                                                                                              |
| `Runner`              | class | The substrate orchestrator over a set of units — drives a `Queue`, ordered result aggregation, fail-fast, `pause` / `resume` / graceful `stop`, one-shot.                                                                                                                                                                                                                                           |
| `Controller`          | class | The per-unit handle a `Runner` handler receives — `id` / `input` / `signal` + `wait` / `spawn` / `abort`.                                                                                                                                                                                                                                                                                           |
| `TaskController`      | class | The attempt-scoped handle — folded cancellation and pause state, activity checkpoints, input/lineage, and read-up results.                                                                                                                                                                                                                                                                          |

### Scheduler (pacing)

The cooperative host-yield primitive that paces the engine between phases: a loop decides WHAT to do; the scheduler decides WHEN the host regains control. Every backend delegates setup, exact settlement, caller cancellation, and handle cleanup to the exported `scheduleHost` lifecycle helper. It links an owned native composite to the optional caller signal before host work is armed, so patched caller listener methods cannot strand a wait, pre-abort schedules nothing, and the first completion, exact host failure, or exact caller reason settles once. A returned cancellation closure is cleanup only: even if it throws during a later caller abort or host failure, the already-winning exact reason still settles the promise without escaping or hanging.

```ts
import { scheduleHost } from '@orkestrel/workflow'

const controller = new AbortController()
await scheduleHost((complete) => {
	const handle = setTimeout(complete, 0)
	return () => clearTimeout(handle)
}, controller.signal)
```

| API         | Kind  | Summary                                                                                      |
| ----------- | ----- | -------------------------------------------------------------------------------------------- |
| `Scheduler` | class | The cross-environment cooperative-yield default — `yield` / `delay` over `setTimeout` alone. |

### Environment backends

Beyond the cross-environment default, each host has a native cooperative-yield primitive a `yield()` should reach for. The backends are standalone `SchedulerInterface` implementations that retain only feature detection and native start/cancel boundaries; `scheduleHost` is the one shared lifecycle. A pending `yield` / `delay` rejects with `signal.reason` _verbatim_, an already-aborted signal rejects with that same reason before arming, a signal that is not a native `AbortSignal` rejects before arming with a `WorkflowError` carrying the `SCHEDULE` code, caller signal method mutation is harmless, cancellation clears the returned handle once, cancellation-closure failure is contained after the winner is captured, and native composite arbitration prevents late completion, abort, or failure from resettling. Each backend's `delay(ms)` is a real `setTimeout`; only the `yield` primitive differs.

The **Node** backend ships in [`src/server`](../src/server), published through `@orkestrel/workflow/server`. `NodeScheduler.yield()` waits on `setImmediate` — the canonical Node "give the event loop a turn", running after the current operation and pending I/O. It deliberately does **not** use `node:timers/promises` (whose `{ signal }` option rejects with a Node `AbortError`, `code: 'ABORT_ERR'`, _not_ the caller's `reason`); its `setImmediate` / `setTimeout` boundaries compose `scheduleHost` to preserve the caller reason. `priority` is accepted but a no-op — Node has no priority primitive.

The **browser** backends ship in [`src/browser`](../src/browser), published through `@orkestrel/workflow/browser`, one per host-turn strategy. All three feature-detect their native API through `@orkestrel/contract` guards (`isRecord` / `isFunction`), never an `as` (AGENTS §14), and fall back to a real macrotask where it is absent:

- `BrowserScheduler.yield()` posts to the **Prioritized Task Scheduling API** (`scheduler.postTask`) at the mapped priority (`user` → `'user-blocking'`, `normal` → `'user-visible'`, `background` → `'background'`) — so the urgency hint is honoured — falling back to a `setTimeout(0)` macrotask where `scheduler.postTask` is absent (Firefox today). The caller's `signal` is **not** handed to `postTask` (whose own abort rejects with a platform `AbortError`, not the caller's `reason`); an internal controller cancels the posted task while the scheduler rejects with the verbatim caller reason, and an unexpected native promise rejection remains the exact host failure.
- `FrameScheduler.yield()` resumes just before the next paint via `requestAnimationFrame` (and `cancelAnimationFrame` on abort) — for work that should batch per render frame and naturally pause while the tab is hidden. `priority` is a no-op.
- `IdleScheduler.yield()` resumes when the host is idle via `requestIdleCallback` (and `cancelIdleCallback` on abort), falling back to a `setTimeout(0)` macrotask where it is absent (Safari today) — for low-priority background work that must not contend with rendering or input. `priority` is a no-op.

| API                | Kind  | Summary                                                                                                                               |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `NodeScheduler`    | class | The Node backend — `yield` over `setImmediate`, verbatim abort fidelity through `scheduleHost`; priority a no-op.                     |
| `BrowserScheduler` | class | The browser backend — `yield` over `scheduler.postTask` at the mapped priority, falling back to a macrotask; verbatim abort fidelity. |
| `FrameScheduler`   | class | The frame-aligned browser backend — `yield` over `requestAnimationFrame` (resume before paint); priority a no-op; verbatim abort.     |
| `IdleScheduler`    | class | The idle-time browser backend — `yield` over `requestIdleCallback`, falling back to a macrotask; priority a no-op; verbatim abort.    |

| API                      | Kind     | Summary                                                                                                 |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------- |
| `createNodeScheduler`    | function | Create the Node-native `SchedulerInterface` (`yield` over `setImmediate`).                              |
| `createBrowserScheduler` | function | Create the browser-native `SchedulerInterface` (`yield` over `scheduler.postTask`, macrotask fallback). |
| `createFrameScheduler`   | function | Create the frame-aligned `SchedulerInterface` (`yield` over `requestAnimationFrame`).                   |
| `createIdleScheduler`    | function | Create the idle-time `SchedulerInterface` (`yield` over `requestIdleCallback`, macrotask fallback).     |

The browser backends also publish two supporting members through `@orkestrel/workflow/browser`: the `POST_TASK_PRIORITY` map `BrowserScheduler` reads to translate a portable `SchedulerPriority` into a `scheduler.postTask` priority level, and the `IdleAPI` shape of the feature-detected `requestIdleCallback` / `cancelIdleCallback` pair `IdleScheduler` narrows to (or resolves to `undefined`, falling back to a macrotask).

| Type      | Kind      | Shape                                                                                                            |
| --------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `IdleAPI` | interface | `{ request: (callback) => number; cancel: (handle) => void }` — the feature-detected `requestIdleCallback` pair. |

| API                  | Kind  | Summary                                                                                                                                               |
| -------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST_TASK_PRIORITY` | const | The `SchedulerPriority` → `scheduler.postTask` priority map (`user` → `'user-blocking'`, `normal` → `'user-visible'`, `background` → `'background'`). |

Each backend is a standalone `implements SchedulerInterface`, so its public methods are exactly `yield` / `delay` — the same [Methods](#methods) table below governs every one (AGENTS §22).

### Stores

The durable persistence seam (W-d) — a DUAL-store convention (the `QueueStore` / `SessionStore` pattern). A `WorkflowStoreInterface` persists the pure-JSON `WorkflowSnapshot` keyed by workflow id through two interchangeable backends: `MemoryWorkflowStore` (a plain `Map`, the zero-plumbing DEFAULT, `createMemoryWorkflowStore`) and `DatabaseWorkflowStore` (the opt-in, driver-pluggable twin over a `databases` table, the snapshot stored as ONE OPAQUE JSON column, `createDatabaseWorkflowStore`). Both live under `src/core/stores/`. The Database store's driver DEFAULTS to memory, so it ALSO works in memory out of the box; you opt into the durable plumbing (JSON / SQLite / IndexedDB) by passing a driver — and it swaps in through the SAME interface, without touching the engine or the entity tree. Restore stays the shipped `createRestoredWorkflow`.

| Class                   | Kind  | Role                                                                                                                                    |
| ----------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryWorkflowStore`   | class | The in-memory default `WorkflowStoreInterface` — a process-lifetime `Map` of `WorkflowSnapshot`s by id; NO TTL (durable until delete).  |
| `DatabaseWorkflowStore` | class | The driver-pluggable twin `WorkflowStoreInterface` — wraps a `databases` table, the snapshot one opaque JSON column (driver-swappable). |

### Registry

The additive manager tier (§9 + the `@orkestrel/agent` line's store standard): `WorkflowManager` (`createWorkflowManager`) is an insertion-ordered registry of live `WorkflowInterface`s keyed by `id`, mirroring `ConversationManager` / `WorkspaceManager` — with the SAME optional `store` seam (`open` hydrates on a registry miss, `save` persists) BUT no `active` / `switch` pointer (nothing in this domain renders "the current workflow"). The workflow-specific nuance: the manager also carries an optional `functions` registry threaded into every mint (`add`, via `createWorkflow`) AND every hydrate (`open`, via `createRestoredWorkflow`). With functions, named work is runnable; without them, exact hydrated state remains inspectable and execution refuses unresolved names.

| Class             | Kind  | Role                                                                                                                                                  |
| ----------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowManager` | class | The store-backed registry of live workflows — insertion-ordered `add` / `workflow` / `workflows` / `count` / `remove` / `clear` PLUS `open` / `save`. |

### Errors

| API               | Kind     | Summary                                                                                                                                  |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowError`   | class    | Carries a `WorkflowErrorCode` (`TRANSITION` / `RESTORE` / `MUTATION` / `SCHEDULE`) + an optional `context` naming the node or parameter. |
| `isWorkflowError` | function | Narrow an unknown caught value to a `WorkflowError`.                                                                                     |

Every error this package raises for a refused operation of its own is a `WorkflowError`, narrowable with `isWorkflowError`. Four values are deliberately NOT translated and reach the caller unchanged: a value thrown by a consumer-supplied `WorkflowFunction`, a value thrown or rejected by a consumer-supplied `WorkflowStoreInterface`, a value thrown by the `start` closure a caller hands `scheduleHost` or reported through its `failure` callback, and the `reason` an `AbortSignal` carries — a pending wait rejects with that reason verbatim, which is what makes cancellation identity-preserving. Those four are caller-owned values the package passes through on purpose, not package faults it failed to wrap.

Two dependency-owned errors still reach callers untranslated. These are known gaps, not intended pass-throughs: `createRunner` surfaces `@orkestrel/queue`'s `QueueError` for an invalid `concurrency` / `retries` / `timeout`, and `createDatabaseWorkflowStore`'s `get` / `set` / `delete` surface `@orkestrel/database`'s `DatabaseError`. Until they are folded into `WorkflowError`, narrow them with the owning package's own guard rather than `isWorkflowError`.

### Helpers & guards

Centralized, exhaustively unit-tested helpers and guards (AGENTS §4.3 / §14). The status derivations are pure and encode the §10 / §14 truth tables; the lineage / snapshot builders seed the entity tree; `scheduleHost` owns the scheduler's intentionally effectful host lifecycle.

Generic exact-JSON ownership comes directly from [`@orkestrel/contract`](contract.md):
consumers import its `JSONRecord`, `cloneJSONValue`, and `cloneJSONRecord` from their
originating package. Workflow does not re-export them. Its domain cloners below add
workflow-specific validation and translate ownership failures into `WorkflowError`.

| API                         | Kind     | Behavior                                                                                                                                     |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloneWorkflowSnapshot`     | function | Deep-own and semantically validate a hostile snapshot before live construction or persistence.                                               |
| `isWorkflowSnapshot`        | function | Total hostile-boundary guard for a coherent, exact-JSON `WorkflowSnapshot`.                                                                  |
| `isOwnedWorkflowSnapshot`   | function | Validate the semantics of an already-owned exact-JSON snapshot graph.                                                                        |
| `isLifecycleStatus`         | function | Narrow a value to the shared lifecycle vocabulary.                                                                                           |
| `isTaskFailure`             | function | Narrow a value to normalized JSON-safe task failure data.                                                                                    |
| `isTaskResult`              | function | Validate a boxed result and its full lineage against its containing snapshot nodes.                                                          |
| `matchesDescription`        | function | Compare two optional description values without inventing an absence sentinel.                                                               |
| `hasWorkflowHandlers`       | function | Whether every snapshot run resolves to a once-read callable registry binding, or every live named task already carries a callable handler.   |
| `workflowSnapshotContext`   | function | Locate the nearest identifiable phase/task for an inconsistent snapshot diagnostic.                                                          |
| `isTerminalStatus`          | function | Whether a `LifecycleStatus` is terminal — the ONE check across all three tiers (`completed` / `failed` / `skipped` / `stopped`).             |
| `derivePhaseStatus`         | function | Derive a `PhaseStatus` from its tasks' statuses (order-insensitive; most-severe terminal wins; `bail`-agnostic).                             |
| `deriveWorkflowStatus`      | function | Derive a `WorkflowStatus` from its phases' statuses UNDER `bail` (`failed` reachable only when `bail: true`).                                |
| `deriveBoundary`            | function | Derive the PENDING SUFFIX boundary from a positional statuses list — the index of the first `pending` entry (or `length` if none).           |
| `canTransitionTask`         | function | Whether the live task state machine may move from one `TaskStatus` to another (reads `TASK_TRANSITIONS`).                                    |
| `resolveTaskSilence`        | function | Resolve a task override against the workflow default to a host-safe `1..MAX_TIMER_MS` window or `undefined`.                                 |
| `cloneTaskActivity`         | function | Validate, clone, and freeze one activity frame; stamps or restores `updated` without double-reading input.                                   |
| `isTaskActivityInput`       | function | Total guard for a reporter frame, including progress bounds, unique ids, hostile getters, and proxies.                                       |
| `isTaskActivity`            | function | Total guard for persisted activity, including finite non-negative `updated`; never throws on hostile input.                                  |
| `captureWorkflowOptions`    | function | Capture every root `WorkflowOptions` property once into an owned plain bag while retaining nested bag and function-registry identities.      |
| `scheduleHost`              | function | Reject an invalid `signal` (`SCHEDULE`); link an owned settlement composite before host setup; keep the exact winner; contain cleanup.       |
| `success`                   | function | Box a value as a `Success` — the graceful outcome half of a `Result` (`{ success: true, value }`).                                           |
| `failure`                   | function | Box an error as a `Failure` — the graceful outcome half of a `Result` (`{ success: false, error }`).                                         |
| `errorToMessage`            | function | Normalize an unknown thrown value to a non-empty persistence-safe message.                                                                   |
| `findFailure`               | function | Find the first `TaskResult` in a positional list whose boxed outcome is a `Failure`, or `undefined` if none.                                 |
| `buildWorkflowContext`      | function | Build a `WorkflowContext` (the identity every level inherits) from a node's `id` / `name` / optional `description`.                          |
| `buildPhaseContext`         | function | Build a `PhaseContext` (own identity + the workflow back-reference) from the parent context + a phase node.                                  |
| `buildTaskContext`          | function | Build a `TaskContext` (own identity + the phase back-reference) from the parent phase context + a task node.                                 |
| `definitionToSnapshot`      | function | Convert a `WorkflowDefinition` into an INITIAL all-`pending` `WorkflowSnapshot` — the unified construction path.                             |
| `phaseDefinitionToSnapshot` | function | Convert one `PhaseDefinition` into an initial all-`pending` `PhaseSnapshot` (the per-phase step).                                            |
| `taskDefinitionToSnapshot`  | function | Convert one `TaskDefinition` into an initial `pending` `TaskSnapshot` (the per-task leaf step — no result, empty metadata).                  |
| `recoverWorkflowSnapshot`   | function | Project interrupted running work onto its remaining budget without replenishing attempts.                                                    |
| `collectResults`            | function | Flatten per-phase `TaskResult` lists into one positional list — the workflow tier of the result tree.                                        |
| `parkSignal`                | function | Park until `signal` aborts — a promise that resolves on the abort event, never rejects (a one-shot listener, self-removing).                 |
| `insertEntry`               | function | Insert a `[key, value]` entry at `index` in a readonly entries array — the pure splice step behind an insertion-ordered registry's `add`.    |
| `moveEntry`                 | function | Reposition the entry keyed `key` to a new index in a readonly entries array — the pure remove-then-reinsert step behind a registry's `move`. |

Every exported `is*` guard is total over every traversed argument. In particular,
`isTaskFailure`, `isTaskResult`, and `isOwnedWorkflowSnapshot` contain throwing
`ownKeys`, accessors, prototype traps, and revoked proxies and return `false`.

The exact snapshot boundary is also available as composable public leaves:

```ts
import {
	cloneWorkflowSnapshot,
	createWorkflow,
	errorToMessage,
	hasWorkflowHandlers,
	isLifecycleStatus,
	isOwnedWorkflowSnapshot,
	isTaskFailure,
	isTaskResult,
	matchesDescription,
	recoverWorkflowSnapshot,
	workflowSnapshotContext,
} from '@orkestrel/workflow'

const functions = { work: () => null }
const workflow = createWorkflow(
	{
		id: 'boundary',
		name: 'Boundary',
		phases: [
			{
				id: 'phase',
				name: 'Phase',
				tasks: [{ id: 'task', name: 'Task', run: 'work', retries: 1 }],
			},
		],
	},
	{ functions },
)
const snapshot = cloneWorkflowSnapshot(workflow.snapshot())
const phase = snapshot.phases[0]
const task = phase?.tasks[0]

isOwnedWorkflowSnapshot(snapshot)
isLifecycleStatus(snapshot.status)
isTaskFailure({ origin: 'handler', message: 'provider failed' })
if (phase !== undefined && task !== undefined) {
	isTaskResult(task.result, snapshot, phase, task)
}
matchesDescription(snapshot.description, workflow.description)
hasWorkflowHandlers(snapshot, functions)
workflowSnapshotContext({ ...snapshot, bail: 'invalid' })
errorToMessage(new Error('provider failed'))
recoverWorkflowSnapshot(snapshot)
```

```ts
import {
	cloneTaskActivity,
	isTaskActivity,
	isTaskActivityInput,
	resolveTaskSilence,
} from '@orkestrel/workflow'

const input = { progress: { current: 2, total: 10, unit: 'files' } }
if (isTaskActivityInput(input)) {
	const activity = cloneTaskActivity(input, Date.now())
	isTaskActivity(activity) // true
}
resolveTaskSilence(0, 30_000) // undefined: the task explicitly disables inheritance
```

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
| `MAX_TIMER_MS`              | const | The largest host-safe timer delay (`2_147_483_647` milliseconds).                                                  |

### Types

| Type                           | Kind      | Shape                                                                                                                                                                                                                                   |
| ------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskDefinition`               | interface | `{ id, name, description?, run?, retries?, timeout? }` — one task's serializable definition (`run` = an optional plain behavior-name string; `retries` / `timeout` are per-task reliability overrides).                                 |
| `PhaseDefinition`              | interface | `{ id, name, description?, tasks, concurrency?, bail? }` — ordered tasks (concurrent) + an optional throttle + an optional per-phase `bail` override.                                                                                   |
| `WorkflowDefinition`           | interface | `{ id, name, description?, phases, bail? }` — the root a UI/LLM authors and the contract validates.                                                                                                                                     |
| `WorkflowContext`              | interface | `{ id, name, description? }` — the ambient identity every level inherits (the context chain's root).                                                                                                                                    |
| `PhaseContext`                 | interface | `WorkflowContext` + `{ workflow }` — a phase's identity plus the back-reference UP the tree.                                                                                                                                            |
| `TaskContext`                  | interface | `WorkflowContext` + `{ phase }` — a task's identity plus its full lineage (workflow → phase → task).                                                                                                                                    |
| `WorkflowInput`                | type      | `Partial<WorkflowContext>` — the minimal data to create a workflow context.                                                                                                                                                             |
| `PhaseInput`                   | type      | `Partial<PhaseContext>` — the minimal data to create a phase context.                                                                                                                                                                   |
| `TaskInput`                    | interface | `Partial<TaskContext>` + `{ metadata? }` — plus the open consumer bag stored + snapshotted, never interpreted.                                                                                                                          |
| `TaskProgress`                 | interface | `{ current, total?, unit? }` — determinate progress when `total` is present, otherwise an indeterminate current count.                                                                                                                  |
| `TaskOperation`                | interface | `{ id, name, started }` — one flat nested operation claimed active when the complete frame was accepted.                                                                                                                                |
| `TaskConstraint`               | interface | `{ id, name, started }` — one constraint claimed active when the complete frame was accepted, without supervisor policy.                                                                                                                |
| `TaskActivityInput`            | interface | `{ note?, progress?, operations?, constraints? }` — one whole-frame replacement; omitted collections mean empty.                                                                                                                        |
| `TaskActivity`                 | interface | `TaskActivityInput` normalized to required readonly collections plus `{ updated }`; the last accepted reporter claim.                                                                                                                   |
| `TaskUpdate`                   | interface | `{ name?, description? }` — a declarative partial edit to a `pending` task, accepted by `TaskInterface.patch` / `TaskManagerInterface.update`.                                                                                          |
| `PhaseUpdate`                  | interface | `{ name?, description?, concurrency?, bail? }` — a declarative partial edit to a `pending` phase, accepted by `PhaseInterface.patch` / `PhaseManagerInterface.update`.                                                                  |
| `WorkflowErrorCode`            | type      | `'TRANSITION' \| 'RESTORE' \| 'MUTATION' \| 'SCHEDULE'` — the machine-readable code of a `WorkflowError` (`MUTATION` = a refused structural/patch edit; `SCHEDULE` = an invalid-signal host schedule refusal).                          |
| `LifecycleStatus`              | type      | `'pending' \| 'running' \| 'completed' \| 'failed' \| 'skipped' \| 'stopped'` — the ONE vocabulary the three tiers alias.                                                                                                               |
| `TaskStatus`                   | type      | A semantic tier of `LifecycleStatus` — a task's lifecycle status.                                                                                                                                                                       |
| `PhaseStatus`                  | type      | A semantic tier of `LifecycleStatus` — a phase's status, derived from its tasks.                                                                                                                                                        |
| `WorkflowStatus`               | type      | A semantic tier of `LifecycleStatus` — a workflow's status, derived from its phases under `bail`.                                                                                                                                       |
| `PhaseDerivation`              | interface | `{ status, bail }` — one phase's contribution to the workflow-status derivation (its status + the EFFECTIVE bail it ran under); the input shape of `deriveWorkflowStatus`.                                                              |
| `TaskFailureOrigin`            | type      | `'handler' \| 'timeout' \| 'recovery'` — the persisted axis identifying where a task failure arose.                                                                                                                                     |
| `TaskFailure`                  | interface | `{ origin, message }` — JSON-safe failure data.                                                                                                                                                                                         |
| `TaskResult`                   | interface | `{ task, phase, workflow, status, result?, timestamp }` — lineage + `Result<JSONValue, TaskFailure>` (present for `completed` / `failed`).                                                                                              |
| `TaskSnapshot`                 | interface | `{ id, name, description?, status, result?, metadata, attempts, run?, retries?, timeout?, activity? }` — owns its JSON graph and persists consumed launches.                                                                            |
| `PhaseSnapshot`                | interface | `{ id, name, description?, status, override?, bail, concurrency?, tasks }` — `bail` + `concurrency` are the effective per-phase policy/throttle (both persisted); `override` present only when a whole-phase `skip` / `stop` forced it. |
| `WorkflowSnapshot`             | interface | `{ id, name, description?, status, override?, bail, phases, created, updated }` — the COMPLETE self-contained durable payload.                                                                                                          |
| `WorkflowStoreInterface`       | interface | The durable persistence seam — async `get` / `set` / `delete` over a `WorkflowSnapshot` by id (the `SessionStore` driver-swap pattern; no TTL).                                                                                         |
| `WorkflowSnapshotRow`          | interface | `{ id, snapshot }` — one row of the `DatabaseWorkflowStore` table, the snapshot held as one opaque JSON column (`unknown`, narrowed on `get`); keeps the row flat to dodge TS2589.                                                      |
| `WorkflowEventMap`             | type      | The workflow's §13 push surface — lifecycle includes `start(id)` · `complete()` · `fail(result)` · `pause()` · `resume()` · `skip()` · `stop()` plus structural events.                                                                 |
| `PhaseEventMap`                | type      | The phase's §13 push surface — lifecycle includes `start(id)` · `complete()` · `fail(result)` · `pause()` · `resume()` · `skip()` · `stop()` plus structural events.                                                                    |
| `TaskEventMap`                 | type      | The task's ten-event push surface — `start` · `complete` · `fail` · `pause` · `resume` · `skip` · `stop` · `report` · `pulse` · `silence`.                                                                                              |
| `WorkflowHooks`                | type      | `EmitterHooks<WorkflowEventMap>` — initial workflow listeners (the reserved `on` option).                                                                                                                                               |
| `PhaseHooks`                   | type      | `EmitterHooks<PhaseEventMap>` — initial phase listeners.                                                                                                                                                                                |
| `TaskHooks`                    | type      | `EmitterHooks<TaskEventMap>` — initial task listeners.                                                                                                                                                                                  |
| `TaskOptions`                  | interface | `{ on?, error?, metadata?, silence? }` — runtime task construction; a value outside `1..MAX_TIMER_MS` disables inheritance.                                                                                                             |
| `PhaseOptions`                 | interface | `{ on?, error?, tasks? }` — the live phase's bag; `tasks` keys per-task `TaskOptions` by id.                                                                                                                                            |
| `WorkflowOptions`              | interface | `{ on?, bail?, error?, phases?, functions?, silence? }` — live workflow construction plus the runtime-only default task silence window.                                                                                                 |
| `WorkflowInterface`            | interface | The live DERIVED root entity — `emitter` / `status` / `bail` / `phases` / `paused` / `destroyed` / `signal` + the methods (see [Methods](#workflowinterface)).                                                                          |
| `PhaseInterface`               | interface | The live DERIVED phase entity — `emitter` / `status` / `bail` / `concurrency` / `paused` / `tasks` + the methods (see [Methods](#phaseinterface)).                                                                                      |
| `TaskInterface`                | interface | The live leaf entity — lifecycle plus persisted `attempts`, activity/liveness, cooperative `paused`, and task-owned `signal`; see [Methods](#taskinterface).                                                                            |
| `TaskManagerInterface`         | interface | The lean tasks manager — `count` + `append` / `add` / `remove` / `move` / `update` / `task` / `tasks`.                                                                                                                                  |
| `PhaseManagerInterface`        | interface | The lean phases manager — `count` + `append` / `add` / `remove` / `move` / `update` / `phase` / `phases`.                                                                                                                               |
| `WorkflowFunction`             | type      | `(controller: TaskControllerInterface) => Promise<JSONValue> \| JSONValue` — the JSON-safe behavior a named task runs.                                                                                                                  |
| `WorkflowFunctions`            | type      | `Readonly<Record<string, WorkflowFunction>>` — every present `run` name must resolve before execution; exact restore may remain inspectable without it.                                                                                 |
| `TaskControllerInterface`      | interface | The attempt-scoped handle — persisted one-based `attempt`, folded `signal`, `paused`, activity checkpoints, lineage, JSON input, and read-up results.                                                                                   |
| `WorkflowResult`               | interface | `{ workflow, status, results, durable?, fault? }` — live result plus final persistence outcome when a store was supplied.                                                                                                               |
| `WorkflowCheckpoint`           | type      | `'initial' \| 'attempt' \| 'settlement' \| 'final'` — the required durability boundaries.                                                                                                                                               |
| `WorkflowFault`                | interface | Normalized first required persistence failure with checkpoint, message, and optional task/attempt identity.                                                                                                                             |
| `WorkflowPersistenceInterface` | interface | Advanced run-local durability coordinator — readonly `fault` plus required `checkpoint`, `finalize`, and `detach`; normally runner-owned.                                                                                               |
| `WorkflowRunOptions`           | type      | `WorkflowOptions` + `{ signal?, timeout?, budget?, store? }` — construction, bounds, and optional run-owned durability.                                                                                                                 |
| `WorkflowRunnerOptions`        | interface | `{ scheduler? }` — the PURE engine's only option (pacing); a task resolves its own `handler` at construction.                                                                                                                           |
| `WorkflowRunnerInterface`      | interface | The PURE-engine orchestrator — `execute(definition, options?)` builds + drives a live tree to a `WorkflowResult`; `execute(workflow, options?)` drives an already-built, caller-owned live tree instead.                                |
| `WorkflowManagerOptions`       | interface | `{ store?, functions? }` — the optional durable store plus the optional registry that makes hydrated named work runnable; omission remains inspectable.                                                                                 |
| `WorkflowManagerInterface`     | interface | The store-backed registry — `count` + `workflow` / `workflows` + the methods (see [Methods](#workflowmanagerinterface)); NO `active` / `switch` (unlike its `ConversationManager` / `WorkspaceManager` twins).                          |
| `SchedulerPriority`            | type      | `'user' \| 'normal' \| 'background'` — a relative urgency hint (uniform in the default; backends honour it).                                                                                                                            |
| `SchedulerOptions`             | interface | `{ priority?: SchedulerPriority; signal?: AbortSignal }` — options for a single `yield` / `delay`.                                                                                                                                      |
| `SchedulerInterface`           | interface | The `yield` / `delay` cooperative-yield methods.                                                                                                                                                                                        |
| `ControllerInterface`          | interface | The per-unit handle a runner handler receives — `id` / `input` / `signal` / `aborted` data members + `wait` / `spawn` / `abort` methods.                                                                                                |
| `RunnerHandler`                | type      | `(controller) => Promise<TResult> \| TResult` — runs one unit's work against its `Controller`.                                                                                                                                          |
| `RunnerOptions`                | interface | `createRunner` options — `handler` + strict Queue values: positive-safe-integer `concurrency?`, nonnegative-safe-integer `retries?`, integer `timeout?` in `0..2_147_483_647` (`0` disables), plus `entries?` / `on?` / `error?`.       |
| `RunnerEntryOptions`           | interface | The per-entry reliability overrides for one unit — `{ retries?, timeout? }`, resolved from its input via `entries`.                                                                                                                     |
| `RunnerInterface`              | interface | `emitter` / `active` / `stopped` / `paused` data members + `execute` / `spawn` / `abort` / `pause` / `resume` / `stop` / `destroy` methods.                                                                                             |
| `RunnerEventMap`               | type      | The `Runner`'s observable events — `start` / `unit` / `spawn` / `settle` / `fail` / `finish` / `abort`.                                                                                                                                 |
| `RunnerUnit`                   | interface | One tracked unit's queue payload — `id` (keys its order + value) + `input` (the handler's work).                                                                                                                                        |
| `UnitOutcome`                  | type      | One unit's settled outcome — `{ ok: true; value }` \| `{ ok: false; error }`, so `undefined` is still a success.                                                                                                                        |
| `DeferredInterface`            | interface | `{ promise, resolve, reject }` — a promise whose settlement is driven externally, e.g. for deterministic async test scenarios.                                                                                                          |

## Methods

The public methods of each behavioral interface — one table per type, keyed by its backticked name, every call-signature member listed. Its `readonly` data members stay in the Surface rows above (`emitter` is the typed [§13](emitter.md) push surface — see [Observing the live tree](#observing-the-live-tree); `status` / `result` / `context` / `signal` / `aborted` / `input` / `task` / `count` are read-state). Each entity and substrate class implements its interface exactly, so this doubles as the per-instance method surface (AGENTS §22).

#### `WorkflowInterface`

The live DERIVED root. `status` is the override-or-derived workflow status (read-state, in the Surface row); the methods navigate down (`phase`), collect the result tree (`results`), force a terminal state (`skip` / `stop` / `complete`), pause/resume/park the run (`pause` / `resume` / `wait`), tear it down (`destroy`), mutate its pending-suffix phases (`add` / `remove` / `move` / `update`), and serialize (`snapshot`).

| Method     | Returns                                 | Behavior                                                                                                                                                                     |
| ---------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phase`    | `PhaseInterface \| undefined`           | Look up one live phase by its `id`.                                                                                                                                          |
| `results`  | `readonly TaskResult[]`                 | Every settled task's result across all phases, in positional order.                                                                                                          |
| `skip`     | `void`                                  | FORCE the workflow `skipped`, emit `skip` exactly once, and persist the override; terminal calls are no-ops.                                                                 |
| `stop`     | `void`                                  | FORCE the workflow `stopped` (emits `stop`).                                                                                                                                 |
| `complete` | `void`                                  | FORCE `completed` only for a pending vacuous tree (zero tasks anywhere); pending work and all other states are unchanged.                                                    |
| `pause`    | `void`                                  | Suspend the workflow (RUNTIME-ONLY, resumable, idempotent); a no-op once terminal or `destroyed`.                                                                            |
| `resume`   | `void`                                  | Continue a paused workflow (idempotent); releases any parked `wait`.                                                                                                         |
| `destroy`  | `void`                                  | Atomic teardown — pins stopped overrides, stops non-terminal tasks/phases, releases waiters/timers, aborts `signal`, then destroys descendant and root emitters; idempotent. |
| `wait`     | `Promise<void>`                         | Park until not `paused` — promise-parked, resolves immediately when unpaused; NEVER rejects.                                                                                 |
| `add`      | `Result<PhaseInterface, WorkflowError>` | MINT a live phase from a `PhaseDefinition` and insert it within the pending suffix; a `MUTATION` failure when refused.                                                       |
| `remove`   | `Result<PhaseInterface, WorkflowError>` | Remove the `pending` phase `id` (within the pending suffix); a `MUTATION` failure when refused.                                                                              |
| `move`     | `Result<PhaseInterface, WorkflowError>` | Reposition the `pending` phase `id` to `index`; a `MUTATION` failure when refused.                                                                                           |
| `update`   | `Result<PhaseInterface, WorkflowError>` | Apply a validated `PhaseUpdate` patch to the `pending` phase `id`; a `MUTATION` failure when refused.                                                                        |
| `snapshot` | `WorkflowSnapshot`                      | Serialize the whole live tree to a pure-JSON `WorkflowSnapshot`.                                                                                                             |

#### `PhaseInterface`

The live DERIVED middle tier. `status` is derived from its tasks (override-or-derived).

| Method     | Returns                                | Behavior                                                                                                                                     |
| ---------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `task`     | `TaskInterface \| undefined`           | Look up one live task by its `id`.                                                                                                           |
| `results`  | `readonly TaskResult[]`                | The settled tasks' results, in positional order (the phase tier).                                                                            |
| `skip`     | `void`                                 | FORCE the phase `skipped` and emit `skip` exactly once; terminal calls are no-ops.                                                           |
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

| Method     | Returns                               | Behavior                                                                                                                                                                         |
| ---------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`    | `void`                                | Launch the next persisted attempt (`pending` or retrying `running`), reset activity, emit `start`, then cascade.                                                                 |
| `complete` | `void`                                | `running → completed`; boxes a `JSONValue` as a `Success`, emits `complete`.                                                                                                     |
| `fail`     | `void`                                | `running → failed`; boxes a normalized `TaskFailure`, emits `fail`.                                                                                                              |
| `skip`     | `void`                                | → `skipped` (intentionally not run); emits `skip`.                                                                                                                               |
| `stop`     | `void`                                | → `stopped`, fires the task-owned signal, releases its gate, and emits `stop`.                                                                                                   |
| `report`   | `Result<TaskActivity, WorkflowError>` | While running, validate and atomically replace the whole frame, stamp `updated`, rearm silence, and emit `report`; invalid input is `MUTATION`, wrong lifecycle is `TRANSITION`. |
| `pulse`    | `boolean`                             | While running, restamp the existing frame, rearm silence, and emit `pulse`; `false` when refused.                                                                                |
| `pause`    | `void`                                | Close this task's cooperative gate while pending or running; idempotent.                                                                                                         |
| `resume`   | `void`                                | Open the task gate and release parked waiters; idempotent.                                                                                                                       |
| `wait`     | `Promise<void>`                       | Park only on this task's gate; never polls or rejects.                                                                                                                           |
| `patch`    | `void`                                | Apply a validated `TaskUpdate` to SELF (`name`/`description`); throws `MUTATION` unless `pending`.                                                                               |
| `snapshot` | `TaskSnapshot`                        | Serialize identity, status, result, owned metadata, consumed `attempts`, reliability config, and activity.                                                                       |

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

| Method    | Returns                   | Behavior                                                                                                                                                                                   |
| --------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `execute` | `Promise<WorkflowResult>` | TWO overloads: build-and-drive a definition, or synchronously claim and drive a fresh live workflow once across all runner instances. Both run phases sequentially and tasks concurrently. |

#### `WorkflowPersistenceInterface`

`fault` is read-state: the first required checkpoint failure, if one occurred. `WorkflowPersistence` implements this interface exactly and is advanced runner-owned infrastructure normally reached through `execute({ store })`.

| Method       | Returns            | Behavior                                                                                                   |
| ------------ | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `checkpoint` | `Promise<boolean>` | Make the latest live state durable at an `initial`, `attempt`, `settlement`, or `final` required boundary. |
| `finalize`   | `Promise<boolean>` | Detach observers, drain the latest obligation, and report whether the final live state reached the store.  |
| `detach`     | `void`             | Stop observing workflow, phase, and task events; idempotent.                                               |

```ts
import { WorkflowPersistence, createMemoryWorkflowStore, createWorkflow } from '@orkestrel/workflow'

const workflow = createWorkflow({ id: 'durable', name: 'Durable', phases: [] })
const persistence = new WorkflowPersistence(workflow, createMemoryWorkflowStore())
await persistence.checkpoint('initial')
const durable = await persistence.finalize()
persistence.detach() // idempotent after finalize
```

#### `WorkflowManagerInterface`

The store-backed registry (§9 + the store standard) — `count` is read-state (in the Surface row). `add` mints from a `WorkflowDefinition` (flowing the manager's `functions` in); `open` / `save` are the optional `store` seam. Hydration also flows `functions` when present; without them, named work remains inspectable but non-drivable.

| Method      | Returns                                   | Behavior                                                                                                                                                                                           |
| ----------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow`  | `WorkflowInterface \| undefined`          | Look up one registered workflow by `id`.                                                                                                                                                           |
| `workflows` | `readonly WorkflowInterface[]`            | List the registered workflows in insertion order.                                                                                                                                                  |
| `add`       | `WorkflowInterface`                       | MINT a live workflow from a `WorkflowDefinition` (via `createWorkflow`, flowing `functions` in) and register it under `definition.id`; an already-registered id OVERWRITES.                        |
| `open`      | `Promise<WorkflowInterface \| undefined>` | Resolve a registered workflow directly, else reserve and coalesce the same-id promise before store access; registry mutation wins pending-read races and wrong-key payloads reject with `RESTORE`. |
| `save`      | `Promise<boolean>`                        | Capture the snapshot and reserve the same-id write before store access; serialize same-id writes in call order while different ids remain independent.                                             |
| `remove`    | `boolean`                                 | Drop one by `id`, or a batch by `readonly string[]` (§9.2, array overload first); `true` when any was removed.                                                                                     |
| `clear`     | `void`                                    | Empty the registry.                                                                                                                                                                                |

#### `TaskControllerInterface`

The attempt-scoped handle a `WorkflowFunction` receives. `signal` / `aborted` / JSON `input` / `task` / persisted one-based `attempt` / `paused` are read-state. Its activity closures refuse once its folded signal aborts or a newer retry owns the task.

| Method    | Returns                               | Behavior                                                                                                |
| --------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `report`  | `Result<TaskActivity, WorkflowError>` | Replace activity only while this attempt owns the task and remains un-aborted; refusal is `TRANSITION`. |
| `pulse`   | `boolean`                             | Refresh liveness only while this attempt owns the task and remains un-aborted.                          |
| `wait`    | `Promise<void>`                       | Park on the currently closed workflow, phase, and task gates, raced against cancellation.               |
| `results` | `readonly TaskResult[]`               | Every settled task's result across already-finished phases (read-up, read-only).                        |

#### `SchedulerInterface`

`yield` hands the host a turn (a macrotask, so the host actually runs) and resumes; `delay` resumes after a minimum interval. Both reject with `signal.reason` when an optional `options.signal` aborts.

| Method  | Returns         | Behavior                                                                                                            |
| ------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `yield` | `Promise<void>` | Yield control to the host (a `setTimeout(0)` macrotask, NOT a microtask), then resume. Abort rejects with `reason`. |
| `delay` | `Promise<void>` | Resume after at least `ms` milliseconds. Abort before the deadline rejects with `reason` and clears the timer.      |

#### `RunnerInterface`

`execute` runs the declared units (and their spawns) once and resolves ordered results; `spawn` injects a unit into an in-flight run; `pause` / `resume` / `stop` are the §10 lifecycle verbs (`stop` is a GRACEFUL stop — in-flight finishes, never-dispatched pending entries settle without a fail-fast trip); `abort` / `destroy` remain the hard-cancel verbs. The `active` / `stopped` / `paused` members are Surface rows.

| Method    | Returns                         | Behavior                                                                                                                                                          |
| --------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute` | `Promise<readonly TResult[]>`   | Run all `inputs` and their spawns to completion; resolve results in order (declared first, then spawns). One-shot; fail-fast.                                     |
| `spawn`   | `Promise<TResult> \| undefined` | Inject one more unit into an in-flight `execute` run; returns `undefined` (synchronous, non-throwing) when not started / drained / aborted / stopped / destroyed. |
| `abort`   | `Promise<void>`                 | Cancel every in-flight + pending unit (and the backing queue), await cleanup, and reject a running `execute`; the barrier is stable and idempotent.               |
| `pause`   | `void`                          | Suspend dispatch (RUNTIME-ONLY, resumable); in-flight units finish, the next dispatch parks; a no-op when stopped; idempotent.                                    |
| `resume`  | `void`                          | Continue a paused runner; idempotent.                                                                                                                             |
| `stop`    | `Promise<void>`                 | GRACEFUL permanent stop — no further dispatch; in-flight units finish; never-dispatched pending units settle WITHOUT tripping fail-fast; stable cleanup barrier.  |
| `destroy` | `Promise<void>`                 | Tear down once, awaiting Queue destruction before destroying the Runner emitter last; the barrier is stable and idempotent.                                       |

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

These invariants hold across `src/core` ↔ `workflow.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `const` / `class` / `interface` / `type` row in the `## Surface` tables is a real export of `src/core`, and every export appears as a Surface row — exhaustive, both directions (AGENTS §22).

2. **DOC ↔ SOURCE method bijection.** Every behavioral interface's `## Methods` table lists exactly its public methods (call-signature members) — exhaustive, both directions — and each implementing class (`Workflow` / `Phase` / `Task` / `WorkflowRunner` / `TaskController` / `PhaseManager` / `TaskManager` / `Runner` / `Controller`) exposes exactly its interface's methods, no extra public surface (AGENTS §22). The `readonly` data members (`emitter` / `status` / `result` / `context` / `signal` / `aborted` / `input` / `task` / `attempt` / `attempts` / `count` / `id` / `name` / `description` / `bail` / `phases` / `tasks` / `paused` / `destroyed` / `run` / `handler` / `retries` / `timeout` / `concurrency` / `activity` / `silence` / `silent` / `active` / `stopped`) stay in the Surface rows.

3. **Definition is DATA; the runtime is the tree.** A `WorkflowDefinition → PhaseDefinition → TaskDefinition` is pure JSON — behavior referenced BY NAME through a registry, never inline functions — so it round-trips through `createWorkflowContract` (the LLM-tool-args / boundary-validation / restore / test-fixture spine) and persists unchanged. The `Workflow` / `Phase` / `Task` entity classes are the live mirror BUILT from a definition; the definition interfaces are hand-written (the source of truth, AGENTS §14), and the compiled contract's `is` / `parse` / `generate` narrow to them natively (no `as`) — a `generate → is → parse` round-trip parity test guards against drift between the two.

4. **Determinism is fixed by design.** Tasks within a phase run CONCURRENTLY; phases run SEQUENTIALLY. There is no per-task concurrent/sequential toggle and no dependency machinery — a dependency is structural (a later phase), so the same tree always sequences the same way. The per-phase knobs are `concurrency` (an optional resource THROTTLE — max-in-flight; omitted ⇒ `DEFAULT_PHASE_CONCURRENCY`, effectively unbounded) and `bail` (an optional per-phase failure-policy OVERRIDE; omitted ⇒ inherits the workflow `bail`), never a sequencing control; the per-task knobs are `retries` (extra attempts routed through the substrate) and `timeout` (a workflow-owned per-attempt deadline in `0..MAX_TIMER_MS`). The status derivations (`derivePhaseStatus` / `deriveWorkflowStatus`) are therefore order-insensitive set reductions, total (never throw), mirroring the contracts guards' totality (AGENTS §14).

5. **Status is derived from children, per-phase-bail-aware.** A `PhaseStatus` is derived from its tasks' statuses (`bail`-agnostic — a phase surfaces a task failure as `failed` so the policy can decide); a `WorkflowStatus` is derived from its phases' `PhaseDerivation`s (each phase's status paired with the EFFECTIVE `bail` it ran under, `effectiveBail = phase.bail ?? workflow.bail`). A `failed` phase propagates `failed` to the workflow ONLY when ITS effective `bail` is `true` — so a `bail: true` phase HALTS the run even under a graceful (`false`) workflow default, and a `bail: false` phase folds into completion (recorded as data in the result tree) even under a strict (`true`) workflow default. `deriveWorkflowStatus(PhaseDerivation[])` therefore takes the per-phase policy on each phase, not one scalar. The three §10 status tiers (`TaskStatus` / `PhaseStatus` / `WorkflowStatus`) alias ONE `LifecycleStatus` vocabulary, so the single `isTerminalStatus` predicate covers them all.

6. **The leaf is a guarded state machine; the override round-trips.** A `Task`'s transitions read the `TASK_TRANSITIONS` graph via `canTransitionTask` — an illegal move (completing a non-`running` task, starting a settled one) throws a `TRANSITION` `WorkflowError`, so the leaf can never reach an impossible state. A `skip` / `stop` on a DERIVED `Phase` / `Workflow` sets an `#override` that is PERSISTED in the snapshot's own `override` field and restored DIRECTLY (no fragile status-divergence guess). The root's `completed` override is narrower: only a pending tree with zero tasks anywhere is vacuously complete; hostile completed overrides over pending work or a non-pending derivation are rejected. A leaf's terminal status IS its forced marker, so a `TaskSnapshot` needs no `override`.

7. **The result tree is lineage-navigable, three tiers.** A `TaskResult` carries its full lineage (`task` / `phase` / `workflow` contexts) and BOXES the produced outcome in a [`Result`](contract.md): present exactly for `completed` (a `Success`) / `failed` (a `Failure`), absent for `skipped` / `stopped` (terminal without an outcome) and for a non-terminal task. `Phase.results()` is the phase tier; `Workflow.results()` flattens every phase's via `collectResults` (the workflow tier). A `TaskController.results()` reads UP the live tree — every settled task across already-finished phases — so a later phase's `function` task reads an earlier phase's output (the result tree IS the inter-task data-flow map, read-only).

8. **`pause` / `resume` / `wait` are RUNTIME-ONLY at all three entity tiers.** `paused` is NEVER a `LifecycleStatus` and NEVER persisted in a snapshot — a paused node's `status` still reports its ordinary value. `pause()` is idempotent and ignored for terminal nodes; it emits only after `paused` becomes true. `resume()` emits only when it actually opens a paused gate. Terminal cleanup, `stop`, and `destroy` release gates without inventing a `resume` event. An entity `wait()` NEVER rejects: it resolves immediately when not paused and otherwise parks on that entity's gate; `Task.wait()` alone never observes ancestors. When the runner or `TaskController` composes those gates, every park is raced against cancellation and relevant ancestor Workflow/Phase `skip` / `stop` events. An ancestor terminal override therefore wakes descendant parks without a fabricated `resume`; queued or not-yet-dispatched work then skips, while a handler dispatched before a graceful stop may finish naturally.

9. **`stop` (graceful) vs `destroy` (hard) — two different cancels, at two different tiers.** A `Workflow.stop()` / `Phase.stop()` FORCES a terminal status (an override) — the §10 forced-terminal verb. `Workflow.destroy()` is the STRONGER, TERMINAL teardown: it marks `destroyed` before any event, pins non-terminal workflow/phase overrides to `stopped`, stops every non-terminal task, releases gates and liveness timers, aborts `signal`, then destroys task emitters, phase emitters, and the workflow emitter in that ownership order. Already-terminal genuine completed/failed nodes retain their state. The operation is reentrant-safe and idempotent; structural mutation from a final stop listener is refused, recursive `destroy()` is a no-op, and state/snapshots remain inspectable after emitter resources are gone. The substrate `Runner.stop()` is a DIFFERENT, GRACEFUL verb at the execution-substrate tier: no further unit is dispatched, but every already-in-flight unit finishes normally, and a never-dispatched (still-pending) unit is rejected WITHOUT being recorded as a failure (it never trips fail-fast) — `execute()` RESOLVES (never rejects) with whatever settled. Declared units are launched and ordered before the run emits `start`, while native Queue dispatch remains asynchronous, so a public `spawn()` from a start listener is accepted after every declared result but still before any handler runs. A resolved entry's reliability properties are read before its id is classified as queued; that classification happens before `queue.enqueue`, so an `entries` resolver that synchronously requests graceful stop and returns produces never-dispatched stop work, while resolver/property throws remain genuine failures. `Runner.stop()` / `abort()` / `destroy()` return stable cleanup barriers; a graceful stop may still be escalated when a dispatched unit fails or the caller aborts/destroys, and `destroy()` awaits the backing Queue before destroying Runner observation last. A driving `WorkflowRunnerInterface.execute(workflow)` folds `workflow.signal` into its run signal, so `destroy()` aborts in-flight work IMMEDIATELY, while `workflow.stop()` alone lets not-yet-started work skip gracefully and in-flight work finish.

10. **Observation is a pure side-channel (§13).** Each live `Workflow` / `Phase` / `Task` owns a typed `emitter` (`WorkflowEventMap` / `PhaseEventMap` / `TaskEventMap`) firing strictly AFTER each transition — a leaf's OWN event before the cascade re-derives the parents (cause before effect), so an observer sees the leaf changed before the phase / workflow does. The emitter isolates a listener throw and routes it to its OWN `error` handler (the `error` option, surfaced as `(error, event)`, NOT a domain event) — so a buggy observer can NEVER corrupt a transition or the cascade. The `WorkflowRunner` and `TaskController` are EVENT-FREE by design (the runner drives the entities' own emitters; the child managers `PhaseManager` / `TaskManager` are purely structural and observe nothing).

11. **Running-phase append-only; every structural edit is gated by the pending-suffix boundary.** `Phase.add` (and its manager delegate) accepts any `index` while the phase is `pending`, but ONLY a pure append (`index` omitted or `=== tasks.count`) while `running` — a live runner subscribed to the phase's own `add` event picks the new task up for same-run execution, and the derived-status model guarantees the phase cannot reach a terminal status while that newly-accepted `pending` task is still outstanding; a terminal phase always refuses. `remove` / `move` / `update` on a phase's tasks are allowed ONLY while the phase itself is `pending`. At the workflow tier, `Workflow.add` / `remove` / `move` / `update` on its phases are refused outright while the workflow is terminal or `destroyed`; otherwise every target index (and, for `add`, the effective insertion index `index ?? phases.count`) must fall within the PENDING SUFFIX — the contiguous trailing run of `pending` phases (phases run sequentially, so every already-started phase forms a contiguous leading prefix) — whose boundary is `deriveBoundary`. Every refusal (at either tier) is a graceful `Result` `MUTATION` failure, never a throw, and fires no `add` / `remove` / `move` / `update` event.

12. **The runner COMPOSES a PURE engine.** `WorkflowRunner.execute` builds the live tree from the definition and drives phases SEQUENTIALLY, with each phase's tasks CONCURRENTLY through one substrate `Runner`. The substrate owns concurrency and declared retries; the workflow layer owns each task's deadline because it must distinguish timeout failure from genuine cancellation and settle the live leaf under the phase's `bail` policy. Non-final timeout rejects to trigger a retry; final timeout fails the task and rejects only for fail-fast. Run-level abort / [timeout](timeout.md) / [budget](budget.md) fold through `AbortSignal.any`; pacing is the shipped scheduler. The engine carries no behavior/provider registry and invokes each task's already-resolved handler directly.

13. **A task's behavior is a plain string, resolved ONCE into a `handler`; present names must resolve before execution.** A live `TaskInterface`'s `run` is resolved at construction against `WorkflowOptions.functions`. Exact restore without functions remains usable for inspection: it preserves the present `run` and leaves `handler` undefined. Definition execution, recovery, and entity execution reject a present name without a handler before external dispatch, so named work never false-completes. A task that deliberately omits `run` is the only no-op form and completes with JSON `null`. External integrations enter through ordinary application-supplied functions.

    Construction options are hostile-boundary inputs: every root `WorkflowOptions` property is captured by direct access exactly once before fresh construction, restore, recovery validation, or definition execution; inherited and non-enumerable values remain valid. `Workflow`, `Phase`, and `Task` likewise snapshot their nested phase/task bags and keyed child values once, so accessor-backed caller options cannot shift policy, hooks, metadata, silence, or handler resolution between levels. The exact `functions` registry accepted by recovery validation supplies every recovered handler and remains the registry used by later live additions. The live-workflow `execute` overload reads only run-control bounds and never touches construction getters.

14. **`WorkflowError` names only Workflow failures.** `TRANSITION` guards lifecycle moves, `RESTORE` rejects invalid durable state, and `MUTATION` reports refused structural, metadata, or activity changes. Integration-specific failures remain outside this package and must not expand Workflow's error vocabulary speculatively.

15. **`WorkflowRunnerInterface.execute(workflow)` claims one coherent drivable object synchronously and once.** The entity overload accepts a fresh pending tree or a quiescent recovered tree with terminal and pending work. It rejects destroyed, terminal, currently running, handler-incomplete, inconsistent, empty-of-pending-work, or previously claimed objects. The internal `WeakSet` is process-local object-identity protection only: two separately restored objects with the same workflow id are distinct claims. A distributed adapter must provide an external workflow-id + epoch lease and idempotent side effects; core does not pretend its local claim is a cross-process lease. Exact restore preserves a running leaf and is therefore intentionally not drivable; call `createRecoveredWorkflow` first.

16. **A run-level `timeout` / `budget` keeps counting while paused.** `pause` suspends DISPATCH, not the clock — an external `WorkflowRunOptions.timeout` deadline or `budget` ceiling continues to elapse / accumulate while a run sits paused, so a long pause can still fire the bound and unpark the run into a cancelled (`stopped`) outcome; pausing is not a way to freeze a run's external bounds.

17. **Cross-environment `setTimeout` default (scheduler).** `Scheduler` uses ONLY `setTimeout` / `clearTimeout` — universally available in browser and Node — so the default runs unchanged in either. It deliberately avoids env-specific fast paths (`setImmediate`, `scheduler.yield`, `requestAnimationFrame`, `node:timers/promises`, `MessageChannel`); those belong to the environment backends.

18. **`yield` is a macrotask host-turn, not a microtask.** `yield()` waits on a zero-delay `setTimeout`, not `queueMicrotask`. A microtask drains before the host regains control, so it would only defer within the current task — it would NOT let pending I/O, timers, or rendering run. A macrotask is the correct cross-environment "give the host a turn", so a microtask queued after a `yield()` call resolves before the yield does.

19. **Abort-aware, with full cleanup.** A pending `yield` / `delay` rejects with `signal.reason` (the standard `AbortSignal` convention) when its `options.signal` aborts. An already-aborted signal rejects immediately WITHOUT arming a timer. Either settle path — the timer firing or the signal aborting — clears the timer and removes the abort listener: no leaked timer, no leaked listener, and no double-settle.

20. **Priority accepted but uniform.** `options.priority` is part of the contract, but a `setTimeout`-based default cannot act on urgency, so it treats every priority the same. It is accepted without error and does not change behavior; environment backends honour it.

    The shared test `createRecordingScheduler` wraps one shipped `createScheduler` instance:
    it counts a `yield` before delegating and delegates `delay` unchanged, preserving real
    asynchronous turns, timing, abort reasons, and cleanup rather than substituting behavior.

21. **Event-free by contract.** The scheduler is a functional pacing primitive with no Emitter, `EventMap`, or `on` hook; observation belongs to the entities and runners that compose it.

22. **Environment backends honour priority and the native primitive; abort semantics are identical.** Each backend (`NodeScheduler` over `setImmediate`; `BrowserScheduler` over `scheduler.postTask`, `FrameScheduler` over `requestAnimationFrame`, `IdleScheduler` over `requestIdleCallback`) is a standalone `SchedulerInterface` that changes only the `yield` primitive — `delay(ms)` stays a real `setTimeout` — and preserves the contract's abort discipline byte-for-byte: reject with `signal.reason` verbatim, no arming when pre-aborted, full handle + listener cleanup on either settle path, settle-once. Native APIs are feature-detected through guards (`isRecord` / `isFunction`), never an `as` (AGENTS §14), with a real-macrotask fallback where absent. `NodeScheduler` does **not** delegate to `node:timers/promises` (it would replace `signal.reason` with a Node `AbortError`); the timer is hand-rolled. `BrowserScheduler` honours `priority` via `postTask`'s priority levels; the others accept `priority` as a documented no-op.

23. **DOC ↔ SOURCE method bijection (scheduler).** The `## Methods` table lists exactly `SchedulerInterface`'s public methods — exhaustive, both directions — and `Scheduler` plus every backend (`NodeScheduler` / `BrowserScheduler` / `FrameScheduler` / `IdleScheduler`) exposes the same public methods, no more (AGENTS §22).

24. **Snapshot is an owned, hostile-boundary durable payload.** `Workflow.snapshot()` returns a deeply cloned, frozen, exact-JSON graph containing policy, statuses, lineage-safe normalized results, task metadata/activity, and consumed `attempts`. Accessors, cycles, class instances, symbols, holes, non-finite numbers, unknown keys, impossible topology, invalid results, and derived-status drift are rejected before live construction. Task order carries no lifecycle topology because tasks are concurrent; phase order uses a sequential frontier that ignores forced skipped/stopped gaps and permits at most one running phase. `createRestoredWorkflow` is an exact inspectable state round-trip even without functions; it does not make interrupted work runnable. `createRecoveredWorkflow` is an explicit two-pass transform per phase: every exhausted running task is classified first. Graceful recovery fails those exhausted tasks, returns retryable running tasks to pending, and continues eligible work. In a strict (`bail: true`) phase, an existing persisted failed task is retained as an established halt boundary; eligible siblings and later work are skipped. Exhausted running tasks still normalize to recovery failures, and every other eligible sibling on both sides is skipped. Attempts never replenish. Recovery and live recompute use the greater of the host clock and the persisted `updated`, so restored future stamps never regress. Terminal workflow/phase overrides are not recoverable.

25. **The durable store owns values on both sides, and the runner can compose it.** Both store implementations deep-clone and validate on `set` and `get`, so callers cannot mutate stored state by alias. `DatabaseWorkflowStore.get` returns `undefined` only for an absent row; present malformed data rejects with the normalized `RESTORE` error. Supplying `WorkflowRunOptions.store` adds required initial, pre-handler attempt, terminal settlement, and final checkpoints. Activity, structural, and skip events trigger best-effort coalesced writes; `WorkflowPersistence` reserves its writer promise before the drain can call external `store.set`, so a synchronous store-triggered entity mutation joins the current obligation instead of starting a second write. There is at most one write in flight, and a newer revision is persisted by the same drain or its latest follow-up. A required failure stops advancement and is returned as `WorkflowResult.fault`; `durable` reports whether the final live state reached the store. Persistence rejection never masks or rewrites the task's normalized handler/timeout/recovery outcome.

What ships is **W-a → W-d**: the definition contract + type surface + derivation helpers (W-a), the live entity tree + result tree + snapshot/restore/recovery (W-b), the PURE `WorkflowRunner` engine + `run`-string / `handler` model (W-c), and the durable `WorkflowStore` (W-d — `WorkflowStoreInterface` plus the in-memory and driver-pluggable implementations). The shipped `WorkflowManager` is the higher-level live registry over that store seam. Provider, Tool, MCP, Terminal, persistent-driver selection, and resource-pool policy are deliberately outside Workflow core.

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
		// External integrations compose their own WorkflowFunction into this same registry.
		publish: async () => 'published',
	},
})
result.status // 'completed' (graceful) — even if a leaf failed
result.workflow.results() // every settled task's TaskResult, lineage-navigable
```

`execute` is single-source — it builds the live tree from `definition` itself and returns it in `result.workflow`. Each task's `run` string is resolved ONCE at construction against `options.functions`; an omitted `run` completes as a JSON `null` no-op, while a present but absent registry name is rejected before execution.

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

A task may declare per-task reliability — extra attempts on failure and a workflow-owned per-attempt deadline. Both PERSIST in `TaskSnapshot`; `timeout` must be an integer in `0..MAX_TIMER_MS`, where `0` disables the deadline:

```ts
const task: TaskDefinition = {
	id: 't',
	name: 'T',
	run: 'fetch',
	retries: 3,
	timeout: 5000,
}
```

A per-attempt `timeout` is a RETRYABLE FAILURE of that attempt, NOT a skip. The workflow layer owns the deadline so it can settle the live leaf before the substrate unit resolves: a non-final timeout rejects the unit to drive its declared retry while leaving the leaf `running`; the final timeout `fail`s the leaf, then rejects only under `bail: true`. Under `bail: false`, slow siblings finish and later phases continue after the failed leaf is recorded. A run-level cancel (abort / run-`timeout` / budget) and a sibling fail-fast under `bail` still `skip` the in-flight leaf.

### Bounding a run (abort / timeout / budget)

```ts
import { createAbort } from '@orkestrel/abort'
import { createBudget } from '@orkestrel/budget'

const abort = createAbort()
const result = await runner.execute(definition, {
	signal: abort.signal, // an external cancellation
	timeout: 10_000, // non-positive, non-finite, or over MAX_TIMER_MS means no deadline
	budget: createBudget({ max: 50_000, consume: (usage) => usage.total }), // a cost ceiling
})
// A fire of ANY bound folds via AbortSignal.any: it cancels every in-flight task, skips the rest,
// and force-stops the workflow → status === 'stopped'. `execute` RESOLVES (never rejects) on a cancel.
```

The definition stays plain data at every boundary. Validate untrusted authored input with `createWorkflowContract`, then compose only the application-owned functions the run is allowed to invoke.

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

A `skip` / `stop` at the phase / workflow tier is an OVERRIDE — it forces the node's status regardless of its children's derived value, and the override is persisted in `snapshot()`'s `override` field so `createRestoredWorkflow` restores it directly. A leaf's `skip` / `stop` is a real guarded transition (no override needed — its terminal status IS the marker).

### Pausing, resuming, and parking on a run — `pause` / `resume` / `wait` / `destroy`

`pause` / `resume` / `wait` are RUNTIME-ONLY at the workflow, phase, and task tiers — never a `LifecycleStatus`, never persisted. `destroy` is Workflow-only TERMINAL teardown (a `Phase` and `Task` have no `destroy`; only the workflow owns the cascade):

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

const task = workflow.phase('build')?.task('compile')
task?.pause()
const taskWaiter = task?.wait()
task?.resume()
await taskWaiter

// destroy is atomic hard teardown: pins stopped overrides before descendant events, stops
// every non-terminal task/phase, releases gates/timers, aborts `signal`, then destroys emitters.
workflow.signal.addEventListener('abort', () => cleanup())
workflow.destroy()
workflow.destroyed // true
workflow.destroy() // idempotent — a second call is a no-op
```

A driving `WorkflowRunnerInterface.execute(workflow)` gates workflow and phase pauses at dispatch boundaries. Task pause adds a cooperative per-task gate and `TaskController.wait()` gives already-running work an explicit checkpoint; it does not suspend code between checkpoints. Runner/controller parks race cancellation plus relevant ancestor Workflow/Phase `skip` / `stop` events, so a terminal override wakes descendants without emitting `resume`; queued or pre-dispatch work then skips, while an already-dispatched handler may finish naturally under graceful stop. An attempt that owns a queue slot becomes `running` before those gates, so its per-attempt deadline can retry or finally fail it without dispatching the external handler; resuming an expired older gate cannot dispatch it. External run `timeout` / `budget` / `signal` also unparks paused gates promptly and keeps counting while paused.

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

| Entity     | Event map          | Events                                                                                                                                                                      |
| ---------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Workflow` | `WorkflowEventMap` | `start(id)` · `complete()` · `fail(result)` · `pause()` · `resume()` · `skip()` · `stop()` · `add(phase, index)` · `remove(phase)` · `move(phase, index)` · `update(phase)` |
| `Phase`    | `PhaseEventMap`    | `start(id)` · `complete()` · `fail(result)` · `pause()` · `resume()` · `skip()` · `stop()` · `add(task, index)` · `remove(task)` · `move(task, index)` · `update(task)`     |
| `Task`     | `TaskEventMap`     | `start(id)` · `complete(result)` · `fail(result)` · `pause()` · `resume()` · `skip()` · `stop()` · `report(activity)` · `pulse(activity)` · `silence()`                     |

A `start` fires when a node begins; `complete` when it settles successfully; `fail` carries the failing `TaskResult`; `skip` after a successful transition to skipped; `stop` when force-stopped. `pause` / `resume` fire only when their gate actually changes; an idempotent repeat, a terminal entity, or a destroyed Workflow emits nothing. Repeating `skip` after a terminal state also emits nothing. A task adds accepted whole-frame `report`, accepted heartbeat `pulse`, and one-shot `silence`. Silence means only that no report or pulse was accepted during the configured window; it never proves a task is stuck. Refused activity emits nothing. A `Workflow` / `Phase` additionally fires `add` / `remove` / `move` / `update` on successful edits. The leaf event fires before its parent cascade, and listener throws remain isolated.

### Long-running task activity and cooperative control

Core retains one bounded, current reporter claim—not a journal:

```ts
const result = controller.report({
	note: 'Indexing',
	progress: { current: 240, total: 1_000, unit: 'files' },
	operations: [{ id: 'scan', name: 'Scan sources', started: Date.now() }],
	constraints: [{ id: 'rate', name: 'Provider rate limit', started: Date.now() }],
})

if (!result.success) return
await controller.wait() // checkpoint workflow + phase + task gates, or cancellation
controller.pulse() // healthy but unchanged: restamp liveness without replacing the frame
```

Every accepted `report` replaces the complete frame. Omitted `note` / `progress` clear them and omitted collections become empty. Core rejects the whole report with a `MUTATION` failure—preserving the prior frame—for empty present text, non-finite or negative numbers, `total < current`, or duplicate ids within operations or constraints. Accepted progress, items, arrays, and frames are copied and frozen; getters, events, and snapshots therefore expose no mutable caller-owned reference. There are no caps, truncation, clamping, history, provider fields, or raw-log retention.

Activity is attempt-owned. `start` seeds the first empty frame; retry entry replaces it with another empty frame. A `TaskController` captures the runner's explicit claimed attempt and folded signal; ownership requires both the runner token and the live task's persisted attempt to match. A public or reentrant `start` therefore invalidates an older handle immediately: late `report` returns `TRANSITION`, late `pulse` returns `false`, handler settlement is ignored, and no settlement checkpoint is attributed to the stale attempt. Pending snapshots omit activity; running/completed/failed snapshots require the accepted frame; skipped/stopped snapshots may omit it or retain the last accepted reporter claim. Start, report, and pulse stamps use the greater of the host clock and the prior activity stamp, so a restored future timestamp never regresses. Restore never arms a silence timer merely because a frame was persisted.

`WorkflowOptions.silence` is the runtime default and `TaskOptions.silence` is the runtime override; neither is authored definition data nor persisted supervision config. A present value outside `1..MAX_TIMER_MS` explicitly disables inheritance. The effective task value is host-timer-safe or `undefined`, so overflow never clamps into an immediate silence event. One reusable, task-signal-parented deadline is rearmed after each accepted report or pulse. `silent` derives from that deadline's current `expired` state while the task is running and clears on the next accepted activity; repeated silence events are possible after rearming. Terminal settlement and destroy clear supervision.

Task pause is cooperative. `Task.wait()` parks only the task gate. `TaskController.wait()` folds the workflow, phase, and task gates, racing them against cancellation and ancestor Workflow/Phase `skip` / `stop` events; an ancestor terminal override wakes it without fabricating `resume`. No method suspends arbitrary JavaScript or an operating-system process. The queue acquires concurrency before the workflow handler gate, so a paused task can occupy one phase slot: with concurrency `1` it blocks later pending siblings, already-running siblings continue, the external handler is not invoked until resume, and the per-attempt timeout continues while the slot is held.

Stopping or skipping a running task fires its task-owned signal. Each attempt races its gates and handler against the folded attempt/task/run signal with removable listeners that are detached in `finally`; no task-signal park is cached across attempts. When the task is already terminal, the queue unit settles successfully without completing/failing the task or aborting siblings. An uncooperative ignored promise may continue in memory, but it no longer owns activity. The adapter that launched an external subprocess remains responsible for terminating the process and its descendants.

Provider-specific Claude/Cursor/Codex JSONL parsing, journals, raw-log retention/redaction, session ids, subprocess ownership, process-tree termination, escalation policy, and CLI continuation stay outside workflow core in application adapters/supervisors. Provider continuation is a new persisted attempt of the same logical task, not a new logical workflow task and not `Task.resume()` (which only opens a live cooperative gate). That composition must retain the external workflow id + epoch lease and make side effects idempotent. Core's `WeakSet` protects only one in-process object identity. Interrupt a whole run with the caller's `AbortController` or `workflow.destroy()`; there is intentionally no `workflow.abort()` API.

### Snapshot & restore (the durable payload)

```ts
import {
	createWorkflow,
	createRecoveredWorkflow,
	createRestoredWorkflow,
} from '@orkestrel/workflow'

const functions = { fetch: async (controller) => `fetched ${controller.task.id}` }
const workflow = createWorkflow(definition, { functions }) // a live tree, every node pending
workflow.phase('fetch')?.task('a')?.start() // pending → running (cascades up)

const snapshot = workflow.snapshot() // pure JSON — write to disk, send to a prompt, load across sessions

// Restore is exact and inspectable even without functions. Supplying the registry re-resolves
// each task's `run` into a fresh handler for later recovery/execution.
const resumed = createRestoredWorkflow(snapshot, { functions })
resumed.status === workflow.status // true — bail comes from the snapshot itself

// Exact restore deliberately preserves the running leaf, so it is inspectable but not drivable.
// Recovery explicitly consumes persisted attempt history and produces a drivable pending suffix.
const recovered = createRecoveredWorkflow(snapshot, { functions })
```

The snapshot is an owned exact-JSON graph. It persists `bail`, overrides, normalized JSON results, task `run` / `retries` / `timeout`, and consumed `attempts`. Every pending snapshot omits activity. Recovery of retryable running work also removes its prior activity before returning it to pending, while preserving consumed attempts; the next real `start` creates a fresh attempt frame. Exact restore preserves unresolved names for inspection; execution still requires every present `run` to resolve. During construction, each phase reads every unique initial `run` binding once and gives duplicate-name tasks that exact captured handler; recovery validates the constructed live handlers without rereading the registry. The retained registry identity still serves later live additions, whose binding is read at their own mint time. Recovery refuses terminal workflow/phase overrides and never replenishes attempts. Within each phase it classifies all exhausted running tasks first: strict policy retains an existing failed task as an established halt boundary, normalizes exhausted running tasks to recovery failures, and skips every other eligible sibling on both sides plus later eligible phases; graceful policy fails exhausted tasks, resets retryable running tasks to pending, and continues.

### Persisting & restoring (the durable store)

The `WorkflowStoreInterface` seam (`get` / `set` / `delete`, async, keyed by a snapshot's own id) has a DUAL-store convention — pick the backend, the seam is identical. `createMemoryWorkflowStore` is the zero-plumbing default (a plain `Map`); `createDatabaseWorkflowStore` is the driver-pluggable twin over a `databases` table (the snapshot one opaque JSON column, driver defaulting to memory). Both persist the `WorkflowSnapshot` from the section above unchanged; reading one back and rebuilding the live tree is the shipped `createRestoredWorkflow`. A durable backend (JSON / SQLite / IndexedDB) swaps in by passing the driver to `createDatabaseWorkflowStore` — without touching the engine or the entity tree (the `SessionStore` / `QueueStore` driver-swap pattern).

```ts
import {
	createDatabaseWorkflowStore,
	createMemoryWorkflowStore,
	createWorkflow,
	createRestoredWorkflow,
} from '@orkestrel/workflow'
import { createMemoryDriver } from '@orkestrel/database'

// The zero-plumbing default (a plain Map) — or the driver-pluggable twin (one opaque JSON column):
const store = createMemoryWorkflowStore()
// const store = createDatabaseWorkflowStore(createMemoryDriver()) // pass a JSON / SQLite / IndexedDB driver for durability
const workflow = createWorkflow(definition)

await store.set(workflow.snapshot()) // persist the run state under its own id
// …later, in another turn / process …
const snapshot = await store.get(definition.id) // the persisted snapshot, or undefined if absent
const restored = snapshot && createRestoredWorkflow(snapshot, { functions }) // exact live state
await store.delete(definition.id) // drop it (an absent id is a no-op)
```

Both stores clone and validate on write and read, so stored snapshots never alias caller-owned data. A present database row whose snapshot id differs from the requested row key rejects with normalized `WorkflowError` code `RESTORE`; its safe context carries `requested` and `payload`. The store has NO TTL / eviction — a persisted workflow run-state is durable until an explicit `delete`.

For automatic run durability, pass the same store to `execute`:

```ts
const result = await runner.execute(definition, { functions, store })
result.durable // whether the final state reached the store
result.fault // first required checkpoint failure, if any
```

The exported `WorkflowPersistence` coordinator awaits initial, attempt, settlement, and final boundaries. Activity, structural changes, and workflow/phase/task skip events request coalesced best-effort writes; only one write is in flight and one latest obligation is retained. The first required failure is retained as `fault`, stops further dispatch, and is never replaced; `durable` independently reports whether the final live state reached the store. Finalization detaches listeners before requesting the final checkpoint. Terminal live events can therefore precede their settlement write, while `execute` still waits for final durability. A store Promise that never settles also prevents the required checkpoint—and therefore `execute`—from settling; core has no storage timeout or cancellation contract. Unexpected scheduler/infrastructure faults stop and sweep the tree, attempt the final write, then reject if persistence itself settles.

### Managing workflows (registry + store seam)

`WorkflowManager` (`createWorkflowManager`) is the additive manager tier over the section above — a store-backed REGISTRY of live workflows, mirroring the `@orkestrel/agent` line's `ConversationManager` / `WorkspaceManager`. It is PURELY ADDITIVE: direct `WorkflowStoreInterface` use and `createRestoredWorkflow` (both sections above) remain valid — a caller now has a THIRD, higher-level option that also tracks a `functions` registry so a hydrated workflow stays RUNNABLE.

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

Concurrent `open(id)` misses share one store read and the same returned promise/live object. The
same-id promise is reserved before `store.get` can synchronously reenter `open`, so reentry
coalesces instead of starting a second hydration. The registry is
rechecked after that read: a concurrent same-id `add` wins, while `remove(id)` (even when absent)
invalidates the earlier read and `clear()` invalidates every earlier read. Misses and failures are
removed from the in-flight registry so a later call retries. A valid snapshot whose payload id does
not equal the requested id rejects with `RESTORE` and is never registered.

`save(id)` owns the live snapshot when invoked, not when its write eventually begins. Its same-id
promise is reserved before `store.set` can synchronously reenter `save`; the reentrant write queues
behind that exact reservation. Writes for the same id are serialized in invocation order; writes for different ids begin independently. A
rejected write reaches its own caller unchanged, while the next same-id write still proceeds.

Unlike its `ConversationManager` / `WorkspaceManager` twins, there is NO `active` / `switch` pointer — nothing in the workflow domain renders "the current workflow" the way an agent context renders the active conversation/workspace, so carrying one would be a speculative extra (AGENTS §21). `open` / `save` are otherwise the EXACT lenient store seam: `open` resolves a registered workflow directly (no store hit), else hydrates from `store` on a miss (`undefined` on a store miss or no store); `save` persists a registered workflow (`false` on an unknown id or no store) — never a throw.

### The helper functions — guards, derivation, lineage & synthesis

The pure functions the entity tree and runner are built from (AGENTS §4.3 / §14) — exported directly, so a caller can reuse the same derivation or synthesis logic outside the shipped classes:

```ts
import {
	buildPhaseContext,
	buildTaskContext,
	buildWorkflowContext,
	canTransitionTask,
	captureWorkflowOptions,
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
captureWorkflowOptions({ bail: true }) // owned one-read top-level construction options
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

Every one is pure and side-effect-free: the guards and predicates never throw, and the builders and synthesizers are deterministic given the same input. The throwing snapshot boundary is `cloneWorkflowSnapshot`, which owns and validates a hostile snapshot and raises a `RESTORE` `WorkflowError`.

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

Runner reliability values use the Queue contract exactly: `concurrency` is a positive safe
integer, `retries` is a nonnegative safe integer, and `timeout` is an integer in
`0..2_147_483_647`, where `0` disables the deadline. The same `retries` / `timeout` strictness
applies to values returned by `entries`; invalid values throw rather than being floored or clamped.

### Fanning out with `spawn`

```ts
// A handler discovers more work and fans it out as sibling units — they run through the
// same queue and their results join the output after the declared units, in spawn order.
const runner = createRunner<Task, Result>({
	concurrency: 8,
	handler: (controller) => {
		for (const child of discover(controller.input)) {
			void controller.spawn(child) // fire-and-track — do NOT await inline (deadlock caveat)
		}
		return process(controller.input)
	},
})

const results = await runner.execute(roots) // every declared root first, then every spawn
```

`spawn` returns the sibling's result promise, but the run drains it whether or not you await it — so fan out and return. All declared inputs are reserved before `start` is emitted, so even a public `spawn()` from a start listener is ordered after the complete declared list; Queue dispatch remains asynchronous, so `start` still precedes handler execution. On a bounded runner, awaiting a spawn _inline_ from a slot-holding handler can deadlock; let the runner drain the closure instead.

### The per-unit `Controller` handle — `wait` / `spawn` / `abort`

A `Runner` handler receives a `Controller` — the per-unit handle: its `id` / `input` / `signal` data plus `wait` (park until this unit is cancelled), `spawn` (fan out a sibling), and `abort` (cancel THIS unit, firing its signal with an optional reason).

```ts
import { createRunner } from '@orkestrel/workflow'

const runner = createRunner<Job, Output>({
	concurrency: 4,
	handler: async (controller) => {
		for (const child of discover(controller.input)) {
			void controller.spawn(child) // fan out a sibling unit through the same queue
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
const aborting = runner.abort(new Error('shutting down'))
await run.catch((error) => report(error))
await aborting

// Tear the runner down when it's no longer needed — abort plus stop the backing queue.
// Idempotent: a second `destroy()` is a no-op.
await runner.destroy()
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
| `start`  | `[]`            | Declared units are reserved and `execute` begins, before asynchronous dispatch. |
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
- **Snapshot for durability** — `workflow.snapshot()` is the pure-JSON payload; `createRestoredWorkflow` rebuilds an identical live tree, and the `WorkflowStore` seam persists it (W-d).
- **`yield` to stay cooperative** — between units of long-running work, `await scheduler.yield()` so the host can flush I/O, fire timers, and paint; never busy-loop a tight synchronous loop that starves the host.
- **Always thread a `signal` through the scheduler** — pass `options.signal` through `yield` / `delay` so cancellation rejects the pending wait at once (with the signal's `reason`) instead of stalling until the interval elapses; an aborted loop should fall out via that rejection, not a polled flag alone.
- **`delay` for spacing, `yield` for a turn** — reach for `delay(ms)` to space retries or paced work; reach for `yield()` (a zero-delay turn) when you only need to let the host run before continuing.
- **Type against `SchedulerInterface`** — depend on the interface, not a concrete class, and pick the backend at the composition root, so the same loop runs on any host.
- **Honour `controller.signal`** — pass it to `fetch` / child aborts and bail when it fires, so a fail-fast or an `abort` actually stops in-flight units instead of just abandoning their results.
- **Fan out, don't await inline** — `spawn` siblings and return; the run drains the whole closure. Awaiting a spawn inline from a bounded handler risks a slot-starvation deadlock.
- **`concurrency: 1` for ordering** — there is no separate sequential flag; a concurrency of one runs units one-at-a-time.
- **One-shot** — a `Runner` runs one `execute`; create a new one to run another set.
- **Keep pacing event-free** — the scheduler is a functional primitive; observe the entity or runner that composes it.
- **Observe, don't drive** — subscribe to a node's `emitter` for progress / metrics, and to `runner.emitter` for run-lifecycle moments; emitting is a pure side-channel, so a listener never changes what a transition or run does (and a throwing one can't corrupt it).

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ source bijection across `src/core` (value + type exports), plus each behavioral interface's `## Methods` ↔ source-method bijection and each implementing-class ↔ interface method parity.
- [`tests/policy.test.ts`](../tests/policy.test.ts) — coding policy rejects private `@src/*` imports in TSDoc examples while accepting legitimate source imports and identical text in ordinary non-TSDoc comments.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — status/lineage/snapshot helpers, bounded silence inheritance, `scheduleHost` setup/cancellation race arbitration with exact falsy failures, hostile caller signal methods, and throwing cancellation closures after caller abort or host failure, plus the snapshot-decode leaves: remaining-budget recovery, established strict halt boundaries, exhausted recovery failures, monotonic stamps, exact-restore separation, and hostile inputs.
- [`tests/src/core/cloners.test.ts`](../tests/src/core/cloners.test.ts) — immutable activity cloning, hostile/revoked proxy containment, one-read getters, no alias retention, stamp-vs-restore `updated` handling, and exact wrong-storage-key `RESTORE` evidence.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) — total activity, task-failure, task-result, and owned-snapshot guards over valid, malformed, cyclic, throwing-proxy/getter/ownKeys, and revoked inputs.
- [`tests/src/core/shapers.test.ts`](../tests/src/core/shapers.test.ts) — the shape descriptors: the `taskShape` / `phaseShape` / `workflowShape` mirroring the hand-written definition interfaces, the per-field `description`s riding the `run` string + key fields (Rank 1), `describedLiteral`.
- [`tests/src/core/tasks/Task.test.ts`](../tests/src/core/tasks/Task.test.ts) — lifecycle plus whole-frame activity, validation/immutability, pulse, repeatable silence rearming, task signal, terminal cleanup, and cooperative pause.
- [`tests/src/core/phases/Phase.test.ts`](../tests/src/core/phases/Phase.test.ts) — the derived middle tier: child-transition cascade, `skip` / `stop` override, results, snapshot/restore, and isolated lifecycle emission including idempotent pause/resume.
- [`tests/src/core/Workflow.test.ts`](../tests/src/core/Workflow.test.ts) — the derived root: bail-aware cascade, result tree, override, snapshot/restore, teardown, and isolated lifecycle emission including idempotent pause/resume.
- [`tests/src/core/phases/PhaseManager.test.ts`](../tests/src/core/phases/PhaseManager.test.ts) — the lean phases registry: `append` / `phase` / `phases` / `count`, insertion order preserved.
- [`tests/src/core/tasks/TaskManager.test.ts`](../tests/src/core/tasks/TaskManager.test.ts) — the lean tasks registry: `append` / `task` / `tasks` / `count`, order surviving an interior `skip`.
- [`tests/src/core/WorkflowManager.test.ts`](../tests/src/core/WorkflowManager.test.ts) — the store-backed registry: `add` / `workflow` / `workflows` / `count`, `remove` / `clear`, runnable hydration, both-store parity, same-promise opens even under synchronous `get → open` reentry, add/remove/clear precedence, miss/failure retry, wrong-key refusal, invocation snapshots, strictly serialized `set → save` reentry, failure recovery, and independent ids.
- [`tests/src/core/tasks/TaskController.test.ts`](../tests/src/core/tasks/TaskController.test.ts) — folded cancellation, lineage gates, ancestor terminal-event wakeups, activity checkpoints, input, and live result read-up.
- [`tests/src/core/WorkflowRunner.test.ts`](../tests/src/core/WorkflowRunner.test.ts) — sequencing/concurrency/retry/cancellation plus ancestor terminal-event gate wakeups, graceful in-flight completion, retry activity reset, stale-attempt refusal, listener balance, and paused-attempt deadline exhaustion.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — definition construction, exact hostile-boundary restore, handler completeness, and snapshot diagnostics.
- [`tests/src/core/WorkflowPersistence.test.ts`](../tests/src/core/WorkflowPersistence.test.ts) — coalesced writes including synchronous store-triggered mutation with maximum one active writer and the latest final snapshot, skipped-tier best-effort writes, attempt checkpoints awaited before dispatch, and persistence faults as data.
- [`tests/src/core/stores/MemoryWorkflowStore.test.ts`](../tests/src/core/stores/MemoryWorkflowStore.test.ts) — the in-memory store (W-d): a `set` → `get` round-trip returning the same `WorkflowSnapshot` and `createRestoredWorkflow`'ing an IDENTICAL live tree, for BOTH an all-pending snapshot (`createWorkflow(...).snapshot()`) and a real SETTLED one driven through `createWorkflowRunner().execute` (real `completed` statuses + recorded results); the driver-swap parity case (the retrieved payload survives `JSON.parse(JSON.stringify(...))` AND restores identically from the JSON-revived form — proving it persists unchanged across any JSON / SQLite / IndexedDB backend); `set` replacing under the same id; and `delete` (then `get` ⇒ `undefined`, an absent-id `delete` a no-op, an absent-id `get` ⇒ `undefined`). REAL data throughout (a real `WorkflowDefinition` + real `WorkflowFunction` handlers), no mocks.
- [`tests/src/core/stores/DatabaseWorkflowStore.test.ts`](../tests/src/core/stores/DatabaseWorkflowStore.test.ts) — the driver-pluggable twin (W-d): real-table round trips and restore parity, upsert/delete/absence, exact valid-payload/wrong-row-key `RESTORE` evidence, malformed-row normalization, default-driver smoke, and distinct-id isolation. REAL `WorkflowSnapshot` values throughout, NO mocks.
- [`tests/src/core/Runner.test.ts`](../tests/src/core/Runner.test.ts) — `execute` runs every input and returns results in declared order (even with out-of-order completion); spawned siblings and start-listener public spawns run after every declared result; nested spawns drain transitively; an entries-resolver graceful stop remains never-dispatched while resolver/property throws remain failures; bounded concurrency caps handlers in flight; `retries` re-run a flaky unit; fail-fast and abort cancellation; one-shot, empty-run lifecycle reentry, active/stopped reporting, and idempotent destroy.
- [`tests/src/core/Controller.test.ts`](../tests/src/core/Controller.test.ts) — `wait()` resolves when the unit's signal aborts and stays pending across real delays until it does (promise-parked, not timer-polled), resolving immediately if already aborted; `id` / `input` / `signal` / `aborted` reflect the unit; `abort(reason)` fires the signal with the reason; `spawn` delegates to the injected callback.
- [`tests/src/core/Scheduler.test.ts`](../tests/src/core/Scheduler.test.ts) — real-clock macrotask ordering, pre-abort and pending-abort reason fidelity, minimum elapsed delay, settle-once cleanup, untouched caller listener methods, shared-signal cancellation, concurrent deadlines, host coercion for zero / negative / `NaN`, priority composition, and modest resolved/aborted churn.
- [`tests/src/server/NodeScheduler.test.ts`](../tests/src/server/NodeScheduler.test.ts) — the same real-clock contract over `setImmediate` / `setTimeout`, including exact primitive/string/object abort reasons, untouched caller listener methods, host timer coercion, cleanup, concurrent deadlines, and modest churn. Node may emit its native warning for negative or `NaN` timer input while applying host coercion.
- [`tests/src/server/factories.test.ts`](../tests/src/server/factories.test.ts) — `createNodeScheduler` returns a working `SchedulerInterface` (shape + a real yield/delay round-trip), abort-aware, independent stateless instances.
- [`tests/src/browser/BrowserScheduler.test.ts`](../tests/src/browser/BrowserScheduler.test.ts) — the browser backend in REAL headless Chromium (where `scheduler.postTask` exists): `yield()` resolves via the real `postTask` callback, every priority is accepted, abort rejects with the verbatim `signal.reason` and cancels the posted task, `delay` timing, and caller listener methods remain untouched.
- [`tests/src/browser/FrameScheduler.test.ts`](../tests/src/browser/FrameScheduler.test.ts) — the frame backend in REAL Chromium over `requestAnimationFrame`: `yield()` resolves in a real frame callback, abort cancels the rAF handle and rejects with the verbatim reason, `delay` timing, and caller listener methods remain untouched.
- [`tests/src/browser/IdleScheduler.test.ts`](../tests/src/browser/IdleScheduler.test.ts) — the idle backend in REAL Chromium over `requestIdleCallback`: `yield()` resolves in a real idle callback, abort cancels the idle handle and rejects with the verbatim reason, `delay` timing, and caller listener methods remain untouched; the `setTimeout(0)` fallback is covered by the guard logic + a note.
- [`tests/src/browser/factories.test.ts`](../tests/src/browser/factories.test.ts) — `createBrowserScheduler` / `createFrameScheduler` / `createIdleScheduler` each return a working `SchedulerInterface` (shape + a real yield/delay round-trip), abort-aware, independent instances, in real Chromium.

## See also

- [`contract.md`](contract.md) — the shape DSL and `createContract` the workflow definition contract is built on, and the `Result` a `TaskResult` boxes.
- The `@orkestrel/tool` package — generic definitions, a total call-envelope guard, invocation, and registry primitives an application may compose at its integration boundary. It does not validate arguments against schemas, and Workflow does not depend on it.
- [`abort.md`](abort.md) · [`timeout.md`](timeout.md) · [`budget.md`](budget.md) — the run-level bounds the runner (`Runner` / `WorkflowRunner`) folds; the scheduler (pacing) is documented in this guide.
- [`emitter.md`](emitter.md) — the typed §13 emitter each live entity owns.
- [`AGENTS.md`](../AGENTS.md) — the rules; §4.4 the `bail` boolean toggle, §10 the lifecycle vocabulary, §12 errors & `Result`, §14 totality, §22 documentation-as-contracts.
- [`README.md`](README.md) — the guides index.
