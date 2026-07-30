import type { DatabaseDefinition, DefinitionStoreInterface } from '../types.js'

/**
 * The in-memory {@link DefinitionStoreInterface} — a process-lifetime `Map` of
 * {@link DatabaseDefinition}s keyed by database id, the DEFAULT store
 * {@link import('../factories.js').createMemoryDefinitionStore} builds. The EXACT twin of
 * {@link import('./DatabaseDefinitionStore.js').DatabaseDefinitionStore}.
 *
 * @remarks
 * A plain `Map<string, DatabaseDefinition>` (AGENTS §21 — the definition is already pure,
 * self-contained CONFIG-only JSON, so no encoding is needed for the memory tier). There is NO
 * idle-TTL and NO eviction: a persisted definition lives until an explicit `delete`. A durable
 * backend (JSON / SQLite / IndexedDB) swaps in through the SAME interface without touching a
 * consumer — its driver-pluggable twin is
 * {@link import('./DatabaseDefinitionStore.js').DatabaseDefinitionStore} (the definition as one
 * opaque JSON column).
 *
 * - **`get` resolves the persisted definition for an id**, or `undefined` if none is stored.
 * - **`set` inserts / replaces under the definition's OWN `id`** (no separate id param).
 * - **`delete` drops a definition by id**; an absent id is a no-op (no throw).
 *
 * The public surface is EXACTLY `get` / `set` / `delete` — no extra members (the §22 method
 * bijection with {@link DefinitionStoreInterface}).
 *
 * @example
 * ```ts
 * import { createMemoryDefinitionStore } from '@src/core'
 *
 * const store = createMemoryDefinitionStore()
 * await store.set({ id: 'shop', driver: 'memory', tables: {} })
 * const definition = await store.get('shop')
 * await store.delete('shop')
 * ```
 */
export class MemoryDefinitionStore implements DefinitionStoreInterface {
	readonly #definitions = new Map<string, DatabaseDefinition>()

	get(id: string): Promise<DatabaseDefinition | undefined> {
		return Promise.resolve(this.#definitions.get(id))
	}

	set(definition: DatabaseDefinition): Promise<void> {
		// Insert / replace under the definition's OWN id (no separate id param).
		this.#definitions.set(definition.id, definition)
		return Promise.resolve()
	}

	delete(id: string): Promise<void> {
		// Drop by id; `Map.delete` of an absent id is already a no-op (no throw).
		this.#definitions.delete(id)
		return Promise.resolve()
	}
}
