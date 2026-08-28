import type { DatabaseDefinition, DefinitionStoreInterface } from '../types.js'

/**
 * The in-memory {@link DefinitionStoreInterface} — a process-lifetime `Map` of
 * {@link DatabaseDefinition}s keyed by database id, the DEFAULT store
 * {@link import('../factories.js').createMemoryDefinitionStore} builds. It implements the same
 * {@link DefinitionStoreInterface} contract as
 * {@link import('./DatabaseDefinitionStore.js').DatabaseDefinitionStore}: this store copies on
 * write and on read; the table-backed store narrows an untrusted stored blob and reports
 * `undefined` for a malformed one.
 *
 * @remarks
 * A plain `Map<string, DatabaseDefinition>` (the definition is already pure,
 * self-contained CONFIG-only JSON, so no encoding is needed for the memory tier). Values are
 * structured-cloned on both write and read, keeping caller mutation outside the store. There is NO
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
 * The public surface is EXACTLY `get` / `set` / `delete` — no extra members (the method
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

	/**
	 * Resolves the persisted definition for `id`, copied out of the backing `Map`.
	 *
	 * @param id - The database id to read
	 * @returns The stored {@link DatabaseDefinition}, or `undefined` when none is stored
	 */
	get(id: string): Promise<DatabaseDefinition | undefined> {
		const definition = this.#definitions.get(id)
		return Promise.resolve(definition === undefined ? undefined : structuredClone(definition))
	}

	/**
	 * Inserts or replaces a definition under its OWN `id`, copied into the backing `Map`.
	 *
	 * @param definition - The config to persist; its own `id` is the key (no separate id param)
	 * @returns A promise settling once the definition is stored
	 */
	set(definition: DatabaseDefinition): Promise<void> {
		this.#definitions.set(definition.id, structuredClone(definition))
		return Promise.resolve()
	}

	/**
	 * Drops the definition stored under `id`.
	 *
	 * @param id - The database id to drop; an absent id is a no-op, never a throw
	 * @returns A promise settling once no definition is stored under `id`
	 */
	delete(id: string): Promise<void> {
		this.#definitions.delete(id)
		return Promise.resolve()
	}
}
