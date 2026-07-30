import type {
	DatabaseDefinition,
	DatabaseDefinitionRow,
	DefinitionStoreInterface,
} from '../types.js'
import type { TableInterface } from '@orkestrel/database'
import { isDatabaseDefinition } from '../helpers.js'

/**
 * A {@link DefinitionStoreInterface} backed by one table of the `@orkestrel/database` layer — a
 * database's durable CONFIG state IS a row, so persistence reduces to keyed point-access
 * (`get` / `set` / `delete`) over a {@link TableInterface}, the driver-pluggable twin of the
 * plain-`Map` {@link import('./MemoryDefinitionStore.js').MemoryDefinitionStore}.
 *
 * @remarks
 * The store is driver-agnostic: it holds a single {@link TableInterface} whose backend (memory,
 * JSON, SQLite, IndexedDB) is chosen by whoever builds it (the factories), so a JSON / SQLite /
 * IndexedDB backend swaps in WITHOUT touching a consumer — the same seam as
 * {@link import('./MemoryDefinitionStore.js').MemoryDefinitionStore}. The driver defaults to
 * memory ({@link import('../factories.js').createDatabaseDefinitionStore} passes
 * `createMemoryDriver()`), so it ALSO works in memory out of the box; you opt into the durable
 * plumbing by passing a JSON / SQLite / IndexedDB driver.
 *
 * The {@link DatabaseDefinition} is stored as ONE OPAQUE JSON COLUMN — the table is a row of
 * `{ id; definition }` ({@link DatabaseDefinitionRow}). The definition is already a COMPLETE,
 * self-contained, pure-JSON CONFIG payload (never a live handle), so storing it whole is lossless
 * AND keeps the row type flat (`definition` reads back as `unknown`).
 *
 * - **`set(definition)` upserts under the definition's OWN `id`** (no separate id param) — it
 *   writes the row `{ id: definition.id, definition }`.
 * - **`get(id)` resolves the stored definition for an id**, narrowing the opaque JSON column back
 *   to a {@link DatabaseDefinition} ({@link import('../helpers.js').isDatabaseDefinition} — the
 *   AGENTS §14 boundary narrow for an untrusted storage read), or `undefined` if none is stored
 *   or the stored blob is malformed.
 * - **`delete(id)` drops a definition by id**; an absent id is a no-op (no throw).
 *
 * The public surface is EXACTLY `get` / `set` / `delete` — no extra members (the §22 method
 * bijection with {@link DefinitionStoreInterface}).
 *
 * @example
 * ```ts
 * import { createDatabaseDefinitionStore, createMemoryDriver } from '@src/core'
 *
 * const store = createDatabaseDefinitionStore(createMemoryDriver()) // a durable driver swaps in here
 * await store.set({ id: 'shop', driver: 'memory', tables: {} }) // persist the config (one JSON column)
 * const definition = await store.get('shop')
 * await store.delete('shop')
 * ```
 */
export class DatabaseDefinitionStore implements DefinitionStoreInterface {
	readonly #table: TableInterface<DatabaseDefinitionRow>

	/**
	 * Wrap a table as a definition store.
	 *
	 * @param table - The {@link TableInterface} holding the definitions — its row is the
	 *   {@link DatabaseDefinitionRow} `{ id; definition }` shape (the definition one opaque JSON column)
	 */
	constructor(table: TableInterface<DatabaseDefinitionRow>) {
		this.#table = table
	}

	/** Resolve the persisted definition for `id`, narrowing the opaque JSON column back to a `DatabaseDefinition`. */
	async get(id: string): Promise<DatabaseDefinition | undefined> {
		const row = await this.#table.get(id)
		if (row === undefined) return undefined
		// The definition crosses back as an untrusted storage read (a structured clone / a JSON
		// row), so narrow the opaque JSON column with the boundary guard rather than a cast (AGENTS
		// §14); a malformed blob resolves `undefined`, never a broken definition.
		return isDatabaseDefinition(row.definition) ? row.definition : undefined
	}

	/** Insert or replace under the definition's OWN `id` (no separate id param) — the row is `{ id, definition }`. */
	async set(definition: DatabaseDefinition): Promise<void> {
		await this.#table.set({ id: definition.id, definition })
	}

	/** Drop a definition by id; an absent id is a no-op (no throw). */
	async delete(id: string): Promise<void> {
		await this.#table.remove(id)
	}
}
