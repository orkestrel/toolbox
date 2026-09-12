# Workflow

> Orchestration as data: a JSON-serializable `Workflow → Phase → Task` tree that a UI or an
> LLM authors, a store persists, and a thin engine drives by composing the shipped execution
> substrate.

The levels are exactly those, positional, and never a graph: this is not a general DAG engine, and it trades arbitrary dependency edges for a fixed, deterministic shape. It writes none of its own concurrency, retry, or abort machinery either — it reuses what already ships.

Read the module as layers of one substrate, top to bottom:

- **The tree describes.** The **definition** family (`WorkflowDefinition → PhaseDefinition → TaskDefinition`) is pure JSON — behavior referenced by name, never inline functions — so the whole tree serializes, round-trips, and is safe for a 2B model to emit. One compiled [contract](contract.md) (`createWorkflowContract`) keeps the JSON Schema + guard + parser + seeded generator in lockstep with the hand-written interfaces, so definition and runtime can never drift.
- **The entities control.** The live **entity** family (`Workflow` / `Phase` / `Task`) is the runtime mirror built from a definition: each node is an [observable](emitter.md) synchronous state machine whose status is derived from its children, mutable through its own `add` / `remove` / `move` / `update`, pausable, and snapshot-able at any instant.
- **The engine drives.** The `WorkflowRunner` is a pure engine that walks the live tree — phases sequentially, each phase's tasks concurrently — composing the substrate rather than re-implementing status / concurrency / retries / abort, under a `bail` failure policy: `false` (graceful, the default) records each leaf failure as data and finishes every phase; `true` (the database-transaction halt) aborts the in-flight siblings on the first failure and skips the rest.
- **The substrate executes.** Underneath sit the shipped primitives the engine composes: the `Scheduler` paces the host between work, the queue-backed `Runner` bounds and drives a set of units, and a `ControllerInterface` is the per-unit handle a handler receives. The engine folds [abort](abort.md) / [timeout](timeout.md) / [budget](budget.md) through this same substrate.
- **The consumer supplies behavior.** A task's `behavior` is a plain string naming a behavior in the `WorkflowOptions.functions` registry — resolved once at construction into the task's `handler` (a `WorkflowFunction`); the engine dispatches by invoking `task.handler` directly and carries no registry or provider knowledge of its own. Integrations compose real `WorkflowFunction`s at the application edge.

**Determinism is fixed by design, not configured: tasks within a phase run concurrently; phases run sequentially.** A dependency is expressed structurally — a task that needs another's output goes in a later phase — so the same tree always sequences the same way and there is no DAG to misconfigure. The only per-phase knob is an optional `concurrency` throttle (max-in-flight), never a sequencing control.

Workflow keeps all runtime/engine surface — the definition contract, live entity tree, pure runner, and durable store. Provider, tool, terminal, and protocol integrations remain composition concerns outside this package.

Source: [`src/core`](../src/core). Published through `@orkestrel/workflow`.

## Surface

The use case starts with a `WorkflowDefinition`: pure JSON with phases in order, each phase's tasks concurrent, and each task naming a registered behavior.

### Author a definition and run it

The following example runs that definition through a `WorkflowRunner` that builds the live tree and drives it to a `WorkflowResult`.

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
				{ id: 'compile', name: 'Compile', behavior: 'compile' },
				{ id: 'lint', name: 'Lint', behavior: 'lint' },
			],
		},
		{
			id: 'ship',
			name: 'Ship',
			tasks: [{ id: 'publish', name: 'Publish', behavior: 'publish' }],
		},
	],
}

const runner = createWorkflowRunner() // a pure engine — no registries

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

Why this is safe: the definition is the single source of truth. `execute` builds the live tree from the definition itself — there is no separately-supplied tree to fall out of sync — so the executed entity can never drift from the `behavior` string / `concurrency` metadata, and the freshly-built live `workflow` is returned in the result. Each task's `behavior` string is resolved once at construction against `options.functions` into its `handler`; the runner then invokes `task.handler`. Phase `ship` starts only after phase `build` has fully settled; within `build`, `compile` and `lint` run concurrently. Omitting `behavior` deliberately creates a no-op task whose JSON result is `null`. A present `behavior` must resolve before execution; an absent registry entry is rejected rather than silently skipping named work.

### Factories

| API                           | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWorkflowContract`      | function | Compiles the workflow definition contract — the JSON Schema, guard, parser, and seeded generator for a `WorkflowDefinition`, all derived from one shape and kept in lockstep.                                                                                                                                                                                                                                  |
| `createWorkflow`              | function | Builds the live W-b entity tree from a `WorkflowDefinition` — the whole `WorkflowInterface` → `PhaseInterface` → `TaskInterface` tree, each level wired with its lineage context, its emitter, and the cascade, and every node born `pending`.                                                                                                                                                                 |
| `createWorkflowTree`          | function | Builds the live entity tree one definition and one owned options bag describe — the shared construction path behind every definition-driven mint.                                                                                                                                                                                                                                                              |
| `createRestoredWorkflow`      | function | Builds an equivalent live W-b entity tree from a `WorkflowSnapshot` — the inverse of `WorkflowInterface.snapshot`, restoring structure + each node's status + recorded results + positional order + the persisted `#override`.                                                                                                                                                                                 |
| `createRecoveredWorkflow`     | function | Builds an interrupted workflow back to life at its remaining retry budget, normalizing a leaf whose attempts are exhausted into a recovery failure.                                                                                                                                                                                                                                                            |
| `createMemoryWorkflowStore`   | function | Creates the in-memory durable `WorkflowStoreInterface` — a process-lifetime `MemoryWorkflowStore` persisting `WorkflowSnapshot`s by workflow id, the default backend behind the W-d persistence seam. It takes no options and expires nothing: a persisted run state lives until an explicit `delete`.                                                                                                         |
| `createDatabaseWorkflowStore` | function | Creates a `DatabaseWorkflowStore` over any `DriverInterface` — the durable, driver-pluggable backing for the W-d persistence seam, the opt-in twin of `createMemoryWorkflowStore`. It holds the snapshot as one opaque JSON column, and its `driver` defaults to memory, so it works before any durable driver is passed.                                                                                      |
| `createWorkflowRunner`        | function | Creates the thin orchestrator — a `WorkflowRunnerInterface` — that executes a live W-b workflow tree by composing the shipped substrate: phases sequential, tasks concurrent, each task dispatched through its own resolved handler under the workflow's `bail` policy. The engine is pure — it carries no behavior or provider registry, and its only option is the scheduler it paces phase boundaries with. |
| `createWorkflowManager`       | function | Creates a `WorkflowManagerInterface` — the store-backed registry of `WorkflowInterface`s, the additive manager tier mirroring the `@orkestrel/agent` line's `createConversationManager` / `createWorkspaceManager`. The returned registry makes hydrated named work runnable when `options.functions` is supplied, and leaves it inspectable when it is not.                                                   |
| `createScheduler`             | function | Creates the safe cross-environment cooperative-yield default — a `SchedulerInterface` built on `setTimeout` / `clearTimeout` alone, so it runs unchanged in both the browser and Node.                                                                                                                                                                                                                         |
| `createRunner`                | function | Creates a thin generic orchestrator that drives declared units — and any they `spawn` — through a bounded-concurrency queue, collecting their results in order and failing the run fast on the first genuine unit failure.                                                                                                                                                                                     |

### The entity tree

The live runtime mirror of a definition. Each entity class implements its interface exactly, so the `## Methods` tables following double as its per-instance method surface.

A phase and a task are minted by their parent and reached as `PhaseInterface` and `TaskInterface` — through `workflow.phase(id)` and `phase.task(id)`, or through the managers below. Their constructors take values only the parent produces, so the package keeps those classes internal and a consumer never builds one.

Every tier declares `description` as a required `string | undefined` member backed by a getter, so `'description' in entity` reports `true` whatever the definition declared and a reader takes absence from the value. The pure-JSON snapshot still omits the key when no prose was declared.

| Class          | Kind  | Summary                                                                                                                                                                                                                                               |
| -------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Workflow`     | class | Implements the live derived state machine (W-b) for a whole workflow — the observable root whose `LifecycleStatus` is computed from its phases under the `bail` policy and recomputed reactively as the cascade propagates up from a task transition. |
| `PhaseManager` | class | Implements the lean child manager of a `Workflow`'s live phases — the phase vocabulary over one insertion-ordered `Collection`, the phase analogue of `TaskManager`.                                                                                  |
| `TaskManager`  | class | Implements the lean child manager of a `Phase`'s live tasks — the task vocabulary over one insertion-ordered `Collection`, so positional order is preserved across an interior `skip` / `remove`.                                                     |
| `Collection`   | class | Implements the insertion-ordered gated store both lean managers hold — entities keyed by `id`, positional order preserved across an interior `skip` or `remove`.                                                                                      |

### The positional collection

`PhaseManager` and `TaskManager` differ only in the entity noun their refusals name and the patch shape they validate, so both hold one `Collection` and add nothing but their domain accessors (`phase` / `phases`, `task` / `tasks`). The store keys entities by `id` in a `Map` whose insertion order is the single source of positional truth, so order survives an interior `skip` (a status change, never a removal) and a snapshot restore reproduces it by re-`append`ing in order. `append` is the build-time wiring path and throws a `MUTATION` `WorkflowError` on a duplicate id; `add` / `remove` / `move` / `update` are its graceful `Result` counterparts, gating only on the target's own existence, `pending` status, id, and bounds. Build one over any entity carrying `id`, `status`, and `patch` — the `CollectionEntry` contract both live entities satisfy:

```ts
import { compileGuard } from '@orkestrel/contract'
import { Collection, taskUpdateShape } from '@orkestrel/workflow'
import type { TaskInterface, TaskUpdate } from '@orkestrel/workflow'

const store = new Collection<TaskInterface, TaskUpdate>('task', compileGuard(taskUpdateShape))
store.append(first) // the build-time wiring path
store.add(second, 0) // a Result boxing `second`, inserted before `first`
store.move(second.id, 1) // a Result — repositioned back to the end
store.update(first.id, { name: 'Renamed task' }) // a Result — patched while pending
store.entry(first.id) // the same task
store.entries() // [first, second], in positional order
store.count // 2
store.remove(second.id) // a Result boxing the dropped task
```

### The execution substrate

Beneath the engine sit the shipped primitives it composes — it re-implements none of them. The pure `WorkflowRunner` engine drives the live entity tree and folds the run-level bounds; the queue-backed `Runner` bounds and drives a set of units under a fail-fast policy; a `ControllerInterface` is the per-unit handle a `Runner` handler receives; and `TaskControllerInterface` mirrors it one tier up, as the handle a workflow-task `WorkflowFunction` receives. The engine carries no behavior or provider registry of its own — each live task resolves its `behavior` string once at construction into its own `handler`, and the engine invokes it.

Both handles are minted per dispatch from values only the driving engine holds — the unit's abort, the attempt signal, the spawn callback — so the package keeps their classes internal and a handler receives one rather than building one.

| Class                 | Kind  | Summary                                                                                                                                                                                                                            |
| --------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowRunner`      | class | Implements the thin orchestrator that executes a live W-b workflow tree by composing the shipped substrate — phases sequential, tasks concurrent — dispatching each task through its own resolved handler under the `bail` policy. |
| `WorkflowPersistence` | class | Coordinates advanced run-local snapshot persistence with one writer and one coalesced most recent obligation, normally composed through `execute({ store })` rather than built directly.                                           |
| `Runner`              | class | Implements a thin generic orchestrator that drives declared units — and any they `spawn` — through a bounded-concurrency `createQueue`, collecting ordered results.                                                                |
| `RunHolder`           | class | Holds the active phase `RunnerInterface` for one `WorkflowRunnerInterface.execute` call, for the lifetime of that run.                                                                                                             |

### Scheduler (pacing)

The cooperative host-yield primitive that paces the engine between phases: a loop decides what to do; the scheduler decides when the host regains control. Every backend delegates setup, exact settlement, caller cancellation, and handle cleanup to the exported `scheduleHost` lifecycle helper, and every `delay` — plus each macrotask fallback — routes its timer through the one exported `delayHost` boundary, so no backend arms a `setTimeout` of its own. It links an owned native composite to the optional caller signal before host work is armed, so patched caller listener methods cannot strand a wait, pre-abort schedules nothing, and the first completion, exact host failure, or exact caller reason settles once. A returned cancellation closure is cleanup only: even if it throws during a later caller abort or host failure, the already-winning exact reason still settles the promise without escaping or hanging.

```ts
import { scheduleHost } from '@orkestrel/workflow'

const controller = new AbortController()
await scheduleHost((complete) => {
	const handle = setTimeout(complete, 0)
	return () => clearTimeout(handle)
}, controller.signal)
```

| API         | Kind  | Summary                                                                                                                                                                                   |
| ----------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Scheduler` | class | Implements the safe cross-environment cooperative-yield default — a `SchedulerInterface` built on `setTimeout` / `clearTimeout` alone, so it runs unchanged in both the browser and Node. |

### Environment backends

Beyond the cross-environment default, each host has a native cooperative-yield primitive a `yield()` can reach for. The backends are standalone `SchedulerInterface` implementations that retain only feature detection and native start/cancel boundaries; `scheduleHost` is the one shared lifecycle. A pending `yield` / `delay` rejects with `signal.reason` _verbatim_, an already-aborted signal rejects with that same reason before arming, a signal that is not a native `AbortSignal` rejects before arming with a `WorkflowError` carrying the `SCHEDULE` code, caller signal method mutation is harmless, cancellation clears the returned handle once, cancellation-closure failure is contained after the winner is captured, and native composite arbitration prevents late completion, abort, or failure from resettling. Each backend's `delay(ms)` is a real `setTimeout`; only the `yield` primitive differs.

The **Node** backend ships in [`src/server`](../src/server), published through `@orkestrel/workflow/server`. `NodeScheduler.yield()` waits on `setImmediate` — the canonical Node "give the event loop a turn", running after the current operation and pending I/O. It deliberately does **not** use `node:timers/promises` (whose `{ signal }` option rejects with a Node `AbortError`, `code: 'ABORT_ERR'`, _not_ the caller's `reason`); its `setImmediate` / `setTimeout` boundaries compose `scheduleHost` to preserve the caller reason. `priority` is accepted but a no-op — Node has no priority primitive.

The **browser** backends ship in [`src/browser`](../src/browser), published through `@orkestrel/workflow/browser`, one per host-turn strategy. Each browser backend feature-detects its native API through `@orkestrel/contract` guards (`isRecord` / `isFunction`), never an `as`, and fall back to a real macrotask where it is absent:

- `BrowserScheduler.yield()` posts to the **Prioritized Task Scheduling API** (`scheduler.postTask`) at the mapped priority (`user` → `'user-blocking'`, `normal` → `'user-visible'`, `background` → `'background'`) — so the urgency hint is honoured — falling back to a `setTimeout(0)` macrotask where `scheduler.postTask` is absent (Firefox today). The caller's `signal` is **not** handed to `postTask` (whose own abort rejects with a platform `AbortError`, not the caller's `reason`); an internal controller cancels the posted task while the scheduler rejects with the verbatim caller reason, and an unexpected native promise rejection remains the exact host failure.
- `FrameScheduler.yield()` resumes before the next paint through `requestAnimationFrame` (and `cancelAnimationFrame` on abort) — for work that must batch per render frame and naturally pause while the tab is hidden. `priority` is a no-op.
- `IdleScheduler.yield()` resumes when the host is idle through `requestIdleCallback` (and `cancelIdleCallback` on abort), falling back to a `setTimeout(0)` macrotask where it is absent (Safari today) — for low-priority background work that must not contend with rendering or input. `priority` is a no-op.

| API                | Kind  | Summary                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NodeScheduler`    | class | Implements the Node `SchedulerInterface` — the server-native cooperative-yield backend whose `yield` waits on `setImmediate` and whose abort rejects with the caller's own reason. A `priority` hint is accepted and does nothing, because Node has no priority primitive.                                                            |
| `BrowserScheduler` | class | Implements the browser `SchedulerInterface` — the browser-native cooperative-yield backend built on the Prioritized Task Scheduling API (`scheduler.postTask`) at the mapped priority, falling back to a zero-delay macrotask where it is absent, and rejecting an aborted wait with the caller's own reason.                         |
| `FrameScheduler`   | class | Implements the frame-aligned `SchedulerInterface` — a browser cooperative-yield backend whose `yield` resumes before the next paint through `requestAnimationFrame`, rejecting an aborted wait with the caller's own reason. A `priority` hint is accepted and does nothing.                                                          |
| `IdleScheduler`    | class | Implements the idle-time `SchedulerInterface` — a browser cooperative-yield backend whose `yield` resumes when the host is idle through `requestIdleCallback`, falling back to a zero-delay macrotask where it is absent, and rejecting an aborted wait with the caller's own reason. A `priority` hint is accepted and does nothing. |

| API                      | Kind     | Summary                                                                                                                                                                                                                                                                |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createNodeScheduler`    | function | Creates the Node-native cooperative-yield `SchedulerInterface` — `yield()` is a `setImmediate` host-turn (the canonical Node "give the event loop a turn"), `delay(ms)` a real `setTimeout`.                                                                           |
| `createBrowserScheduler` | function | Creates the browser-native cooperative-yield `SchedulerInterface` — `yield()` uses the Prioritized Task Scheduling API (`scheduler.postTask`) at the requested priority when present, falling back to a `setTimeout(0)` macrotask; `delay(ms)` is a real `setTimeout`. |
| `createFrameScheduler`   | function | Creates the frame-aligned cooperative-yield `SchedulerInterface` — `yield()` resumes before the next paint through `requestAnimationFrame`; `delay(ms)` is a real `setTimeout`.                                                                                        |
| `createIdleScheduler`    | function | Creates the idle-time cooperative-yield `SchedulerInterface` — `yield()` resumes when the host is idle through `requestIdleCallback` when present, falling back to a `setTimeout(0)` macrotask; `delay(ms)` is a real `setTimeout`.                                    |

The browser backends also publish supporting members through `@orkestrel/workflow/browser`: the `POST_TASK_PRIORITY` map `BrowserScheduler` reads to translate a portable `SchedulerPriority` into a `scheduler.postTask` priority level, and the `IdleInterface` shape of the feature-detected `requestIdleCallback` / `cancelIdleCallback` pair `IdleScheduler` narrows to (or resolves to `undefined`, falling back to a macrotask).

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`.

| Type            | Kind      | Shape                 | Summary                                                                                                    |
| --------------- | --------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `IdleInterface` | interface | `{ request, cancel }` | Declares the narrowed `requestIdleCallback` / `cancelIdleCallback` pair feature-detected off `globalThis`. |

A `Shape` cell holds the constant's declared type.

| API                  | Kind  | Shape                                         | Summary                                                                                                                                                                           |
| -------------------- | ----- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST_TASK_PRIORITY` | const | `Readonly<Record<SchedulerPriority, string>>` | Maps each portable `SchedulerPriority` to the browser-native `postTask` priority — `user` to `'user-blocking'`, `normal` to `'user-visible'`, and `background` to `'background'`. |

Each backend is a standalone `implements SchedulerInterface`, so its public methods are exactly `yield` / `delay` — the same [Methods](#methods) table governs every one.

### Stores

The durable persistence seam (W-d) — a dual-store convention (the `QueueStore` / `SessionStore` pattern). A `WorkflowStoreInterface` persists the pure-JSON `WorkflowSnapshot` keyed by workflow id through interchangeable backends: `MemoryWorkflowStore` (a plain `Map`, the zero-plumbing default, `createMemoryWorkflowStore`) and `DatabaseWorkflowStore` (the opt-in, driver-pluggable twin over a `databases` table, the snapshot stored as one opaque JSON column, `createDatabaseWorkflowStore`). Both live under `src/core/stores/`. The Database store's driver defaults to memory, so it also works in memory out of the box; you opt into the durable plumbing (JSON / SQLite / IndexedDB) by passing a driver — and it swaps in through the same interface, without touching the engine or the entity tree. Restore stays the shipped `createRestoredWorkflow`.

| Class                   | Kind  | Summary                                                                                                                                                                                                                                                                                            |
| ----------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryWorkflowStore`   | class | Implements the in-memory `WorkflowStoreInterface` — a process-lifetime `Map` of `WorkflowSnapshot`s keyed by workflow id, the default store `createMemoryWorkflowStore` builds. It expires nothing: a persisted snapshot lives until an explicit `delete`.                                         |
| `DatabaseWorkflowStore` | class | Implements a `WorkflowStoreInterface` backed by one table of the `databases` layer — a workflow's durable run state is a row, so persistence reduces to keyed point-access (`get` / `set` / `delete`) over a `TableInterface`, the driver-pluggable twin of the plain-`Map` `MemoryWorkflowStore`. |

### Registry

The additive manager tier, following the `@orkestrel/agent` line's store standard: `WorkflowManager` (`createWorkflowManager`) is an insertion-ordered registry of live `WorkflowInterface`s keyed by `id`, mirroring `ConversationManager` / `WorkspaceManager` — with the same optional `store` seam (`open` hydrates on a registry miss, `save` persists) but no `active` / `switch` pointer (nothing in this domain renders "the current workflow"). The workflow-specific nuance: the manager also carries an optional `functions` registry threaded into every mint (`add`, through `createWorkflow`) and every hydrate (`open`, through `createRestoredWorkflow`). With functions, named work is runnable; without them, exact hydrated state remains inspectable and execution refuses unresolved names.

| Class             | Kind  | Summary                                                                                                                                                                                                                                                                                                      |
| ----------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkflowManager` | class | Implements the store-backed registry of `WorkflowInterface`s keyed by `id`, in insertion order — the additive manager tier mirroring the `@orkestrel/agent` line's `ConversationManager` / `WorkspaceManager`. Event-free (a registry, like its twins); the observability lives on each `WorkflowInterface`. |

### Errors

| API               | Kind     | Summary                                                                                                                                                                                                                                       |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowError`   | class    | Represents an error the workflow runtime raises for an operation it refuses — a `WorkflowErrorCode` (`TRANSITION`, `RESTORE`, `MUTATION`, `SCHEDULE`, or `INVARIANT`) beside an optional `context` naming the node or the parameter at fault. |
| `isWorkflowError` | function | Narrows an unknown caught value to a `WorkflowError`.                                                                                                                                                                                         |

Every error this package raises for a refused operation of its own is a `WorkflowError`, narrowable with `isWorkflowError`. These values are deliberately not translated and reach the caller unchanged: a value thrown by a consumer-supplied `WorkflowFunction`, a value thrown or rejected by a consumer-supplied `WorkflowStoreInterface`, a value thrown by the `start` closure a caller hands `scheduleHost` or reported through its `failure` callback, and the `reason` an `AbortSignal` carries — a pending wait rejects with that reason verbatim, which is what makes cancellation identity-preserving. Each is a caller-owned value the package passes through on purpose, not a package fault it failed to wrap.

Dependency-owned errors still reach callers untranslated. These are known gaps, not intended pass-throughs: `createRunner` surfaces `@orkestrel/queue`'s `QueueError` for an invalid `concurrency` / `retries` / `timeout`, and `createDatabaseWorkflowStore`'s `get` / `set` / `delete` surface `@orkestrel/database`'s `DatabaseError`. Until they are folded into `WorkflowError`, narrow them with the owning package's own guard rather than `isWorkflowError`.

### Helpers & guards

Centralized, exhaustively unit-tested helpers and guards. The status derivations are pure and encode the lifecycle truth tables; the lineage / snapshot builders seed the entity tree; `scheduleHost` owns the scheduler's intentionally effectful host lifecycle.

Generic exact-JSON ownership comes directly from [`@orkestrel/contract`](contract.md):
consumers import its `JSONRecord`, `cloneJSONValue`, and `cloneJSONRecord` from their
originating package. Workflow does not re-export them. Its domain cloners below add
workflow-specific validation and translate ownership failures into `WorkflowError`.

| API                         | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloneWorkflowSnapshot`     | function | Validates and owns a workflow snapshot before live construction.                                                                                                                                                                                                                                                                                                                                 |
| `isWorkflowSnapshot`        | function | Guards the hostile boundary totally for a workflow snapshot.                                                                                                                                                                                                                                                                                                                                     |
| `isOwnedWorkflowSnapshot`   | function | Validates a safe owned JSON graph as a coherent workflow snapshot.                                                                                                                                                                                                                                                                                                                               |
| `isLifecycleStatus`         | function | Checks whether an unknown value belongs to the workflow lifecycle vocabulary.                                                                                                                                                                                                                                                                                                                    |
| `isTaskFailure`             | function | Tests a normalized persisted task failure.                                                                                                                                                                                                                                                                                                                                                       |
| `isTaskResult`              | function | Tests a result's lineage against its containing snapshot nodes.                                                                                                                                                                                                                                                                                                                                  |
| `matchesDescription`        | function | Compares two optional description values.                                                                                                                                                                                                                                                                                                                                                        |
| `hasWorkflowHandlers`       | function | Tests that every named task has a callable runtime handler before dispatch.                                                                                                                                                                                                                                                                                                                      |
| `scanSnapshotContext`       | function | Locates the nearest identifiable node for an inconsistent owned snapshot.                                                                                                                                                                                                                                                                                                                        |
| `isTerminalStatus`          | function | Tests whether a `LifecycleStatus` is terminal — `completed`, `failed`, `skipped`, or `stopped`, the states a node never transitions out of.                                                                                                                                                                                                                                                      |
| `derivePhaseStatus`         | function | Derives a phase's status from its tasks' statuses, the most severe terminal status winning (tasks are concurrent, so this is an order-insensitive reduction).                                                                                                                                                                                                                                    |
| `deriveWorkflowStatus`      | function | Derives a workflow's status from its phases' `PhaseDerivation`s — each phase's status paired with the effective `bail` it ran under (`phase.bail ?? workflow.bail`) — so the failure outcome is aware of each phase's own policy, and `failed` is reachable only where that policy is `true` (phases are sequential, but the derivation is an order-insensitive reduction over the settled set). |
| `deriveBoundary`            | function | Derives the pending-suffix boundary of a positional list of `LifecycleStatus`es — the index of the first entry in the contiguous trailing run of `pending` entries, or the list's length where it has none.                                                                                                                                                                                      |
| `canTransitionTask`         | function | Tests whether the live W-b task state machine may move directly from one `LifecycleStatus` to another — the legal-transition guard.                                                                                                                                                                                                                                                              |
| `resolveTaskSilence`        | function | Resolves a task's runtime silence window against its workflow default, to a host-safe `1..MAX_TIMER_MS` window or to `undefined` where the task disables it.                                                                                                                                                                                                                                     |
| `cloneTaskActivity`         | function | Validates and clones one complete task activity frame.                                                                                                                                                                                                                                                                                                                                           |
| `isTaskActivityInput`       | function | Tests whether an unknown value is a valid whole-frame activity report.                                                                                                                                                                                                                                                                                                                           |
| `isTaskActivity`            | function | Tests whether an unknown value is valid persisted task activity.                                                                                                                                                                                                                                                                                                                                 |
| `captureWorkflowOptions`    | function | Captures every top-level `WorkflowOptions` value exactly once into an owned plain bag.                                                                                                                                                                                                                                                                                                           |
| `scheduleHost`              | function | Schedules one cancellable host operation behind an owned settlement signal.                                                                                                                                                                                                                                                                                                                      |
| `success`                   | function | Boxes a value as a `Success` — the graceful outcome half of a `Result`.                                                                                                                                                                                                                                                                                                                          |
| `failure`                   | function | Boxes an error as a `Failure` — the graceful outcome half of a `Result`.                                                                                                                                                                                                                                                                                                                         |
| `errorToMessage`            | function | Normalizes an unknown thrown value to a non-empty persistence-safe message.                                                                                                                                                                                                                                                                                                                      |
| `findFailure`               | function | Finds the first `TaskResult` in a positional list whose boxed outcome is a `Failure` — the pure scan shared by a phase's and a workflow's derived-`failed` `fail`-event lookup.                                                                                                                                                                                                                  |
| `buildWorkflowContext`      | function | Builds a `WorkflowContext` — the identity every level inherits — from a node's `id` / `name` / optional `description`.                                                                                                                                                                                                                                                                           |
| `buildPhaseContext`         | function | Builds a `PhaseContext` — a phase's own identity plus a back-reference to its workflow — from the parent `WorkflowContext` and the phase node's identity.                                                                                                                                                                                                                                        |
| `buildTaskContext`          | function | Builds a `TaskContext` — a task's own identity plus a back-reference to its phase (and, transitively, its workflow) — from the parent `PhaseContext` and the task node's identity.                                                                                                                                                                                                               |
| `definitionToSnapshot`      | function | Converts a `WorkflowDefinition` into an initial `WorkflowSnapshot` — every node `pending`, no results, empty metadata — so the live W-b tree has one construction path, snapshot-driven, for a fresh build and for a restore alike.                                                                                                                                                              |
| `phaseDefinitionToSnapshot` | function | Converts one `PhaseDefinition` into an initial, all-`pending` `PhaseSnapshot` — the per-phase step of `definitionToSnapshot`.                                                                                                                                                                                                                                                                    |
| `taskDefinitionToSnapshot`  | function | Converts one `TaskDefinition` into an initial, `pending` `TaskSnapshot` — the per-task leaf step of `definitionToSnapshot` (no result yet, empty metadata).                                                                                                                                                                                                                                      |
| `recoverWorkflowSnapshot`   | function | Converts interrupted running work into a recoverable pending suffix or an exhausted recovery failure without replenishing attempts.                                                                                                                                                                                                                                                              |
| `collectResults`            | function | Flattens a nested list of per-phase `TaskResult` lists into one positional list — the workflow tier of the result tree, built from each phase's `results()`.                                                                                                                                                                                                                                     |
| `parkSignal`                | function | Parks until `signal` aborts — a promise-parked wait, never a timer or busy-loop, that resolves on the abort event and never rejects.                                                                                                                                                                                                                                                             |
| `insertEntry`               | function | Inserts one `[key, value]` entry at a positional index into a readonly entries array — the pure splice-in step behind an insertion-ordered registry's `add`.                                                                                                                                                                                                                                     |
| `moveEntry`                 | function | Repositions the entry keyed `key` to a new positional index in a readonly entries array — the pure remove-then-reinsert step behind an insertion-ordered registry's `move`.                                                                                                                                                                                                                      |
| `delayHost`                 | function | Schedules the shared host timer boundary every scheduler backend resumes from.                                                                                                                                                                                                                                                                                                                   |
| `isWorkflowInterface`       | function | Checks whether an unknown value is a live workflow entity rather than a definition.                                                                                                                                                                                                                                                                                                              |
| `isTaskClaimList`           | function | Checks whether an unknown value is a valid list of task activity claims.                                                                                                                                                                                                                                                                                                                         |
| `cloneTaskClaims`           | function | Validates and owns one list of task activity claims.                                                                                                                                                                                                                                                                                                                                             |
| `isHalted`                  | function | Tests whether a driving run must stop giving a workflow — or one forced phase of it — more work.                                                                                                                                                                                                                                                                                                 |
| `isStoppable`               | function | Tests whether forcing a workflow `stopped` would still record the cancellation.                                                                                                                                                                                                                                                                                                                  |
| `isCompletable`             | function | Tests whether a naturally-finished run may force its workflow `completed`.                                                                                                                                                                                                                                                                                                                       |
| `isSkipping`                | function | Tests whether a task attempt is being genuinely cancelled rather than merely timed out.                                                                                                                                                                                                                                                                                                          |
| `ownsAttempt`               | function | Tests whether one attempt still owns the task it launched.                                                                                                                                                                                                                                                                                                                                       |

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
	scanSnapshotContext,
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
				tasks: [{ id: 'task', name: 'Task', behavior: 'work', retries: 1 }],
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
scanSnapshotContext({ ...snapshot, bail: 'invalid' })
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

const input = { progress: { progress: 2, total: 10, message: 'Indexing files' } }
if (isTaskActivityInput(input)) {
	const activity = cloneTaskActivity(input, Date.now())
	isTaskActivity(activity) // true
}
resolveTaskSilence(0, 30_000) // undefined: the task explicitly disables inheritance
```

### Shapes

`createWorkflowContract` derives its lockstep JSON Schema, guard, parser, and generator from these shape values. They agree with the hand-written definition interfaces (the source of truth); a round-trip parity test (`generate → is → parse`) guards against drift.

A `Shape` cell holds the constant's declared type.

| API                | Kind  | Shape                                                                    | Summary                                                                                                                                                                                                                                                                   |
| ------------------ | ----- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taskShape`        | const | `ObjectShape<{ id, name, description?, behavior?, retries?, timeout? }>` | Describes the shape of a `TaskDefinition` — identity plus an optional `behavior` behavior reference (a plain registry-key string, min length 1). `description` is optional prose.                                                                                         |
| `phaseShape`       | const | `ObjectShape<{ id, name, description?, tasks, concurrency?, bail? }>`    | Describes the shape of a `PhaseDefinition` — identity, its ordered `taskShape` tasks, and an optional positive-integer `concurrency` throttle (max tasks in flight; omitted ⇒ unbounded).                                                                                 |
| `workflowShape`    | const | `ObjectShape<{ id, name, description?, phases, bail? }>`                 | Describes the shape of a `WorkflowDefinition` — the contract root: identity, its ordered `phaseShape` phases, and the optional `bail` boolean failure policy (the literal pair `true`/`false`, the runtime mirror of the boolean toggle; omitted ⇒ the graceful default). |
| `taskUpdateShape`  | const | `ObjectShape<{ name?, description? }>`                                   | Describes the shape of a `TaskUpdate` — a partial edit to a `pending` task's `name` / `description`, both optional.                                                                                                                                                       |
| `phaseUpdateShape` | const | `ObjectShape<{ name?, description?, concurrency?, bail? }>`              | Describes the shape of a `PhaseUpdate` — a partial edit to a `pending` phase's `name` / `description` / `concurrency` / `bail`, all optional.                                                                                                                             |

### Constants

A `Shape` cell holds the constant's declared type.

| Constant                    | Kind  | Shape                                                           | Summary                                                                                                                                                                                                                 |
| --------------------------- | ----- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_BAIL`              | const | `boolean`                                                       | Names the default `WorkflowDefinition.bail`, `false` — the graceful policy that records a leaf failure and finishes every phase.                                                                                        |
| `LIFECYCLE_STATUSES`        | const | `readonly LifecycleStatus[]`                                    | Lists every `LifecycleStatus` value, frozen — the vocabulary every tier draws from, in the order `pending`, `running`, `completed`, `failed`, `skipped`, `stopped`.                                                     |
| `TERMINAL_STATUSES`         | const | `readonly LifecycleStatus[]`                                    | Lists the terminal `LifecycleStatus` values, frozen — `completed`, `failed`, `skipped`, and `stopped`, each a state a node never transitions out of.                                                                    |
| `TASK_TRANSITIONS`          | const | `Readonly<Record<LifecycleStatus, readonly LifecycleStatus[]>>` | Declares the legal `LifecycleStatus` transition graph of the live W-b task state machine — each current status mapped to the statuses it may move to directly, frozen.                                                  |
| `DEFAULT_PHASE_CONCURRENCY` | const | `number`                                                        | Names the default per-phase task concurrency the `createWorkflowRunner` runner applies when a `PhaseDefinition` omits its `concurrency` throttle — `1024`, a cap that is effectively unbounded for any realistic phase. |
| `MAX_TIMER_MS`              | const | `number`                                                        | Names the largest delay representable by the host timer APIs without overflow or clamping, `2_147_483_647` milliseconds.                                                                                                |
| `PERSISTED_NODE_EVENTS`     | const | `ReadonlyArray<keyof WorkflowEventMap & keyof PhaseEventMap>`   | Lists the `WorkflowEventMap` / `PhaseEventMap` events that make a durable observer re-persist the live tree, frozen — `start`, `complete`, `fail`, `skip`, `stop`, `move`, and `update`.                                |
| `PERSISTED_TASK_EVENTS`     | const | `ReadonlyArray<keyof TaskEventMap>`                             | Lists the `TaskEventMap` events that make a durable observer re-persist the live tree, frozen — `start`, `complete`, `fail`, `skip`, `stop`, `report`, and `pulse`.                                                     |

### Types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`.

| Type                           | Kind      | Shape                                                                                                                                                                                                                                                                | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskDefinition`               | interface | `{ id, name, description?, behavior?, retries?, timeout? }`                                                                                                                                                                                                          | Represents the serializable definition of one task — its identity, an optional reference to the behavior it runs, and its optional per-task `retries` and `timeout` overrides.                                                                                                                                                                                                                                                                                                                |
| `PhaseDefinition`              | interface | `{ id, name, description?, tasks, concurrency?, bail? }`                                                                                                                                                                                                             | Represents the serializable definition of one phase — its identity, its ordered tasks, an optional resource throttle, and an optional `bail` override of the workflow policy.                                                                                                                                                                                                                                                                                                                 |
| `WorkflowDefinition`           | interface | `{ id, name, description?, phases, bail? }`                                                                                                                                                                                                                          | Represents the serializable definition of a whole workflow — its identity, its ordered phases, and the `bail` failure policy.                                                                                                                                                                                                                                                                                                                                                                 |
| `WorkflowContext`              | interface | `{ id, name, description? }`                                                                                                                                                                                                                                         | Represents the ambient context of a workflow — the identity every level inherits.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PhaseContext`                 | interface | `{ id, name, description?, workflow }`                                                                                                                                                                                                                               | Represents the ambient context of a phase — its own identity plus a back-reference to the workflow it belongs to.                                                                                                                                                                                                                                                                                                                                                                             |
| `TaskContext`                  | interface | `{ id, name, description?, phase }`                                                                                                                                                                                                                                  | Represents the ambient context of a task — its own identity plus a back-reference to the phase (and, transitively, the workflow) it belongs to.                                                                                                                                                                                                                                                                                                                                               |
| `WorkflowInput`                | type      | `Partial<WorkflowContext>`                                                                                                                                                                                                                                           | Represents the minimal data to create a workflow context — a partial `WorkflowContext`.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PhaseInput`                   | type      | `Partial<PhaseContext>`                                                                                                                                                                                                                                              | Represents the minimal data to create a phase context — a partial `PhaseContext`.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `TaskInput`                    | interface | `{ id?, name?, description?, phase?, metadata? }`                                                                                                                                                                                                                    | Represents the minimal data to create a task context — a partial `TaskContext` plus the open `metadata` bag the task stores and snapshots without interpreting it.                                                                                                                                                                                                                                                                                                                            |
| `TaskProgress`                 | interface | `{ progress, total?, message? }`                                                                                                                                                                                                                                     | Represents the aggregate progress most recently reported by a running task.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `TaskClaim`                    | interface | `{ id, name, started }`                                                                                                                                                                                                                                              | Represents one identified thing a running task claims active, with the moment the claim began — the shape `TaskOperation` and `TaskConstraint` share.                                                                                                                                                                                                                                                                                                                                         |
| `TaskOperation`                | interface | `{ id, name, started }`                                                                                                                                                                                                                                              | Represents one operation claimed active when a running task's complete frame was accepted.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `TaskConstraint`               | interface | `{ id, name, started }`                                                                                                                                                                                                                                              | Represents one constraint claimed active when a running task's complete frame was accepted.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `TaskActivityInput`            | interface | `{ note?, progress?, operations?, constraints? }`                                                                                                                                                                                                                    | Represents one complete replacement of a running task's observable activity, an omitted collection meaning an empty one.                                                                                                                                                                                                                                                                                                                                                                      |
| `TaskActivity`                 | interface | `{ note?, progress?, operations, constraints, updated }`                                                                                                                                                                                                             | Represents the bounded, JSON-serializable activity most recently accepted from a task reporter.                                                                                                                                                                                                                                                                                                                                                                                               |
| `TaskUpdate`                   | interface | `{ name?, description? }`                                                                                                                                                                                                                                            | Represents a declarative partial update to a `TaskInterface` — the fields a `pending` task's `TaskInterface.patch` (and the owning `TaskManagerInterface.update`) accept, runtime-validated through `taskUpdateShape`.                                                                                                                                                                                                                                                                        |
| `PhaseUpdate`                  | interface | `{ name?, description?, concurrency?, bail? }`                                                                                                                                                                                                                       | Represents a declarative partial update to a `PhaseInterface` — the fields a `pending` phase's `PhaseInterface.patch` (and the owning `PhaseManagerInterface.update`) accept, runtime-validated through `phaseUpdateShape`.                                                                                                                                                                                                                                                                   |
| `WorkflowErrorCode`            | type      | `'TRANSITION' \| 'RESTORE' \| 'MUTATION' \| 'SCHEDULE' \| 'INVARIANT'`                                                                                                                                                                                               | Names the machine-readable code of a `WorkflowError` — the fault the live W-b state machine raises.                                                                                                                                                                                                                                                                                                                                                                                           |
| `LifecycleStatus`              | type      | `'pending' \| 'running' \| 'completed' \| 'failed' \| 'skipped' \| 'stopped'`                                                                                                                                                                                        | Names the shared lifecycle vocabulary every tier draws from — `pending` before it runs, `running` while in flight, then one of the terminal states `completed` / `failed` / `skipped` / `stopped`.                                                                                                                                                                                                                                                                                            |
| `PhaseDerivation`              | interface | `{ status, bail }`                                                                                                                                                                                                                                                   | Represents one phase's contribution to the workflow-status derivation — its `LifecycleStatus` paired with the effective `bail` policy it ran under (`phase.bail ?? workflow.bail`) — the input shape `deriveWorkflowStatus` reduces.                                                                                                                                                                                                                                                          |
| `TaskFailureOrigin`            | type      | `'handler' \| 'timeout' \| 'recovery'`                                                                                                                                                                                                                               | Names where a task failure arose — the axis a persisted `TaskFailure` records.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `TaskFailure`                  | interface | `{ origin, message }`                                                                                                                                                                                                                                                | Represents a normalized JSON-safe task failure persisted without a stack or cause.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `TaskResult`                   | interface | `{ task, phase, workflow, status, result?, timestamp }`                                                                                                                                                                                                              | Represents the structured outcome of a task execution — its full lineage, its terminal status, the moment it settled, and its boxed produced outcome.                                                                                                                                                                                                                                                                                                                                         |
| `TaskSnapshot`                 | interface | `{ id, name, description?, status, result?, metadata, attempts, behavior?, retries?, timeout?, activity? }`                                                                                                                                                          | Represents a JSON-serializable snapshot of one task's state — the leaf of the snapshot tree the durable store (W-d) persists.                                                                                                                                                                                                                                                                                                                                                                 |
| `PhaseSnapshot`                | interface | `{ id, name, description?, status, override?, bail, concurrency?, tasks }`                                                                                                                                                                                           | Represents a JSON-serializable snapshot of one phase's state — its identity, status, the forced override a whole-phase `skip` or `stop` left, the effective `bail` and `concurrency` it ran under, and its nested task snapshots.                                                                                                                                                                                                                                                             |
| `WorkflowSnapshot`             | interface | `{ id, name, description?, status, override?, bail, phases, created, updated }`                                                                                                                                                                                      | Represents a JSON-serializable snapshot of a whole workflow's state — its identity, status, its forced override (if any), the `bail` policy it ran under, its nested phase snapshots, and creation / update timestamps.                                                                                                                                                                                                                                                                       |
| `WorkflowStoreInterface`       | interface | `{} plus get, set, delete`                                                                                                                                                                                                                                           | Declares the durable persistence seam for a `WorkflowSnapshot` — the async `get` / `set` / `delete` primitives keyed by a workflow id, the snapshot analogue of the server package's `SessionStoreInterface` (and the `@orkestrel/queue` `QueueStoreInterface` driver-swap pattern).                                                                                                                                                                                                          |
| `WorkflowSnapshotRow`          | interface | `{ id, snapshot }`                                                                                                                                                                                                                                                   | Represents one row of the table a `DatabaseWorkflowStore` persists — a workflow `id` plus its `WorkflowSnapshot` held as one opaque JSON column, read back as `unknown` and narrowed on `get`.                                                                                                                                                                                                                                                                                                |
| `WorkflowEventMap`             | type      | `{ start, complete, fail, pause, resume, skip, stop, add, remove, move, update }`                                                                                                                                                                                    | Declares the push observation surface of the workflow entity (W-b) — the lifecycle moments a fire-and-forget observer subscribes to through `workflow.emitter.on`.                                                                                                                                                                                                                                                                                                                            |
| `PhaseEventMap`                | type      | `{ start, complete, fail, pause, resume, skip, stop, add, remove, move, update }`                                                                                                                                                                                    | Declares the push observation surface of the phase entity (W-b) — analogous to `WorkflowEventMap`, scoped to one phase.                                                                                                                                                                                                                                                                                                                                                                       |
| `TaskEventMap`                 | type      | `{ start, complete, fail, pause, resume, skip, stop, report, pulse, silence }`                                                                                                                                                                                       | Declares the push observation surface of the task entity (W-b) — the lifecycle moments of one task.                                                                                                                                                                                                                                                                                                                                                                                           |
| `TaskOptions`                  | interface | `{ on?, error?, metadata?, silence? }`                                                                                                                                                                                                                               | Declares the runtime options for a `TaskInterface` — the construction bag the live leaf state machine (W-b) carries that the W-a `TaskDefinition` did not.                                                                                                                                                                                                                                                                                                                                    |
| `PhaseOptions`                 | interface | `{ on?, error?, tasks? }`                                                                                                                                                                                                                                            | Declares the runtime options for a `PhaseInterface` — the construction bag the live derived phase state machine (W-b) carries.                                                                                                                                                                                                                                                                                                                                                                |
| `WorkflowOptions`              | interface | `{ on?, bail?, error?, phases?, functions?, silence? }`                                                                                                                                                                                                              | Declares the runtime options for a `WorkflowInterface` — the construction bag the live derived workflow state machine (W-b) carries, the root `createWorkflow` accepts.                                                                                                                                                                                                                                                                                                                       |
| `WorkflowInterface`            | interface | `{ emitter, id, name, description, context, bail, status, phases, paused, destroyed, signal } plus phase, results, skip, stop, complete, pause, resume, destroy, wait, add, remove, move, update, snapshot`                                                          | Declares the live derived state machine (W-b) for a whole `WorkflowDefinition` — the observable root whose `LifecycleStatus` is derived from its phases under the `bail` policy and recomputed reactively as the cascade propagates up.                                                                                                                                                                                                                                                       |
| `PhaseInterface`               | interface | `{ emitter, id, name, description, context, workflow, status, bail, concurrency, paused, tasks } plus task, results, skip, stop, pause, resume, wait, add, remove, move, update, patch, snapshot`                                                                    | Declares the live derived state machine (W-b) for one `PhaseDefinition` — an observable phase whose `LifecycleStatus` is derived from its tasks (never set directly) and recomputed reactively as a task transitions (the cascade).                                                                                                                                                                                                                                                           |
| `TaskInterface`                | interface | `{ emitter, id, name, description, context, phase, workflow, status, attempts, result, behavior, handler, retries, timeout, activity, silence, silent, paused, signal } plus start, complete, fail, skip, stop, report, pulse, pause, resume, wait, patch, snapshot` | Declares the live leaf state machine (W-b) for one `TaskDefinition` — an observable, guarded synchronous task whose explicit `LifecycleStatus` advances through the declared transitions.                                                                                                                                                                                                                                                                                                     |
| `TaskManagerInterface`         | interface | `{ count } plus append, add, remove, move, update, task, tasks`                                                                                                                                                                                                      | Declares the lean child manager of a `PhaseInterface`'s live tasks — positional accessors plus `count`, backed by an insertion-ordered store so order is preserved across an interior `skip` / `remove`.                                                                                                                                                                                                                                                                                      |
| `PhaseManagerInterface`        | interface | `{ count } plus append, add, remove, move, update, phase, phases`                                                                                                                                                                                                    | Declares the lean child manager of a `WorkflowInterface`'s live phases — positional accessors plus `count`, the phase analogue of `TaskManagerInterface`.                                                                                                                                                                                                                                                                                                                                     |
| `CollectionEntry`              | interface | `{ id, status } plus patch`                                                                                                                                                                                                                                          | Declares what the `CollectionInterface` store requires of the entities it holds — a stable `id`, a gating `LifecycleStatus`, and a `patch` the store applies after validation.                                                                                                                                                                                                                                                                                                                |
| `CollectionInterface`          | interface | `{ count } plus append, add, remove, move, update, entry, entries`                                                                                                                                                                                                   | Declares an insertion-ordered store of `CollectionEntry` entities keyed by `id`, with the gated mutation quartet a lean manager delegates to.                                                                                                                                                                                                                                                                                                                                                 |
| `WorkflowFunction`             | type      | `(controller: TaskControllerInterface) => Promise<JSONValue> \| JSONValue`                                                                                                                                                                                           | Declares the registered behavior a `function`-form `TaskDefinition` runs, resolved by name through the `WorkflowRegistry` registry — a function type the framework invokes.                                                                                                                                                                                                                                                                                                                   |
| `WorkflowRegistry`             | type      | `Readonly<Record<string, WorkflowFunction>>`                                                                                                                                                                                                                         | Declares the `function`-task behavior registry — workflow function names mapped to their `WorkflowFunction` handlers.                                                                                                                                                                                                                                                                                                                                                                         |
| `TaskControllerInterface`      | interface | `{ signal, aborted, input, task, attempt, paused } plus report, pulse, wait, results`                                                                                                                                                                                | Declares the per-task handle a `WorkflowFunction` receives — the running task's cancellation, its input, its lineage, and read access up the tree to the results already settled.                                                                                                                                                                                                                                                                                                             |
| `AttemptOutcome`               | type      | `readonly [settled: true, value: JSONValue] \| readonly [settled: false, value: undefined, genuine?: boolean]`                                                                                                                                                       | Names how one task attempt left the race between its handler and its cancellation.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `RunHolderInterface`           | interface | `{ runner } plus hold`                                                                                                                                                                                                                                               | Holds the phase `RunnerInterface` one `WorkflowRunnerInterface.execute` call is driving, for the lifetime of that run.                                                                                                                                                                                                                                                                                                                                                                        |
| `WorkflowResult`               | interface | `{ workflow, status, results, durable?, fault? }`                                                                                                                                                                                                                    | Represents the structured outcome of a `WorkflowRunnerInterface.execute` run — the settled live workflow, its final status, the flattened result tree, and the persistence outcome a supplied store produced.                                                                                                                                                                                                                                                                                 |
| `WorkflowCheckpoint`           | type      | `'initial' \| 'attempt' \| 'settlement' \| 'final'`                                                                                                                                                                                                                  | Names a runner-owned durability boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `WorkflowFault`                | interface | `{ checkpoint, message, task?, attempt? }`                                                                                                                                                                                                                           | Represents a normalized persistence failure surfaced as workflow result data.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `WorkflowPersistenceInterface` | interface | `{ fault } plus checkpoint, finalize, detach`                                                                                                                                                                                                                        | Declares the advanced run-local durability coordinator normally composed by `WorkflowRunnerInterface.execute` when `store` is supplied.                                                                                                                                                                                                                                                                                                                                                       |
| `WorkflowRunOptions`           | type      | `WorkflowOptions & { signal?, timeout?, budget?, store? }`                                                                                                                                                                                                           | Declares the options for one `WorkflowRunnerInterface.execute` call — the live tree's construction options (`WorkflowOptions`) beside the per-run controls: the bounds (an external abort, a deadline, and a cost ceiling), each folded into every task's cancellation, and the optional durable `store`.                                                                                                                                                                                     |
| `WorkflowRunnerOptions`        | interface | `{ scheduler? }`                                                                                                                                                                                                                                                     | Declares the options for `createWorkflowRunner` — the optional pacing scheduler the runner paces phase boundaries with.                                                                                                                                                                                                                                                                                                                                                                       |
| `WorkflowRunnerInterface`      | interface | `{} plus execute`                                                                                                                                                                                                                                                    | Declares a thin orchestrator that executes a live `WorkflowInterface` tree by composing the shipped substrate — phases sequential, tasks concurrent, each task dispatched through its own resolved handler under the `bail` policy.                                                                                                                                                                                                                                                           |
| `WorkflowManagerOptions`       | interface | `{ store?, functions? }`                                                                                                                                                                                                                                             | Declares the options for `createWorkflowManager` — the optional durable `WorkflowStoreInterface` seam plus the `WorkflowRegistry` registry every workflow the manager mints or hydrates resolves its tasks' handlers against.                                                                                                                                                                                                                                                                 |
| `WorkflowManagerInterface`     | interface | `{ count } plus workflow, workflows, add, open, save, remove, clear`                                                                                                                                                                                                 | Declares a store-backed registry of `WorkflowInterface`s keyed by their `id`, in insertion order — the additive manager tier mirroring `ConversationManagerInterface` / `WorkspaceManagerInterface` from the `@orkestrel/agent` line, adapted for the workflow domain: `add` mints from a `WorkflowDefinition`, and the optional `store` seam's `open` threads the manager's `WorkflowRegistry` registry, so a hydrated workflow is immediately runnable rather than a restored state mirror. |
| `SchedulerPriority`            | type      | `'user' \| 'normal' \| 'background'`                                                                                                                                                                                                                                 | Names the relative urgency hint for cooperative scheduling. Honoured by environment backends; the cross-environment default treats all priorities uniformly.                                                                                                                                                                                                                                                                                                                                  |
| `SchedulerOptions`             | interface | `{ priority?, signal? }`                                                                                                                                                                                                                                             | Declares the options for a single cooperative yield/delay.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SchedulerInterface`           | interface | `{} plus yield, delay`                                                                                                                                                                                                                                               | Declares a cooperative host-yield primitive: a loop decides what to do; the scheduler decides when the host regains control. It is abort-aware — a pending yield or delay rejects with the signal's reason when aborted.                                                                                                                                                                                                                                                                      |
| `ControllerInterface`          | interface | `{ id, input, signal, aborted } plus wait, spawn, abort`                                                                                                                                                                                                             | Declares the per-unit handle a `RunnerHandler` receives — the running unit's identity, input, cancellation, and the controls to cooperate with the run.                                                                                                                                                                                                                                                                                                                                       |
| `RunnerHandler`                | type      | `(controller: ControllerInterface<TInput, TResult>) => Promise<TResult> \| TResult`                                                                                                                                                                                  | Runs one unit's work, given its `ControllerInterface`.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `RunnerOptions`                | interface | `{ on?, error?, handler, concurrency?, retries?, timeout?, entries? }`                                                                                                                                                                                               | Declares the options for `createRunner` — the `handler` every unit runs, the queue bounds `concurrency`, `retries`, and `timeout`, the per-entry `entries` resolver, and the emitter `on` hooks and `error` handler.                                                                                                                                                                                                                                                                          |
| `RunnerEntryOptions`           | interface | `{ retries?, timeout? }`                                                                                                                                                                                                                                             | Declares the per-entry reliability overrides for one unit — its extra attempts on failure and its per-attempt deadline, resolved from the unit's input through `RunnerOptions.entries`.                                                                                                                                                                                                                                                                                                       |
| `RunnerInterface`              | interface | `{ emitter, active, stopped, paused } plus execute, spawn, abort, pause, resume, stop, destroy`                                                                                                                                                                      | Declares a thin generic orchestrator that drives declared units — plus any they `spawn` — through a bounded-concurrency queue, collecting their results in order.                                                                                                                                                                                                                                                                                                                             |
| `RunnerEventMap`               | type      | `{ start, unit, spawn, settle, fail, finish, abort }`                                                                                                                                                                                                                | Declares the push observation surface of a `RunnerInterface` — the run lifecycle a fire-and-forget observer (logging, metrics, tracing) subscribes to, beside the eventual `execute` result.                                                                                                                                                                                                                                                                                                  |
| `RunnerUnit`                   | interface | `{ id, input }`                                                                                                                                                                                                                                                      | Represents one unit the `RunnerInterface` is tracking: the queue payload it was enqueued with — its `id` (a random UUID) keys it in the runner's ordered launch list and value map, and `input` is the unit's work payload handed to the handler's `Controller`.                                                                                                                                                                                                                              |

## Methods

The public methods of each behavioral interface — one table per type, keyed by its backticked name, every call-signature member listed. Its `readonly` data members stay in the Surface rows above (`emitter` is the typed [emitter](emitter.md) push surface — see [Observing the live tree](#observing-the-live-tree); `status` / `result` / `context` / `signal` / `aborted` / `input` / `task` / `count` are read-state). Each entity and substrate class implements its interface exactly, so this doubles as the per-instance method surface.

#### `WorkflowInterface`

The live derived root. `status` is the override-or-derived workflow status (read-state, in the Surface row); the methods navigate down (`phase`), collect the result tree (`results`), force a terminal state (`skip` / `stop` / `complete`), pause/resume/park the run (`pause` / `resume` / `wait`), tear it down (`destroy`), mutate its pending-suffix phases (`add` / `remove` / `move` / `update`), and serialize (`snapshot`).

| Method     | Returns                                 | Summary                                                                                                                                                                                                                                                                                                |
| ---------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `phase`    | `PhaseInterface \| undefined`           | Looks up one live phase by its `id`.                                                                                                                                                                                                                                                                   |
| `results`  | `readonly TaskResult[]`                 | Lists every settled task's result across all phases, in positional order — the workflow tier of the result tree.                                                                                                                                                                                       |
| `skip`     | `void`                                  | Forces this workflow to `skipped`, overriding the derived value; idempotent.                                                                                                                                                                                                                           |
| `stop`     | `void`                                  | Forces this workflow to `stopped`, overriding the derived value; idempotent.                                                                                                                                                                                                                           |
| `complete` | `void`                                  | Forces this workflow to `completed`, overriding the derived value.                                                                                                                                                                                                                                     |
| `pause`    | `void`                                  | Suspends the workflow (resumable); idempotent.                                                                                                                                                                                                                                                         |
| `resume`   | `void`                                  | Continues a paused workflow; idempotent — a no-op unless `paused`.                                                                                                                                                                                                                                     |
| `destroy`  | `void`                                  | Tears this workflow down — one atomic terminal teardown: mark `destroyed`, pin non-terminal workflow/phase overrides to `stopped`, stop every non-terminal task, release gates and liveness resources, abort `signal`, then destroy task, phase, and workflow emitters in ownership order; idempotent. |
| `wait`     | `Promise<void>`                         | Parks until this workflow is not paused — a promise-parked wait, never a timer or busy-loop.                                                                                                                                                                                                           |
| `add`      | `Result<PhaseInterface, WorkflowError>` | Mints a live `PhaseInterface` (and its tasks) from `definition` and inserts it into this workflow (the entity structural API) — gated before it delegates to the `phases` manager.                                                                                                                     |
| `remove`   | `Result<PhaseInterface, WorkflowError>` | Removes the `pending` phase `id` from this workflow.                                                                                                                                                                                                                                                   |
| `move`     | `Result<PhaseInterface, WorkflowError>` | Repositions the `pending` phase `id` to `index` within this workflow.                                                                                                                                                                                                                                  |
| `update`   | `Result<PhaseInterface, WorkflowError>` | Applies a validated `PhaseUpdate` patch to the `pending` phase `id` in this workflow.                                                                                                                                                                                                                  |
| `snapshot` | `WorkflowSnapshot`                      | Serializes the whole live tree — this workflow, its phases, and their tasks.                                                                                                                                                                                                                           |

#### `PhaseInterface`

The live derived middle tier. `status` is derived from its tasks (override-or-derived).

| Method     | Returns                                | Summary                                                                                                                                                       |
| ---------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task`     | `TaskInterface \| undefined`           | Looks up one live task by its `id`.                                                                                                                           |
| `results`  | `readonly TaskResult[]`                | Lists the settled tasks' results, in positional order — the phase tier of the result tree.                                                                    |
| `skip`     | `void`                                 | Forces this phase to `skipped`, overriding the derived value; idempotent.                                                                                     |
| `stop`     | `void`                                 | Forces this phase to `stopped`, overriding the derived value; idempotent.                                                                                     |
| `pause`    | `void`                                 | Suspends the phase (resumable); idempotent.                                                                                                                   |
| `resume`   | `void`                                 | Continues a paused phase; idempotent — a no-op unless `paused`.                                                                                               |
| `wait`     | `Promise<void>`                        | Parks until this phase is not paused — a promise-parked wait, never a timer or busy-loop.                                                                     |
| `add`      | `Result<TaskInterface, WorkflowError>` | Mints a live `TaskInterface` from `definition` and inserts it into this phase (the entity structural API) — gated before it delegates to the `tasks` manager. |
| `remove`   | `Result<TaskInterface, WorkflowError>` | Removes the `pending` task `id` from this phase.                                                                                                              |
| `move`     | `Result<TaskInterface, WorkflowError>` | Repositions the `pending` task `id` to `index` within this phase.                                                                                             |
| `update`   | `Result<TaskInterface, WorkflowError>` | Applies a validated `TaskUpdate` patch to the `pending` task `id` in this phase.                                                                              |
| `patch`    | `void`                                 | Applies a validated declarative patch to this phase itself (`name` / `description` / `concurrency` / `bail`).                                                 |
| `snapshot` | `PhaseSnapshot`                        | Serializes this phase and its tasks.                                                                                                                          |

#### `TaskInterface`

The live leaf state machine — each transition is guarded (an illegal move throws a `TRANSITION` `WorkflowError`) and records a `TaskResult` on a terminal outcome.

| Method     | Returns                               | Summary                                                                                                                                                             |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`    | `void`                                | Launches the next persisted attempt of this task, from `pending` or from a retrying `running`, clearing the activity frame and emitting `start` before the cascade. |
| `complete` | `void`                                | Settles this running task as `completed`, boxing its produced value as a `Success`.                                                                                 |
| `fail`     | `void`                                | Settles this running task as `failed`, boxing a normalized failure as a `Failure`.                                                                                  |
| `skip`     | `void`                                | Moves this task to `skipped` — work intentionally not run — and emits `skip`.                                                                                       |
| `stop`     | `void`                                | Moves this task to `stopped`, fires its own signal, releases its gate, and emits `stop`.                                                                            |
| `report`   | `Result<TaskActivity, WorkflowError>` | Replaces the complete observable activity of this running task.                                                                                                     |
| `pulse`    | `boolean`                             | Confirms liveness without replacing the current operations, progress, or constraints.                                                                               |
| `pause`    | `void`                                | Suspends this task's cooperative gate while pending or running; idempotent.                                                                                         |
| `resume`   | `void`                                | Continues this task's cooperative gate; idempotent.                                                                                                                 |
| `wait`     | `Promise<void>`                       | Parks until this task is not paused.                                                                                                                                |
| `patch`    | `void`                                | Applies a validated declarative patch to this task itself (`name` / `description`).                                                                                 |
| `snapshot` | `TaskSnapshot`                        | Serializes this task's identity, status, result, owned metadata, consumed `attempts`, reliability settings, and activity.                                           |

#### `PhaseManagerInterface`

The lean phases manager — `count` is read-state (in the Surface row).

| Method   | Returns                                 | Summary                                                                                                                                                                       |
| -------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append` | `void`                                  | Adds `phase` at the end (the build-time wiring path).                                                                                                                         |
| `add`    | `Result<PhaseInterface, WorkflowError>` | Inserts `phase` at `index` (default the end) — the gated mutation counterpart to `append`: a duplicate `id` or an out-of-bounds `index` fails gracefully instead of throwing. |
| `remove` | `Result<PhaseInterface, WorkflowError>` | Removes the `pending` phase `id`.                                                                                                                                             |
| `move`   | `Result<PhaseInterface, WorkflowError>` | Repositions the `pending` phase `id` to `index`.                                                                                                                              |
| `update` | `Result<PhaseInterface, WorkflowError>` | Applies a validated `PhaseUpdate` patch to the `pending` phase `id`.                                                                                                          |
| `phase`  | `PhaseInterface \| undefined`           | Looks up one held phase by its `id`.                                                                                                                                          |
| `phases` | `readonly PhaseInterface[]`             | Lists the held phases in positional order.                                                                                                                                    |

#### `TaskManagerInterface`

The lean tasks manager — `count` is read-state (in the Surface row). Order survives an interior `skip` (a skip is a status change, never a removal).

| Method   | Returns                                | Summary                                                                                                                                                                      |
| -------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append` | `void`                                 | Adds `task` at the end (the build-time wiring path).                                                                                                                         |
| `add`    | `Result<TaskInterface, WorkflowError>` | Inserts `task` at `index` (default the end) — the gated mutation counterpart to `append`: a duplicate `id` or an out-of-bounds `index` fails gracefully instead of throwing. |
| `remove` | `Result<TaskInterface, WorkflowError>` | Removes the `pending` task `id`.                                                                                                                                             |
| `move`   | `Result<TaskInterface, WorkflowError>` | Repositions the `pending` task `id` to `index`.                                                                                                                              |
| `update` | `Result<TaskInterface, WorkflowError>` | Applies a validated `TaskUpdate` patch to the `pending` task `id`.                                                                                                           |
| `task`   | `TaskInterface \| undefined`           | Looks up one held task by its `id`.                                                                                                                                          |
| `tasks`  | `readonly TaskInterface[]`             | Lists the held tasks in positional order.                                                                                                                                    |

#### `CollectionInterface`

The insertion-ordered gated store both lean managers hold — `count` is read-state (in the Surface row). Each refusal names the entity noun the store was built with.

| Method    | Returns                         | Summary                                                                           |
| --------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `append`  | `void`                          | Adds `entry` at the end — the build-time wiring path.                             |
| `add`     | `Result<TEntry, WorkflowError>` | Inserts `entry` at `index` (default the end) — the gated counterpart to `append`. |
| `remove`  | `Result<TEntry, WorkflowError>` | Removes the `pending` entity `id`.                                                |
| `move`    | `Result<TEntry, WorkflowError>` | Repositions the `pending` entity `id` to `index`.                                 |
| `update`  | `Result<TEntry, WorkflowError>` | Applies a validated patch to the `pending` entity `id`.                           |
| `entry`   | `TEntry \| undefined`           | Looks up one stored entity by its `id`.                                           |
| `entries` | `readonly TEntry[]`             | Lists every stored entity in positional order.                                    |

#### `WorkflowRunnerInterface`

| Method    | Returns                   | Summary                                                                                                                                                                                                                                        |
| --------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute` | `Promise<WorkflowResult>` | Executes a workflow to completion — building the live tree from a definition, or driving an already-built caller-owned tree — running the phases sequentially with each phase's tasks concurrent, and resolving its terminal `WorkflowResult`. |

#### `WorkflowPersistenceInterface`

`fault` is read-state: the first required checkpoint failure, if one occurred. `WorkflowPersistence` implements this interface exactly and is advanced runner-owned infrastructure normally reached through `execute({ store })`.

| Method       | Returns            | Summary                                                       |
| ------------ | ------------------ | ------------------------------------------------------------- |
| `checkpoint` | `Promise<boolean>` | Makes the most recent state durable at one required boundary. |
| `finalize`   | `Promise<boolean>` | Detaches observers and makes the final live state durable.    |
| `detach`     | `void`             | Stops observing the live workflow tree; idempotent.           |

```ts
import { WorkflowPersistence, createMemoryWorkflowStore, createWorkflow } from '@orkestrel/workflow'

const workflow = createWorkflow({ id: 'durable', name: 'Durable', phases: [] })
const persistence = new WorkflowPersistence(workflow, createMemoryWorkflowStore())
await persistence.checkpoint('initial')
const durable = await persistence.finalize()
persistence.detach() // idempotent after finalize
```

#### `WorkflowManagerInterface`

The store-backed registry following the store standard — `count` is read-state (in the Surface row). `add` mints from a `WorkflowDefinition` (flowing the manager's `functions` in); `open` / `save` are the optional `store` seam. Hydration also flows `functions` when present; without them, named work remains inspectable but non-drivable.

| Method      | Returns                                   | Summary                                                                                                                                                                                                                              |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workflow`  | `WorkflowInterface \| undefined`          | Looks up one registered workflow by its `id`.                                                                                                                                                                                        |
| `workflows` | `readonly WorkflowInterface[]`            | Lists the registered workflows in insertion order.                                                                                                                                                                                   |
| `add`       | `WorkflowInterface`                       | Mints a live `WorkflowInterface` from `definition` (through `createWorkflow`, flowing this manager's `functions` registry in) and registers it under `definition.id`, overwriting an already-registered id.                          |
| `open`      | `Promise<WorkflowInterface \| undefined>` | Resolves a workflow by id — from the registry when it holds one, otherwise hydrated from the optional `WorkflowStoreInterface` (`store`) and runnable, because this manager's `functions` registry is threaded into the rehydration. |
| `save`      | `Promise<boolean>`                        | Persists a registered workflow's `WorkflowInterface.snapshot` to the optional `WorkflowStoreInterface` (`store`).                                                                                                                    |
| `remove`    | `boolean`                                 | Drops a batch of registered workflows, one per id.                                                                                                                                                                                   |
| `clear`     | `void`                                    | Empties the registry, dropping every registered workflow.                                                                                                                                                                            |

#### `TaskControllerInterface`

The attempt-scoped handle a `WorkflowFunction` receives. `signal` / `aborted` / JSON `input` / `task` / persisted one-based `attempt` / `paused` are read-state. Its activity closures refuse after its folded signal aborts or a newer retry owns the task.

| Method    | Returns                               | Summary                                                                                        |
| --------- | ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `report`  | `Result<TaskActivity, WorkflowError>` | Replaces this running task's complete observable activity.                                     |
| `pulse`   | `boolean`                             | Confirms liveness without replacing current activity.                                          |
| `wait`    | `Promise<void>`                       | Parks cooperatively while any workflow, phase, or task gate is paused, or until cancelled.     |
| `results` | `readonly TaskResult[]`               | Lists every settled task's result across already-finished phases — the result tree, read-only. |

#### `SchedulerInterface`

`yield` hands the host a turn (a macrotask, so the host actually runs) and resumes; `delay` resumes after a minimum interval. Both reject with `signal.reason` when an optional `options.signal` aborts.

| Method  | Returns         | Summary                                                                                        |
| ------- | --------------- | ---------------------------------------------------------------------------------------------- |
| `yield` | `Promise<void>` | Yields control back to the host so other tasks (I/O, timers, rendering) can run, then resumes. |
| `delay` | `Promise<void>` | Resumes after at least `ms` milliseconds.                                                      |

#### `RunnerInterface`

`execute` runs the declared units (and their spawns) once and resolves ordered results; `spawn` injects a unit into an in-flight run; `pause` / `resume` / `stop` are the lifecycle verbs (`stop` is a graceful stop — in-flight finishes, never-dispatched pending entries settle without a fail-fast trip); `abort` / `destroy` remain the hard-cancel verbs. The `active` / `stopped` / `paused` members are Surface rows.

| Method    | Returns                         | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute` | `Promise<readonly TResult[]>`   | Runs all `inputs` — and anything they `spawn` — to completion; resolves their results in order: the declared inputs first (in input order), then the spawned units (in spawn order).                                                                                                                                                                                                                                                                                      |
| `spawn`   | `Promise<TResult> \| undefined` | Injects one more unit into a run already in flight — the live counterpart to a `Controller.spawn`, called from outside any unit's handler (the seam through which a subscribed run offers a newly added task of a `running` `PhaseInterface` to the same execution substrate).                                                                                                                                                                                            |
| `abort`   | `Promise<void>`                 | Cancels every in-flight + pending unit (and the backing queue), making a running `execute` reject.                                                                                                                                                                                                                                                                                                                                                                        |
| `pause`   | `void`                          | Suspends dispatch (resumable): the backing queue holds the next dispatch while any in-flight unit finishes; idempotent.                                                                                                                                                                                                                                                                                                                                                   |
| `resume`  | `void`                          | Continues a paused runner; idempotent.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `stop`    | `Promise<void>`                 | Ends the runner permanently — a graceful stop: no further unit is dispatched, but every already-in-flight unit runs to completion and settles normally. A never-dispatched (still-pending) unit is rejected by the backing queue and is not recorded as a failure, so it never trips fail-fast, while a genuine in-flight failure still does. `execute`'s promise resolves rather than rejects after every unit has settled, with whatever results completed. Idempotent. |
| `destroy` | `Promise<void>`                 | Tears the runner down, awaiting backing-queue cleanup before destroying the emitter last.                                                                                                                                                                                                                                                                                                                                                                                 |

#### `RunHolderInterface`

`hold` takes the phase runner a starting phase hands the run, or releases the held one when called with no argument. The `runner` member is a Surface row.

| Method | Returns | Summary                                                                        |
| ------ | ------- | ------------------------------------------------------------------------------ |
| `hold` | `void`  | Takes a phase runner for the phase that is starting, or releases the held one. |

#### `ControllerInterface`

`wait` parks until the unit's signal aborts; `spawn` fans out a sibling unit; `abort` cancels this unit. The `id` / `input` / `signal` / `aborted` members are Surface rows.

| Method  | Returns            | Summary                                                                         |
| ------- | ------------------ | ------------------------------------------------------------------------------- |
| `wait`  | `Promise<void>`    | Parks until this unit's `signal` aborts — a promise-parked wait, never a timer. |
| `spawn` | `Promise<TResult>` | Adds a sibling unit to the run; returns its result promise.                     |
| `abort` | `void`             | Cancels this unit — fires its `signal` with the optional reason.                |

#### `WorkflowStoreInterface`

The durable persistence seam (W-d) — the async `get` / `set` / `delete` primitives over a `WorkflowSnapshot`, keyed by its own id. Both stores implement exactly these — the in-memory `MemoryWorkflowStore` and the driver-pluggable `DatabaseWorkflowStore` (the snapshot one opaque JSON column) — so a durable backend (JSON / SQLite / IndexedDB) swaps in through the same primitives. There is no TTL / eviction — a persisted run-state lives until an explicit `delete`.

| Method   | Returns                                  | Summary                                                                                                                                                                                                                         |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get`    | `Promise<WorkflowSnapshot \| undefined>` | Resolves the persisted snapshot for `id`, or `undefined` if none is stored. A present payload whose own `id` differs from the requested storage key is corrupt and rejects with a normalized `RESTORE` error carrying both ids. |
| `set`    | `Promise<void>`                          | Inserts or replaces a snapshot under its own `snapshot.id` (no separate id param — mirroring `QueueStoreInterface.save` from `@orkestrel/queue`).                                                                               |
| `delete` | `Promise<void>`                          | Drops a snapshot by id; an absent id is a no-op (no throw).                                                                                                                                                                     |

## Contract

These invariants hold across `src/core` ↔ `workflow.md`:

1. **Doc ↔ source bijection.** Every `function` / `const` / `class` / `interface` / `type` row in the `## Surface` tables is a real export of `src/core`, and every export appears as a Surface row — exhaustive, both directions.

2. **Doc ↔ source method bijection.** Every behavioral interface's `## Methods` table lists exactly its public methods (call-signature members) — exhaustive, both directions — and each implementing class (`Workflow` / `Phase` / `Task` / `WorkflowRunner` / `TaskController` / `PhaseManager` / `TaskManager` / `Runner` / `Controller`) exposes exactly its interface's methods, no extra public surface. The `readonly` data members (`emitter` / `status` / `result` / `context` / `signal` / `aborted` / `input` / `task` / `attempt` / `attempts` / `count` / `id` / `name` / `description` / `bail` / `phases` / `tasks` / `paused` / `destroyed` / `behavior` / `handler` / `retries` / `timeout` / `concurrency` / `activity` / `silence` / `silent` / `active` / `stopped`) stay in the Surface rows.

3. **Definition is data; the runtime is the tree.** A `WorkflowDefinition → PhaseDefinition → TaskDefinition` is pure JSON — behavior referenced by name through a registry, never inline functions — so it round-trips through `createWorkflowContract` (the LLM-tool-args / boundary-validation / restore / test-fixture spine) and persists unchanged. The `Workflow` / `Phase` / `Task` entity classes are the live mirror built from a definition; the definition interfaces are hand-written (the source of truth), and the compiled contract's `is` / `parse` / `generate` narrow to them natively (no `as`) — a `generate → is → parse` round-trip parity test guards against drift between the definition and the contract.

4. **Determinism is fixed by design.** Tasks within a phase run concurrently; phases run sequentially. There is no per-task concurrent/sequential toggle and no dependency machinery — a dependency is structural (a later phase), so the same tree always sequences the same way. The per-phase knobs are `concurrency` (an optional resource throttle — max-in-flight; omitted ⇒ `DEFAULT_PHASE_CONCURRENCY`, effectively unbounded) and `bail` (an optional per-phase failure-policy override; omitted ⇒ inherits the workflow `bail`), never a sequencing control; the per-task knobs are `retries` (extra attempts routed through the substrate) and `timeout` (a workflow-owned per-attempt deadline in `0..MAX_TIMER_MS`). The status derivations (`derivePhaseStatus` / `deriveWorkflowStatus`) are therefore order-insensitive set reductions, total (never throw), mirroring the contract guards' totality.

5. **Status is derived from children, per-phase-bail-aware.** A phase's `LifecycleStatus` is derived from its tasks' statuses (`bail`-agnostic — a phase surfaces a task failure as `failed` so the policy can decide); a workflow's `LifecycleStatus` is derived from its phases' `PhaseDerivation`s (each phase's status paired with the effective `bail` it ran under, `effectiveBail = phase.bail ?? workflow.bail`). A `failed` phase propagates `failed` to the workflow only when its effective `bail` is `true` — so a `bail: true` phase halts the run even under a graceful (`false`) workflow default, and a `bail: false` phase folds into completion (recorded as data in the result tree) even under a strict (`true`) workflow default. `deriveWorkflowStatus(PhaseDerivation[])` therefore takes the per-phase policy on each phase, not one scalar. Task, phase, and workflow all carry one `LifecycleStatus` vocabulary, so the single `isTerminalStatus` predicate covers every tier.

6. **The leaf is a guarded state machine; the override round-trips.** A `Task`'s transitions read the `TASK_TRANSITIONS` graph through `canTransitionTask` — an illegal move (completing a non-`running` task, starting a settled one) throws a `TRANSITION` `WorkflowError`, so the leaf can never reach an impossible state. A `skip` / `stop` on a derived `Phase` / `Workflow` sets an `#override` that is persisted in the snapshot's own `override` field and restored directly (no fragile status-divergence guess). The root's `completed` override is narrower: only a pending tree with zero tasks anywhere is vacuously complete; hostile completed overrides over pending work or a non-pending derivation are rejected. A leaf's terminal status is its forced marker, so a `TaskSnapshot` needs no `override`.

7. **The result tree is lineage-navigable, at the task, phase, and workflow tiers.** A `TaskResult` carries its full lineage (`task` / `phase` / `workflow` contexts) and boxes the produced outcome in a [`Result`](contract.md): present exactly for `completed` (a `Success`) / `failed` (a `Failure`), absent for `skipped` / `stopped` (terminal without an outcome) and for a non-terminal task. `Phase.results()` is the phase tier; `Workflow.results()` flattens every phase's through `collectResults` (the workflow tier). A `TaskController.results()` reads up the live tree — every settled task across already-finished phases — so a later phase's `function` task reads an earlier phase's output (the result tree is the inter-task data-flow map, read-only).

8. **`pause` / `resume` / `wait` are runtime-only at the workflow, phase, and task tiers.** `paused` is never a `LifecycleStatus` and never persisted in a snapshot — a paused node's `status` still reports its ordinary value. `pause()` is idempotent and ignored for terminal nodes; it emits only after `paused` becomes true. `resume()` emits only when it actually opens a paused gate. Terminal cleanup, `stop`, and `destroy` release gates without inventing a `resume` event. An entity `wait()` never rejects: it resolves immediately when not paused and otherwise parks on that entity's gate; `Task.wait()` alone never observes ancestors. When the runner or `TaskController` composes those gates, every park is raced against cancellation and relevant ancestor Workflow/Phase `skip` / `stop` events. An ancestor terminal override therefore wakes descendant parks without a fabricated `resume`; queued or not-yet-dispatched work then skips, while a handler dispatched before a graceful stop may finish naturally.

9. **`stop` (graceful) against `destroy` (hard) — different cancels at different tiers.** A `Workflow.stop()` / `Phase.stop()` forces a terminal status (an override) — the forced-terminal verb. `Workflow.destroy()` is the stronger, terminal teardown: it marks `destroyed` before any event, pins non-terminal workflow/phase overrides to `stopped`, stops every non-terminal task, releases gates and liveness timers, aborts `signal`, then destroys task emitters, phase emitters, and the workflow emitter in that ownership order. Already-terminal genuine completed/failed nodes retain their state. The operation is reentrant-safe and idempotent; structural mutation from a final stop listener is refused, recursive `destroy()` is a no-op, and state/snapshots remain inspectable after emitter resources are gone. The substrate `Runner.stop()` is a different, graceful verb at the execution-substrate tier: no further unit is dispatched, but every already-in-flight unit finishes normally, and a never-dispatched (still-pending) unit is rejected without being recorded as a failure (it never trips fail-fast) — `execute()` resolves (never rejects) with whatever settled. Declared units are launched and ordered before the run emits `start`, while native Queue dispatch remains asynchronous, so a public `spawn()` from a start listener is accepted after every declared result but still before any handler runs. A resolved entry's reliability properties are read before its id is classified as queued; that classification happens before `queue.enqueue`, so an `entries` resolver that synchronously requests graceful stop and returns produces never-dispatched stop work, while resolver/property throws remain genuine failures. `Runner.stop()` / `abort()` / `destroy()` return stable cleanup barriers; a graceful stop may still be escalated when a dispatched unit fails or the caller aborts/destroys, and `destroy()` awaits the backing Queue before destroying Runner observation last. A driving `WorkflowRunnerInterface.execute(workflow)` folds `workflow.signal` into its run signal, so `destroy()` aborts in-flight work immediately, while `workflow.stop()` alone lets not-yet-started work skip gracefully and in-flight work finish.

10. **Observation is a pure side-channel.** Each live `Workflow` / `Phase` / `Task` owns a typed `emitter` (`WorkflowEventMap` / `PhaseEventMap` / `TaskEventMap`) firing strictly after each transition — a leaf's own event before the cascade re-derives the parents (cause before effect), so an observer sees the leaf changed before the phase / workflow does. The emitter isolates a listener throw and routes it to its own `error` handler (the `error` option, surfaced as `(error, event)`, not a domain event) — so a buggy observer can never corrupt a transition or the cascade. The `WorkflowRunner` and `TaskController` are event-free by design (the runner drives the entities' own emitters; the child managers `PhaseManager` / `TaskManager` are purely structural and observe nothing).

11. **Running-phase append-only; every structural edit is gated by the pending-suffix boundary.** `Phase.add` (and its manager delegate) accepts any `index` while the phase is `pending`, but only a pure append (`index` omitted or `=== tasks.count`) while `running` — a live runner subscribed to the phase's own `add` event picks the new task up for same-run execution, and the derived-status model keeps the phase from reaching a terminal status while that newly-accepted `pending` task is still outstanding; a terminal phase always refuses. `remove` / `move` / `update` on a phase's tasks are allowed only while the phase itself is `pending`. At the workflow tier, `Workflow.add` / `remove` / `move` / `update` on its phases are refused outright while the workflow is terminal or `destroyed`; otherwise every target index (and, for `add`, the effective insertion index `index ?? phases.count`) must fall within the pending suffix — the contiguous trailing run of `pending` phases (phases run sequentially, so every already-started phase forms a contiguous leading prefix) — whose boundary is `deriveBoundary`. Every refusal (at either tier) is a graceful `Result` `MUTATION` failure, never a throw, and fires no `add` / `remove` / `move` / `update` event.

12. **The runner composes a pure engine.** `WorkflowRunner.execute` builds the live tree from the definition and drives phases sequentially, with each phase's tasks concurrently through one substrate `Runner`. The substrate owns concurrency and declared retries; the workflow layer owns each task's deadline because it must distinguish timeout failure from genuine cancellation and settle the live leaf under the phase's `bail` policy. Non-final timeout rejects to trigger a retry; final timeout fails the task and rejects only for fail-fast. Run-level abort / [timeout](timeout.md) / [budget](budget.md) fold through `AbortSignal.any`; pacing is the shipped scheduler. The engine carries no behavior/provider registry and invokes each task's already-resolved handler directly.

13. **A task's behavior is a plain string, resolved once into a `handler`; present names must resolve before execution.** A live `TaskInterface`'s `behavior` is resolved at construction against `WorkflowOptions.functions`. Exact restore without functions remains usable for inspection: it preserves the present `behavior` and leaves `handler` undefined. Definition execution, recovery, and entity execution reject a present name without a handler before external dispatch, so named work never false-completes. A task that deliberately omits `behavior` is the only no-op form and completes with JSON `null`. External integrations enter through ordinary application-supplied functions.

    Construction options are hostile-boundary inputs: every root `WorkflowOptions` property is captured by direct access exactly once before fresh construction, restore, recovery validation, or definition execution; inherited and non-enumerable values remain valid. `Workflow`, `Phase`, and `Task` likewise snapshot their nested phase/task bags and keyed child values once, so accessor-backed caller options cannot shift policy, hooks, metadata, silence, or handler resolution between levels. The exact `functions` registry accepted by recovery validation supplies every recovered handler and remains the registry used by later live additions. The live-workflow `execute` overload reads only run-control bounds and never touches construction getters.

14. **`WorkflowError` names only Workflow failures.** `TRANSITION` guards lifecycle moves, `RESTORE` rejects invalid durable state, and `MUTATION` reports refused structural, metadata, or activity changes. Integration-specific failures remain outside this package and must not expand Workflow's error vocabulary speculatively.

15. **`WorkflowRunnerInterface.execute(workflow)` claims one coherent drivable object synchronously and once.** The entity overload accepts a fresh pending tree or a quiescent recovered tree with terminal and pending work. It rejects destroyed, terminal, running, handler-incomplete, inconsistent, empty-of-pending-work, or previously claimed objects. The internal `WeakSet` is process-local object-identity protection only: two separately restored objects with the same workflow id are distinct claims. A distributed adapter must provide an external workflow-id + epoch lease and idempotent side effects; core does not pretend its local claim is a cross-process lease. Exact restore preserves a running leaf and is therefore intentionally not drivable; call `createRecoveredWorkflow` first.

16. **A run-level `timeout` / `budget` keeps counting while paused.** `pause` suspends dispatch, not the clock — an external `WorkflowRunOptions.timeout` deadline or `budget` ceiling continues to elapse / accumulate while a run sits paused, so a long pause can still fire the bound and unpark the run into a cancelled (`stopped`) outcome; pausing is not a way to freeze a run's external bounds.

17. **Cross-environment `setTimeout` default (scheduler).** `Scheduler` uses only `setTimeout` / `clearTimeout` — universally available in browser and Node — so the default runs unchanged in either. It deliberately avoids env-specific fast paths (`setImmediate`, `scheduler.yield`, `requestAnimationFrame`, `node:timers/promises`, `MessageChannel`); those belong to the environment backends.

18. **`yield` is a macrotask host-turn, not a microtask.** `yield()` waits on a zero-delay `setTimeout`, not `queueMicrotask`. A microtask drains before the host regains control, so it would only defer within the current task — it would not let pending I/O, timers, or rendering run. A macrotask is the correct cross-environment "give the host a turn", so a microtask queued after a `yield()` call resolves before the yield does.

19. **Abort-aware, with full cleanup.** A pending `yield` / `delay` rejects with `signal.reason` (the standard `AbortSignal` convention) when its `options.signal` aborts. An already-aborted signal rejects immediately without arming a timer. Either settle path — the timer firing or the signal aborting — clears the timer and removes the abort listener: no leaked timer, no leaked listener, and no double-settle.

20. **Priority accepted but uniform.** `options.priority` is part of the contract, but a `setTimeout`-based default cannot act on urgency, so it treats every priority the same. It is accepted without error and does not change behavior; environment backends honour it.

    The shared test `createRecordingScheduler` wraps one shipped `createScheduler` instance:
    it counts a `yield` before delegating and delegates `delay` unchanged, preserving real
    asynchronous turns, timing, abort reasons, and cleanup rather than substituting behavior.

21. **Event-free by contract.** The scheduler is a functional pacing primitive with no Emitter, `EventMap`, or `on` hook; observation belongs to the entities and runners that compose it.

22. **Environment backends honour priority and the native primitive; abort semantics are identical.** Each backend (`NodeScheduler` over `setImmediate`; `BrowserScheduler` over `scheduler.postTask`, `FrameScheduler` over `requestAnimationFrame`, `IdleScheduler` over `requestIdleCallback`) is a standalone `SchedulerInterface` that changes only the `yield` primitive — `delay(ms)` stays a real `setTimeout` — and preserves the contract's abort discipline byte-for-byte: reject with `signal.reason` verbatim, no arming when pre-aborted, full handle + listener cleanup on either settle path, settle-once. Native APIs are feature-detected through guards (`isRecord` / `isFunction`), never an `as`, with a real-macrotask fallback where absent. `NodeScheduler` does **not** delegate to `node:timers/promises` (it would replace `signal.reason` with a Node `AbortError`); the timer is hand-rolled. `BrowserScheduler` honours `priority` through `postTask`'s priority levels; the others accept `priority` as a documented no-op.

23. **Doc ↔ source method bijection (scheduler).** The `## Methods` table lists exactly `SchedulerInterface`'s public methods — exhaustive, both directions — and `Scheduler` plus every backend (`NodeScheduler` / `BrowserScheduler` / `FrameScheduler` / `IdleScheduler`) exposes the same public methods, no more.

24. **Snapshot is an owned, hostile-boundary durable payload.** `Workflow.snapshot()` returns a deeply cloned, frozen, exact-JSON graph containing policy, statuses, lineage-safe normalized results, task metadata/activity, and consumed `attempts`. Accessors, cycles, class instances, symbols, holes, non-finite numbers, unknown keys, impossible topology, invalid results, and derived-status drift are rejected before live construction. Task order carries no lifecycle topology because tasks are concurrent; phase order uses a sequential frontier that ignores forced skipped/stopped gaps and permits at most one running phase. `createRestoredWorkflow` is an exact inspectable state round-trip even without functions; it does not make interrupted work runnable. `createRecoveredWorkflow` is an explicit two-pass transform per phase: every exhausted running task is classified first. Graceful recovery fails those exhausted tasks, returns retryable running tasks to pending, and continues eligible work. In a strict (`bail: true`) phase, an existing persisted failed task is retained as an established halt boundary; eligible siblings and later work are skipped. Exhausted running tasks still normalize to recovery failures, and every other eligible sibling on both sides is skipped. Attempts never replenish. Recovery and live recompute use the greater of the host clock and the persisted `updated`, so restored future stamps never regress. Terminal workflow/phase overrides are not recoverable.

25. **The durable store owns values on both sides, and the runner can compose it.** Both store implementations deep-clone and validate on `set` and `get`, so callers cannot mutate stored state by alias. `DatabaseWorkflowStore.get` returns `undefined` only for an absent row; present malformed data rejects with the normalized `RESTORE` error. Supplying `WorkflowRunOptions.store` adds required initial, pre-handler attempt, terminal settlement, and final checkpoints. Activity, structural, and skip events trigger best-effort coalesced writes; `WorkflowPersistence` reserves its writer promise before the drain can call external `store.set`, so a synchronous store-triggered entity mutation joins the current obligation instead of starting a second write. There is at most one write in flight, and a newer revision is persisted by the same drain or its most recent follow-up. A required failure stops advancement and is returned as `WorkflowResult.fault`; `durable` reports whether the final live state reached the store. Persistence rejection never masks or rewrites the task's normalized handler/timeout/recovery outcome.

What ships is **W-a → W-d**: the definition contract + type surface + derivation helpers (W-a), the live entity tree + result tree + snapshot/restore/recovery (W-b), the pure `WorkflowRunner` engine + `behavior`-string / `handler` model (W-c), and the durable `WorkflowStore` (W-d — `WorkflowStoreInterface` plus the in-memory and driver-pluggable implementations). The shipped `WorkflowManager` is the higher-level live registry over that store seam. Provider, Tool, MCP, Terminal, persistent-driver selection, and resource-pool policy are deliberately outside Workflow core.

## Patterns

These patterns follow the layered arc — author, validate, and run a definition; then control a live run; then the execution substrate the engine composes; then the consolidated practices.

### Authoring a definition (pure JSON)

The following definition keeps authored workflow state as pure JSON.

```ts
import type { WorkflowDefinition } from '@orkestrel/workflow'

// Behavior is referenced by name — never an inline function. A UI builds this, an LLM emits
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
				{ id: 'a', name: 'Fetch A', behavior: 'fetch' },
				{ id: 'b', name: 'Fetch B', behavior: 'fetch' },
			],
		},
		// `summarize` is placed in a later phase, so the fetch results are ready when it runs —
		// the phase boundary is the only dependency edge the model has.
		{
			id: 'reduce',
			name: 'Reduce',
			tasks: [{ id: 's', name: 'Summarize', behavior: 'summarizer' }],
		},
	],
}
```

### Validating + seeding with the contract

The following contract calls validate, parse, generate, and describe definitions.

```ts
import { createWorkflowContract } from '@orkestrel/workflow'

const contract = createWorkflowContract()
contract.is(definition) // true — a total guard (malformed input ⇒ false, never throws)
contract.parse({ id: '', phases: [] }) // undefined — an empty id fails the refinement
contract.generate() // a deterministic valid WorkflowDefinition (seed a RandomFunction for reproducibility)
contract.schema // the emitted JSON Schema for the full definition
```

### Running a workflow

The following runner resolves named behaviors and executes the definition.

```ts
import { createWorkflowRunner } from '@orkestrel/workflow'

const runner = createWorkflowRunner() // a pure engine — no registries of its own

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

`execute` is single-source — it builds the live tree from `definition` itself and returns it in `result.workflow`. Each task's `behavior` string is resolved once at construction against `options.functions`; an omitted `behavior` completes as a JSON `null` no-op, while a present but absent registry name is rejected before execution.

### The `bail` policy — graceful vs halt

The following runs contrast graceful settlement with fail-fast handling.

```ts
// bail: false (default) — failures are data. Every phase runs to the end; the workflow completes.
const graceful = await runner.execute(definition) // a failed leaf is recorded; status === 'completed'

// bail: true — the database-transaction halt. The first failure aborts in-flight siblings
// (their controller.signal fires) and skips the remaining tasks / phases; status === 'failed'.
const transactional = await runner.execute(definition, { bail: true })
```

A `bail` override on `execute` wins over the definition's `bail` (which wins over `DEFAULT_BAIL`). Under `bail: true`, a mid-flight sibling sees its `controller.signal` fire and must stop promptly.

A phase may override the workflow policy per phase (`effectiveBail = phase.bail ?? workflow.bail`) — a strict phase halts even under a graceful workflow, and a graceful phase settles-all even under a strict one:

```ts
const definition: WorkflowDefinition = {
	id: 'pipeline',
	name: 'Pipeline',
	bail: false, // graceful by default…
	phases: [
		// …but this phase is transactional: a failure here halts the run (skips the rest).
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

A task may declare per-task reliability — extra attempts on failure and a workflow-owned per-attempt deadline. Both persist in `TaskSnapshot`; `timeout` must be an integer in `0..MAX_TIMER_MS`, where `0` disables the deadline:

```ts
const task: TaskDefinition = {
	id: 't',
	name: 'T',
	behavior: 'fetch',
	retries: 3,
	timeout: 5000,
}
```

A per-attempt `timeout` is a retryable failure of that attempt, not a skip. The workflow layer owns the deadline so it can settle the live leaf before the substrate unit resolves: a non-final timeout rejects the unit to drive its declared retry while leaving the leaf `running`; the final timeout `fail`s the leaf, then rejects only under `bail: true`. Under `bail: false`, slow siblings finish and later phases continue after the failed leaf is recorded. A run-level cancel (abort / run-`timeout` / budget) and a sibling fail-fast under `bail` still `skip` the in-flight leaf.

### Bounding a run (abort / timeout / budget)

The following run composes cancellation, timeout, and budget bounds.

```ts
import { createAbort } from '@orkestrel/abort'
import { createBudget } from '@orkestrel/budget'

const abort = createAbort()
const result = await runner.execute(definition, {
	signal: abort.signal, // an external cancellation
	timeout: 10_000, // non-positive, non-finite, or over MAX_TIMER_MS means no deadline
	budget: createBudget({ max: 50_000, consume: (usage) => usage.total }), // a cost ceiling
})
// A fire of any bound folds through AbortSignal.any: it cancels every in-flight task, skips the rest,
// and force-stops the workflow → status === 'stopped'. `execute` resolves (never rejects) on a cancel.
```

The definition stays plain data at every boundary. Validate untrusted authored input with `createWorkflowContract`, then compose only the application-owned functions the run is allowed to invoke.

**Control the live run.** The engine returns the live tree, but you can also drive, force, pause, mutate, observe, and serialize it directly:

### Driving the live entity tree directly

The following calls drive a task through its guarded live transitions.

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

The cascade is reactive: a leaf transition recomputes its phase, which escalates to the workflow, each re-deriving its status (and emitting on a change). `skip` / `stop` on a phase or workflow force its status (an override).

### Forcing a terminal status — `skip` / `stop`

The following calls apply terminal overrides at each entity level.

```ts
import { createWorkflow } from '@orkestrel/workflow'

const workflow = createWorkflow(definition)
const phase = workflow.phase('optional-step')
const task = phase?.task('probe')

task?.skip() // leaf → 'skipped'; emits `skip` — never run, distinct from a stop
task?.stop() // leaf → 'stopped'; emits `stop` — ended early (guarded: only from a live status)

phase?.skip() // force the whole phase 'skipped' — an override, survives a snapshot
phase?.stop() // force the whole phase 'stopped'; emits `stop`

workflow.skip() // force the whole workflow 'skipped' — overrides the derived status
workflow.stop() // force the whole workflow 'stopped'; emits `stop`
```

A `skip` / `stop` at the phase / workflow tier is an override — it forces the node's status regardless of its children's derived value, and the override is persisted in `snapshot()`'s `override` field so `createRestoredWorkflow` restores it directly. A leaf's `skip` / `stop` is a real guarded transition (no override needed — its terminal status is the marker).

### Pausing, resuming, and parking on a run — `pause` / `resume` / `wait` / `destroy`

`pause` / `resume` / `wait` are runtime-only at the workflow, phase, and task tiers — never a `LifecycleStatus`, never persisted. `destroy` is Workflow-only terminal teardown (a `Phase` and `Task` have no `destroy`; only the workflow owns the cascade):

```ts
import { createWorkflow } from '@orkestrel/workflow'

const workflow = createWorkflow(definition)

workflow.pause() // suspend the run at the next phase boundary / task pre-dispatch
workflow.paused // true

const waiter = workflow.wait() // promise-parked; never rejects
workflow.resume() // releases the parked waiter
await waiter // resolves after it is unpaused

workflow.phase('build')?.pause() // pause this phase alone
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

`Workflow.add` / `remove` / `move` / `update` mutate the workflow's pending suffix of phases; `Phase.add` / `remove` / `move` / `update` mutate a phase's tasks (a `running` phase accepts only a pure `add` append); both return a `Result` rather than throwing, and both fire their event on success only:

```ts
import { createWorkflow } from '@orkestrel/workflow'
import type { PhaseDefinition, TaskDefinition } from '@orkestrel/workflow'

const workflow = createWorkflow({ id: 'wf', name: 'Wf', phases: [] })

const phaseDefinition: PhaseDefinition = { id: 'p1', name: 'P1', tasks: [] }
const added = workflow.add(phaseDefinition) // mint a live phase + insert it — Result<PhaseInterface, WorkflowError>
if (added.success) {
	const phase = added.value

	const taskDefinition: TaskDefinition = {
		id: 't1',
		name: 'T1',
		behavior: 'noop',
	}
	const addedTask = phase.add(taskDefinition) // mint a live task + insert it into this phase
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

Every one of these is refused gracefully (a `MUTATION` `Result` failure, never a throw) when the container is terminal / `destroyed`, the target does not exist or is not `pending`, or the position falls outside the pending suffix; a `running` phase accepts an `add` only as a pure append — a live runner subscribed to that phase's own `add` event picks the new task up for same-run execution.

### Building the live tree by hand — `append`

`createWorkflow` builds every phase/task from the definition through `PhaseManagerInterface.append` / `TaskManagerInterface.append` internally — the same methods are available directly on an already-built tree's managers, for example to graft a live phase (or task) built elsewhere onto it:

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
			tasks: [{ id: 't1', name: 'T1', behavior: 'noop' }],
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

`append` adds one live child at the end, preserving positional order; `PhaseManagerInterface` / `TaskManagerInterface` otherwise stay lean (an accessor + `count`, no batch matrix).

### Observing the live tree

Each live `Workflow` / `Phase` / `Task` exposes a typed `emitter` carrying its lifecycle for fire-and-forget observers — logging, metrics, progress UI. Subscribe through `entity.emitter.on(...)`, or wire initial listeners through the reserved `on` option (per-node, keyed by id under `WorkflowOptions.phases[id]` / `.tasks[id]`). Emitting is observation-only — every event fires strictly after the relevant transition, so a listener can never change what a transition does:

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
	progress: { progress: 240, total: 1_000, message: '240 of 1,000 sources' },
	operations: [{ id: 'scan', name: 'Scan sources', started: Date.now() }],
	constraints: [{ id: 'rate', name: 'Provider rate limit', started: Date.now() }],
})

if (!result.success) return
await controller.wait() // checkpoint workflow + phase + task gates, or cancellation
controller.pulse() // healthy but unchanged: restamp liveness without replacing the frame
```

Every accepted `report` replaces the complete frame. Omitted `note` / `progress` clear them and omitted collections become empty. Core rejects the whole report with a `MUTATION` failure—preserving the prior frame—for empty present text, non-finite or negative numbers, `total < progress`, or duplicate ids within operations or constraints. Accepted progress, items, arrays, and frames are copied and frozen; getters, events, and snapshots therefore expose no mutable caller-owned reference. There are no caps, truncation, clamping, history, provider fields, or raw-log retention.

Activity is attempt-owned. `start` seeds the first empty frame; retry entry replaces it with another empty frame. A `TaskController` captures the runner's explicit claimed attempt and folded signal; ownership requires both the runner token and the live task's persisted attempt to match. A public or reentrant `start` therefore invalidates an older handle immediately: late `report` returns `TRANSITION`, late `pulse` returns `false`, handler settlement is ignored, and no settlement checkpoint is attributed to the stale attempt. Pending snapshots omit activity; running/completed/failed snapshots require the accepted frame; skipped/stopped snapshots may omit it or retain the last accepted reporter claim. Start, report, and pulse stamps use the greater of the host clock and the prior activity stamp, so a restored future timestamp never regresses. Restore never arms a silence timer merely because a frame was persisted.

`WorkflowOptions.silence` is the runtime default and `TaskOptions.silence` is the runtime override; neither is authored definition data nor persisted supervision config. A present value outside `1..MAX_TIMER_MS` explicitly disables inheritance. The effective task value is host-timer-safe or `undefined`, so overflow never clamps into an immediate silence event. One reusable, task-signal-parented deadline is rearmed after each accepted report or pulse. `silent` derives from that deadline's current `expired` state while the task is running and clears on the next accepted activity; repeated silence events are possible after rearming. Terminal settlement and destroy clear supervision.

Task pause is cooperative. `Task.wait()` parks only the task gate. `TaskController.wait()` folds the workflow, phase, and task gates, racing them against cancellation and ancestor Workflow/Phase `skip` / `stop` events; an ancestor terminal override wakes it without fabricating `resume`. No method suspends arbitrary JavaScript or an operating-system process. The queue acquires concurrency before the workflow handler gate, so a paused task can occupy one phase slot: with concurrency `1` it blocks later pending siblings, already-running siblings continue, the external handler is not invoked until resume, and the per-attempt timeout continues while the slot is held.

Stopping or skipping a running task fires its task-owned signal. Each attempt races its gates and handler against the folded attempt/task/run signal with removable listeners that are detached in `finally`; no task-signal park is cached across attempts. When the task is already terminal, the queue unit settles successfully without completing/failing the task or aborting siblings. An uncooperative ignored promise may continue in memory, but it no longer owns activity. The adapter that launched an external subprocess remains responsible for terminating the process and its descendants.

Provider-specific Claude/Cursor/Codex JSONL parsing, journals, raw-log retention/redaction, session ids, subprocess ownership, process-tree termination, escalation policy, and CLI continuation stay outside workflow core in application adapters/supervisors. Provider continuation is a new persisted attempt of the same logical task, not a new logical workflow task and not `Task.resume()` (which only opens a live cooperative gate). That composition must retain the external workflow id + epoch lease and make side effects idempotent. Core's `WeakSet` protects only one in-process object identity. Interrupt a whole run with the caller's `AbortController` or `workflow.destroy()`; there is intentionally no `workflow.abort()` API.

### Snapshot & restore (the durable payload)

The following workflow round-trips its durable snapshot through restore and recovery.

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
// each task's `behavior` into a fresh handler for later recovery/execution.
const resumed = createRestoredWorkflow(snapshot, { functions })
resumed.status === workflow.status // true — bail comes from the snapshot itself

// Exact restore deliberately preserves the running leaf, so it is inspectable but not drivable.
// Recovery explicitly consumes persisted attempt history and produces a drivable pending suffix.
const recovered = createRecoveredWorkflow(snapshot, { functions })
```

The snapshot is an owned exact-JSON graph. It persists `bail`, overrides, normalized JSON results, task `behavior` / `retries` / `timeout`, and consumed `attempts`. Every pending snapshot omits activity. Recovery of retryable running work also removes its prior activity before returning it to pending, while preserving consumed attempts; the next real `start` creates a fresh attempt frame. Exact restore preserves unresolved names for inspection; execution still requires every present `behavior` to resolve. During construction, each phase reads every unique initial `behavior` binding once and gives duplicate-name tasks that exact captured handler; recovery validates the constructed live handlers without rereading the registry. The retained registry identity still serves later live additions, whose binding is read at their own mint time. Recovery refuses terminal workflow/phase overrides and never replenishes attempts. Within each phase it classifies all exhausted running tasks first: strict policy retains an existing failed task as an established halt boundary, normalizes exhausted running tasks to recovery failures, and skips every other eligible sibling on both sides plus later eligible phases; graceful policy fails exhausted tasks, resets retryable running tasks to pending, and continues.

### Persisting & restoring (the durable store)

The `WorkflowStoreInterface` seam (`get` / `set` / `delete`, async, keyed by a snapshot's own id) has a dual-store convention — pick the backend, the seam is identical. `createMemoryWorkflowStore` is the zero-plumbing default (a plain `Map`); `createDatabaseWorkflowStore` is the driver-pluggable twin over a `databases` table (the snapshot one opaque JSON column, driver defaulting to memory). Both persist the `WorkflowSnapshot` from the section above unchanged; reading one back and rebuilding the live tree is the shipped `createRestoredWorkflow`. A durable backend (JSON / SQLite / IndexedDB) swaps in by passing the driver to `createDatabaseWorkflowStore` — without touching the engine or the entity tree (the `SessionStore` / `QueueStore` driver-swap pattern).

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

Both stores clone and validate on write and read, so stored snapshots never alias caller-owned data. A present database row whose snapshot id differs from the requested row key rejects with normalized `WorkflowError` code `RESTORE`; its safe context carries `requested` and `payload`. The store has no TTL / eviction — a persisted workflow run-state is durable until an explicit `delete`.

A `WorkflowSnapshot` written before the release that renames `run` to `behavior` carries the task registry key as `run`. `cloneWorkflowSnapshot` and every restore path — `store.get`, `createRestoredWorkflow`, `WorkflowManager.open` — refuse that snapshot with a `RESTORE` `WorkflowError`, because the exact-key validation no longer admits `run`. Rewrite the persisted key from `run` to `behavior` before restoring a snapshot written before that release.

For automatic run durability, pass the same store to `execute`:

```ts
const result = await runner.execute(definition, { functions, store })
result.durable // whether the final state reached the store
result.fault // first required checkpoint failure, if any
```

The exported `WorkflowPersistence` coordinator awaits initial, attempt, settlement, and final boundaries. Activity, structural changes, and workflow/phase/task skip events request coalesced best-effort writes; only one write is in flight and one most recent obligation is retained. The first required failure is retained as `fault`, stops further dispatch, and is never replaced; `durable` independently reports whether the final live state reached the store. Finalization detaches listeners before requesting the final checkpoint. Terminal live events can therefore precede their settlement write, while `execute` still waits for final durability. A store Promise that never settles also prevents the required checkpoint—and therefore `execute`—from settling; core has no storage timeout or cancellation contract. Unexpected scheduler/infrastructure faults stop and sweep the tree, attempt the final write, then reject if persistence itself settles.

### Managing workflows (registry + store seam)

`WorkflowManager` (`createWorkflowManager`) is the additive manager tier over the section above — a store-backed registry of live workflows, mirroring the `@orkestrel/agent` line's `ConversationManager` / `WorkspaceManager`. It is purely additive: direct `WorkflowStoreInterface` use and `createRestoredWorkflow` (both sections above) remain valid — a caller has a further, higher-level option that also tracks a `functions` registry so a hydrated workflow stays runnable.

```ts
import { createMemoryWorkflowStore, createWorkflowManager } from '@orkestrel/workflow'

const store = createMemoryWorkflowStore() // or createDatabaseWorkflowStore(driver)
const functions = { compile: async (controller) => `built ${controller.task.id}` }
const manager = createWorkflowManager({ store, functions })

const workflow = manager.add(definition) // minted, registered, runnable (functions flow in)
manager.workflow(workflow.id) // the same live workflow
manager.workflows() // every registered workflow, insertion order

await manager.save(workflow.id) // persist its snapshot to the store

// …later, in another turn / process, a fresh manager over the same store + functions…
const fresh = createWorkflowManager({ store, functions })
const reopened = await fresh.open(workflow.id) // hydrated from the store, runnable again

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

Unlike its `ConversationManager` / `WorkspaceManager` twins, there is no `active` / `switch` pointer — nothing in the workflow domain renders "the current workflow" the way an agent context renders the active conversation/workspace, so carrying one would be a speculative extra. `open` / `save` are otherwise the exact lenient store seam: `open` resolves a registered workflow directly (no store hit), else hydrates from `store` on a miss (`undefined` on a store miss or no store); `save` persists a registered workflow (`false` on an unknown id or no store) — never a throw.

### The helper functions — guards, derivation, lineage & synthesis

The pure functions the entity tree and runner are built from — exported directly, so a caller can reuse the same derivation or synthesis logic outside the shipped classes:

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

**The execution substrate.** Beneath the engine sit the shipped primitives it composes. The `Scheduler` paces the host between work; the queue-backed `Runner` bounds and drives a set of units; a `ControllerInterface` is the per-unit handle a handler receives; and the `WorkflowRunner` engine composes all of it over the entity tree — with `TaskControllerInterface` mirroring `ControllerInterface` one tier up, as the handle a workflow-task `WorkflowFunction` receives (its read-up `results()` is the inter-task data-flow map). The patterns below build that stack up from pacing to driving to the per-unit handle.

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

The following runner processes an ordered set of units.

```ts
import { createRunner } from '@orkestrel/workflow'

// Ordered (concurrency defaults to 1): each unit runs to completion before the next.
const runner = createRunner<Job, Output>({ handler: (controller) => compile(controller.input) })

const outputs = await runner.execute(jobs) // results in input order
```

### Bounded concurrency

The following runner limits the work that may remain in flight.

```ts
// Up to 5 units in flight at once; the rest wait for a slot (the Queue's backpressure).
const runner = createRunner<string, Response>({
	concurrency: 5,
	handler: (controller) => fetch(controller.input, { signal: controller.signal }),
})

const responses = await runner.execute(urls)
```

### Per-entry retries and timeout

The following runner derives reliability options for each entry.

```ts
// The runner-level retries / timeout are the defaults; `entries` overrides them per unit
// (its result is a RunnerEntryOptions — { retries?, timeout? }). An omitted field falls back.
const runner = createRunner<Job, Output>({
	retries: 0, // the default for every unit…
	handler: (controller) => compile(controller.input, controller.signal),
	entries: (job) => (job.flaky ? { retries: 3 } : {}), // …overridden per input
})
```

Runner reliability values use the Queue contract exactly: `concurrency` is a positive safe
integer, `retries` is a nonnegative safe integer, and `timeout` is an integer in
`0..2_147_483_647`, where `0` disables the deadline. The same `retries` / `timeout` strictness
applies to values returned by `entries`; invalid values throw rather than being floored or clamped.

### Fanning out with `spawn`

The following handler discovers and schedules sibling work.

```ts
// A handler discovers more work and fans it out as sibling units — they run through the
// same queue and their results join the output after the declared units, in spawn order.
const runner = createRunner<Task, Result>({
	concurrency: 8,
	handler: (controller) => {
		for (const child of discover(controller.input)) {
			void controller.spawn(child) // fire-and-track — do not await inline (deadlock caveat)
		}
		return process(controller.input)
	},
})

const results = await runner.execute(roots) // every declared root first, then every spawn
```

`spawn` returns the sibling's result promise, but the run drains it whether or not you await it — so fan out and return. All declared inputs are reserved before `start` is emitted, so even a public `spawn()` from a start listener is ordered after the complete declared list; Queue dispatch remains asynchronous, so `start` still precedes handler execution. On a bounded runner, awaiting a spawn _inline_ from a slot-holding handler can deadlock; let the runner drain the closure instead.

### The per-unit `ControllerInterface` handle — `wait` / `spawn` / `abort`

A `Runner` handler receives a `ControllerInterface` — the per-unit handle: its `id` / `input` / `signal` data plus `wait` (park until this unit is cancelled), `spawn` (fan out a sibling), and `abort` (cancel this unit, firing its signal with an optional reason).

```ts
import { createRunner } from '@orkestrel/workflow'

const runner = createRunner<Job, Output>({
	concurrency: 4,
	handler: async (controller) => {
		for (const child of discover(controller.input)) {
			void controller.spawn(child) // fan out a sibling unit through the same queue
		}
		const work = compile(controller.input, controller.signal) // honour the signal
		await Promise.race([work, controller.wait()]) // wait() parks until cancelled — never a timer
		if (overBudget(controller.input)) controller.abort(new Error('over budget')) // cancel this unit
		return work
	},
})
```

A handler observes its `controller.signal` (pass it to `fetch` / child aborts) and may `await controller.wait()` to park until the unit is cancelled — promise-parked, so it costs nothing until the signal fires; `spawn` fans out siblings through the same queue, and `abort` cancels this unit outright.

### Fail-fast and abort

The following runner propagates a unit failure or external abort across the run.

```ts
const runner = createRunner<Job, Output>({
	concurrency: 4,
	handler: (controller) => compile(controller.input, controller.signal),
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

### Observing the `Runner`

The `Runner` exposes a typed `emitter` carrying its run lifecycle for fire-and-forget observers — logging, metrics, tracing. Subscribe through `runner.emitter.on(...)`, or wire initial listeners through the reserved `on?` option; supply an `error?` handler to receive a listener's throw. **Emitting is observation-only**: every event fires strictly after the relevant unit-launch / settle / drain transition, so a listener can never change what the run does — and a throwing listener can never corrupt it.

```ts
import { createRunner } from '@orkestrel/workflow'

const runner = createRunner<Job, Output>({
	handler: (controller) => compile(controller.input),
	on: { finish: (results) => console.log(`done: ${results.length}`) }, // initial listener
})

runner.emitter.on('unit', (id) => trace.begin(id))
runner.emitter.on('fail', (id, error) => log.warn(`unit ${id} failed`, error))
```

The `RunnerEventMap<TResult>` vocabulary:

| Event    | Payload         | Fires when                                                                                |
| -------- | --------------- | ----------------------------------------------------------------------------------------- |
| `start`  | `[]`            | Declared units are reserved and `execute` begins, before asynchronous dispatch.           |
| `unit`   | `[id]`          | A unit's handler begins running (declared or spawned).                                    |
| `spawn`  | `[id, parent?]` | A sub-unit is spawned — its id + the spawning parent's id.                                |
| `settle` | `[id]`          | A unit completed successfully (its value recorded).                                       |
| `fail`   | `[id, error]`   | The first unit failure (fail-fast) — its id + the error.                                  |
| `finish` | `[results]`     | The batch settled successfully — the ordered results (the same array `execute` resolves). |
| `abort`  | `[reason]`      | The run was aborted — fail-fast cascade, a user `abort`, or `destroy`.                    |

A successful run fires `start` → `unit`/`settle` per unit → `finish`. A failure fires `fail` (the first failure only — later failures are ignored) then the run-level `abort`, and `execute` rejects without a `finish`. A user `abort` fires `abort` (the units are cancelled, not failed, so no `fail`).

**The listener-isolation safety contract.** A listener throw is never allowed to escape into the engine: the emitter isolates it and routes it to its own `error` handler (the `error` option, surfaced as `(error, event)`), not to a domain event — so a buggy observer is isolated yet not silently lost. Because every emit sits after the unit-launch / settle / drain transition and is isolated, a buggy observer **cannot corrupt the one-shot / fail-fast / spawn-tracking engine**: the outstanding-unit count gate stays balanced (the run still drains, never truncates or hangs) and fail-fast still rejects with the first error.

### Practices

- **Author the definition as data** — reference behavior by name (`behavior: '…'`, a plain string); register the handlers in `options.functions` at `execute`, not in the definition.
- **Express a dependency structurally** — put a task that needs another's output in a later phase; the phase boundary is the only dependency edge, and the inputs are ready after it.
- **Lean on the contract** — `createWorkflowContract().parse` an untrusted authored blob (an LLM tool arg) into a `WorkflowDefinition` or `undefined`; never trust raw JSON.
- **Choose `bail` deliberately** — `false` (graceful) when failures are useful data and every phase must run; `true` (halt) for transaction semantics where the first failure aborts the rest.
- **Hold the live tree the engine returns** — `result.workflow` is the source of truth; navigate it (`phase(id)?.task(id)?.status` / `.result`) and read the result tree (`results()`).
- **Snapshot for durability** — `workflow.snapshot()` is the pure-JSON payload; `createRestoredWorkflow` rebuilds an identical live tree, and the `WorkflowStore` seam persists it (W-d).
- **`yield` to stay cooperative** — between units of long-running work, `await scheduler.yield()` so the host can flush I/O, fire timers, and paint; never busy-loop a tight synchronous loop that starves the host.
- **Always thread a `signal` through the scheduler** — pass `options.signal` through `yield` / `delay` so cancellation rejects the pending wait at once (with the signal's `reason`) instead of stalling until the interval elapses; an aborted loop must fall out through that rejection, not a polled flag alone.
- **`delay` for spacing, `yield` for a turn** — reach for `delay(ms)` to space retries or paced work; reach for `yield()` (a zero-delay turn) when you only need to let the host run before continuing.
- **Type against `SchedulerInterface`** — depend on the interface, not a concrete class, and pick the backend at the composition root, so the same loop runs on any host.
- **Honour `controller.signal`** — pass it to `fetch` / child aborts and bail when it fires, so a fail-fast or an `abort` stops in-flight units instead of abandoning their results.
- **Fan out, don't await inline** — `spawn` siblings and return; the run drains the whole closure. Awaiting a spawn inline from a bounded handler risks a slot-starvation deadlock.
- **`concurrency: 1` for ordering** — there is no separate sequential flag; a concurrency of one runs units one-at-a-time.
- **One-shot** — a `Runner` runs one `execute`; create a new one to run another set.
- **Keep pacing event-free** — the scheduler is a functional primitive; observe the entity or runner that composes it.
- **Observe, don't drive** — subscribe to a node's `emitter` for progress / metrics, and to `runner.emitter` for run-lifecycle moments; emitting is a pure side-channel, so a listener never changes what a transition or run does (and a throwing one can't corrupt it).

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ source bijection across `src/core` (value + type exports), each behavioral interface's `## Methods` ↔ source-method bijection, each implementing-class ↔ interface method parity, and the equality gate: every `Summary` cell against its declaration's description paragraph, the titled `Author a definition and run it` fence against the `@example` block of that title (pinned so the titled pair cannot be retired silently), and the README pitch against this guide's tagline. It also runs the flagship fences and asserts the values their comments claim.
- [`tests/policy.test.ts`](../tests/policy.test.ts) — coding policy rejects private `@src/*` imports in TSDoc examples while accepting legitimate source imports and identical text in ordinary non-TSDoc comments.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — status/lineage/snapshot helpers, bounded silence inheritance, `scheduleHost` setup/cancellation race arbitration with exact falsy failures, hostile caller signal methods, and throwing cancellation closures after caller abort or host failure, plus the snapshot-decode leaves: remaining-budget recovery, established strict halt boundaries, exhausted recovery failures, monotonic stamps, exact-restore separation, and hostile inputs.
- [`tests/src/core/cloners.test.ts`](../tests/src/core/cloners.test.ts) — immutable activity cloning, hostile/revoked proxy containment, one-read getters, no alias retention, stamp-vs-restore `updated` handling, and exact wrong-storage-key `RESTORE` evidence.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) — total activity, task-failure, task-result, and owned-snapshot guards over valid, malformed, cyclic, throwing-proxy/getter/ownKeys, and revoked inputs.
- [`tests/src/core/shapers.test.ts`](../tests/src/core/shapers.test.ts) — the shape descriptors: the `taskShape` / `phaseShape` / `workflowShape` mirroring the hand-written definition interfaces, the per-field `description`s riding the `behavior` string + key fields (Rank 1), `describedLiteral`.
- [`tests/src/core/tasks/Task.test.ts`](../tests/src/core/tasks/Task.test.ts) — lifecycle plus whole-frame activity, validation/immutability, pulse, repeatable silence rearming, task signal, terminal cleanup, and cooperative pause.
- [`tests/src/core/phases/Phase.test.ts`](../tests/src/core/phases/Phase.test.ts) — the derived middle tier: child-transition cascade, `skip` / `stop` override, results, snapshot/restore, and isolated lifecycle emission including idempotent pause/resume.
- [`tests/src/core/Workflow.test.ts`](../tests/src/core/Workflow.test.ts) — the derived root: bail-aware cascade, result tree, override, snapshot/restore, teardown, and isolated lifecycle emission including idempotent pause/resume.
- [`tests/src/core/phases/PhaseManager.test.ts`](../tests/src/core/phases/PhaseManager.test.ts) — the lean phases registry: `append` / `phase` / `phases` / `count`, insertion order preserved.
- [`tests/src/core/tasks/TaskManager.test.ts`](../tests/src/core/tasks/TaskManager.test.ts) — the lean tasks registry: `append` / `task` / `tasks` / `count`, order surviving an interior `skip`.
- [`tests/src/core/WorkflowManager.test.ts`](../tests/src/core/WorkflowManager.test.ts) — the store-backed registry: `add` / `workflow` / `workflows` / `count`, `remove` / `clear`, runnable hydration, both-store parity, same-promise opens even under synchronous `get → open` reentry, add/remove/clear precedence, miss/failure retry, wrong-key refusal, invocation snapshots, strictly serialized `set → save` reentry, failure recovery, and independent ids.
- [`tests/src/core/tasks/TaskController.test.ts`](../tests/src/core/tasks/TaskController.test.ts) — folded cancellation, lineage gates, ancestor terminal-event wakeups, activity checkpoints, input, and live result read-up.
- [`tests/src/core/WorkflowRunner.test.ts`](../tests/src/core/WorkflowRunner.test.ts) — sequencing/concurrency/retry/cancellation plus ancestor terminal-event gate wakeups, graceful in-flight completion, retry activity reset, stale-attempt refusal, listener balance, and paused-attempt deadline exhaustion.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — definition construction, exact hostile-boundary restore, handler completeness, and snapshot diagnostics.
- [`tests/src/core/WorkflowPersistence.test.ts`](../tests/src/core/WorkflowPersistence.test.ts) — coalesced writes including synchronous store-triggered mutation with maximum one active writer and the most recent final snapshot, skipped-tier best-effort writes, attempt checkpoints awaited before dispatch, and persistence faults as data.
- [`tests/src/core/stores/MemoryWorkflowStore.test.ts`](../tests/src/core/stores/MemoryWorkflowStore.test.ts) — the in-memory store (W-d): a `set` → `get` round-trip returning the same `WorkflowSnapshot` and `createRestoredWorkflow`'ing an identical live tree, for both an all-pending snapshot (`createWorkflow(...).snapshot()`) and a real settled one driven through `createWorkflowRunner().execute` (real `completed` statuses + recorded results); the driver-swap parity case (the retrieved payload survives `JSON.parse(JSON.stringify(...))` and restores identically from the JSON-revived form — proving it persists unchanged across any JSON / SQLite / IndexedDB backend); `set` replacing under the same id; and `delete` (then `get` ⇒ `undefined`, an absent-id `delete` a no-op, an absent-id `get` ⇒ `undefined`). Real data throughout (a real `WorkflowDefinition` + real `WorkflowFunction` handlers), no mocks.
- [`tests/src/core/stores/DatabaseWorkflowStore.test.ts`](../tests/src/core/stores/DatabaseWorkflowStore.test.ts) — the driver-pluggable twin (W-d): real-table round trips and restore parity, upsert/delete/absence, exact valid-payload/wrong-row-key `RESTORE` evidence, malformed-row normalization, default-driver smoke, and distinct-id isolation. real `WorkflowSnapshot` values throughout, no mocks.
- [`tests/src/core/Runner.test.ts`](../tests/src/core/Runner.test.ts) — `execute` runs every input and returns results in declared order (even with out-of-order completion); spawned siblings and start-listener public spawns run after every declared result; nested spawns drain transitively; an entries-resolver graceful stop remains never-dispatched while resolver/property throws remain failures; bounded concurrency caps handlers in flight; `retries` re-run a flaky unit; fail-fast and abort cancellation; one-shot, empty-run lifecycle reentry, active/stopped reporting, and idempotent destroy.
- [`tests/src/core/RunHolder.test.ts`](../tests/src/core/RunHolder.test.ts) — the run-scoped cell: it starts empty, `hold(runner)` takes the phase runner and `hold()` releases it, a later `hold` swaps to the phase that is starting, a closure armed before any phase reads the live runner, and two holders stay independent so a nested run cannot clobber the outer one.
- [`tests/src/core/Controller.test.ts`](../tests/src/core/Controller.test.ts) — `wait()` resolves when the unit's signal aborts and stays pending across real delays until it does (promise-parked, not timer-polled), resolving immediately if already aborted; `id` / `input` / `signal` / `aborted` reflect the unit; `abort(reason)` fires the signal with the reason; `spawn` delegates to the injected callback.
- [`tests/src/core/Scheduler.test.ts`](../tests/src/core/Scheduler.test.ts) — real-clock macrotask ordering, pre-abort and pending-abort reason fidelity, minimum elapsed delay, settle-once cleanup, untouched caller listener methods, shared-signal cancellation, concurrent deadlines, host coercion for zero / negative / `NaN`, priority composition, and modest resolved/aborted churn.
- [`tests/src/server/NodeScheduler.test.ts`](../tests/src/server/NodeScheduler.test.ts) — the same real-clock contract over `setImmediate` / `setTimeout`, including exact primitive/string/object abort reasons, untouched caller listener methods, host timer coercion, cleanup, concurrent deadlines, and modest churn. Node may emit its native warning for negative or `NaN` timer input while applying host coercion.
- [`tests/src/server/factories.test.ts`](../tests/src/server/factories.test.ts) — `createNodeScheduler` returns a working `SchedulerInterface` (shape + a real yield/delay round-trip), abort-aware, independent stateless instances.
- [`tests/src/browser/BrowserScheduler.test.ts`](../tests/src/browser/BrowserScheduler.test.ts) — the browser backend in real headless Chromium (where `scheduler.postTask` exists): `yield()` resolves through the real `postTask` callback, every priority is accepted, abort rejects with the verbatim `signal.reason` and cancels the posted task, `delay` timing, and caller listener methods remain untouched.
- [`tests/src/browser/FrameScheduler.test.ts`](../tests/src/browser/FrameScheduler.test.ts) — the frame backend in real Chromium over `requestAnimationFrame`: `yield()` resolves in a real frame callback, abort cancels the rAF handle and rejects with the verbatim reason, `delay` timing, and caller listener methods remain untouched.
- [`tests/src/browser/IdleScheduler.test.ts`](../tests/src/browser/IdleScheduler.test.ts) — the idle backend in real Chromium over `requestIdleCallback`: `yield()` resolves in a real idle callback, abort cancels the idle handle and rejects with the verbatim reason, `delay` timing, and caller listener methods remain untouched; the `setTimeout(0)` fallback is covered by the guard logic + a note.
- [`tests/src/browser/factories.test.ts`](../tests/src/browser/factories.test.ts) — `createBrowserScheduler` / `createFrameScheduler` / `createIdleScheduler` each return a working `SchedulerInterface` (shape + a real yield/delay round-trip), abort-aware, independent instances, in real Chromium.

## See also

- [`contract.md`](contract.md) — the shape DSL and `createContract` the workflow definition contract is built on, and the `Result` a `TaskResult` boxes.
- The `@orkestrel/tool` package — generic definitions, a total call-envelope guard, invocation, and registry primitives an application may compose at its integration boundary. It does not validate arguments against schemas, and Workflow does not depend on it.
- [`abort.md`](abort.md) · [`timeout.md`](timeout.md) · [`budget.md`](budget.md) — the run-level bounds the runner (`Runner` / `WorkflowRunner`) folds; the scheduler (pacing) is documented in this guide.
- [`emitter.md`](emitter.md) — the typed emitter each live entity owns.
- [`AGENTS.md`](../AGENTS.md) — the rules: § Design laws for the `bail` boolean toggle, `.claude/rules/names.md` § Fixed lifecycle vocabulary, `.claude/rules/typescript.md` § Errors and outcomes for `Result`, and `.claude/rules/documentation.md` § Parity for documentation as a contract.
- [`README.md`](README.md) — the guides index.
