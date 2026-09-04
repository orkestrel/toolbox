// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The four constants below are this
// package's own, and are the only part a sibling package changes.

import { describe, expect, it } from 'vitest'
import {
	computeSymbolKey,
	createGuide,
	createSource,
	createSourceManager,
	extractFenceImports,
	findMissing,
	findMissingSymbols,
	findUnexampled,
	findUnlisted,
	isExternalLink,
	parseManifest,
	resolveLink,
} from '@orkestrel/guide'
import {
	clampQuery,
	completeTaskDraft,
	createEndpointTool,
	createWorkflowDraftContract,
	deriveWorkflowDepth,
	expandInclude,
	extendLineage,
	isAgentFunction,
	isWorkflowLineage,
	normalizeLineage,
	tagAgent,
	tagWorkflow,
} from '@src/core'
import { createToolManager } from '@orkestrel/tool'
import { readFileSync } from 'node:fs'
import { requireValue } from '@orkestrel/test'
import { readInventory } from '@orkestrel/test/server'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({
	'@orkestrel/toolbox': 'src/core',
	'@orkestrel/toolbox/server': 'src/server',
	'@src/core': 'src/core',
	'@src/server': 'src/server',
})
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the second assertion below fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([
	'class TerminalBridge',
	'class TerminalConnection',
])

/** Root-level files this package's guides link to. `readInventory` walks directories only. */
const ROOT_FILES = Object.freeze(['AGENTS.md'])

const root = new URL('../', import.meta.url)
const files: Record<string, string> = {
	...readInventory(root, ['src', 'guides', 'tests'], { extensions: ['.ts', '.md'] }),
}
for (const name of ROOT_FILES) files[name] = readFileSync(new URL(name, root), 'utf8')
const manifest = parseManifest(
	requireValue(files['guides/README.md'], 'Missing file: guides/README.md'),
	'guides',
)
const sources = createSourceManager({ files, modules: MODULES })

it('manifest lists at least one guide', () => {
	expect(manifest.length).toBeGreaterThan(0)
})

for (const entry of manifest) {
	const guide = createGuide(requireValue(files[entry.spec], `Missing file: ${entry.spec}`))
	const source = createSource({ files, module: entry.source })

	describe(`${entry.concept}`, () => {
		it('uses only listed fence languages', () => {
			expect(findUnlisted(guide.fences(), FENCE_LANGUAGES)).toEqual([])
		})

		it('extracts a non-empty documented surface', () => {
			expect(guide.surface().length).toBeGreaterThan(0)
		})
		it('re-exports every direct declaration that is not named internal', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(stranded.filter((key) => !INTERNAL.includes(key))).toEqual([])
		})
		it('names no symbol internal that the barrel already exports', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(INTERNAL.filter((key) => !stranded.includes(key))).toEqual([])
		})
		it('re-exports only direct declarations', () => {
			expect(findMissingSymbols(source.surface(), source.exports())).toEqual([])
		})
		it('documents every barrel export', () => {
			expect(findMissingSymbols(source.surface(), guide.surface())).toEqual([])
		})
		it('documents only barrel exports', () => {
			expect(findMissingSymbols(guide.surface(), source.surface())).toEqual([])
		})

		it('exposes no hidden module-scope declarations', () => {
			expect(source.hidden().map(computeSymbolKey)).toEqual([])
		})

		for (const group of guide.methods()) {
			const members = source.methods(group.interface)
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface}`, () => {
				it('documents at least one method', () => {
					expect(group.methods.length).toBeGreaterThan(0)
				})
				it('documents every interface method', () => {
					expect(findMissing(members, group.methods)).toEqual([])
				})
				it('documents no phantom method', () => {
					expect(findMissing(group.methods, members)).toEqual([])
				})
				it(`${entity} exposes no undocumented method`, () => {
					const extra =
						entity === group.interface ? [] : findMissing(source.methods(entity), group.methods)
					expect(extra).toEqual([])
				})
			})
		}

		it('documents an example for every Surface function', () => {
			const fences = guide
				.fences()
				.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
				.map((fence) => fence.code)
			const names = guide
				.surface()
				.filter((symbol) => symbol.keyword === 'function')
				.map((symbol) => symbol.name)
			expect(findUnexampled(names, fences, source.examples())).toEqual([])
		})

		for (const group of guide.methods()) {
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface} examples`, () => {
				it('documents an example for every method', () => {
					const fences = guide
						.fences()
						.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
						.map((fence) => fence.code)
					const examples =
						entity === group.interface
							? source.examples(group.interface)
							: source.examples(group.interface).concat(source.examples(entity))
					expect(findUnexampled(group.methods, fences, examples)).toEqual([])
				})
			})
		}

		it('imports only real exports in every ```ts fence', () => {
			const fences = guide.fences().filter((fence) => fence.language === EXAMPLE_LANGUAGE)
			for (const fence of fences) {
				for (const { specifier, names } of extractFenceImports(fence.code)) {
					const imported = sources.source(specifier)
					if (imported === undefined) continue
					const surface = imported.surface().map((symbol) => symbol.name)
					expect(findMissing(names, surface)).toEqual([])
				}
			}
		})

		it('resolves every relative link', () => {
			const broken = guide
				.links()
				.filter((href) => !isExternalLink(href))
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(broken).toEqual([])
		})
		it('links only to test files that exist', () => {
			const missing = guide
				.tests()
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(missing).toEqual([])
		})
	})
}

// Change a fence, change the transcription beside it. Name resolution proves a symbol exists; only
// these executed transcriptions prove the values the guide's comments claim.

describe('flagship fences', () => {
	it('the ancestry-tag fence returns the tags, depth, and guard verdicts it claims', () => {
		expect(tagWorkflow('release')).toBe('workflow:release')
		expect(tagAgent('reviewer')).toBe('agent:reviewer')
		const lineage = normalizeLineage(['workflow:release'])
		expect(isWorkflowLineage(extendLineage(lineage, tagAgent('reviewer')))).toBe(true)
		expect(deriveWorkflowDepth(lineage)).toBe(0)
		expect(isAgentFunction(() => 'opaque')).toBe(false)
	})

	it('the draft-completion fence fills the ids and names it claims', () => {
		expect(
			createWorkflowDraftContract().parse({ phases: [{ tasks: [{ behavior: 'compile' }] }] }),
		).toBeDefined()
		expect(completeTaskDraft({ behavior: 'compile' }, 'phase-0', 0)).toEqual({
			id: 'phase-0-task-0',
			name: 'phase-0-task-0',
			behavior: 'compile',
		})
	})

	it('the relation-include fence expands the flat dot-paths into the tree it claims', () => {
		expect(expandInclude(['contacts', 'contacts.account'], 3)).toEqual({
			contacts: { account: true },
		})
	})

	it('the clampQuery fence probes one row past the effective limit it claims', () => {
		const { query, limit } = clampQuery(undefined, 100)
		expect(limit).toBe(100)
		expect(query.limit).toBe(101)
	})

	it('the endpoint-bridge fence returns the row its comment claims', async () => {
		const tool = createEndpointTool({
			name: 'lookupUser',
			description: 'Look up a user by id.',
			samples: [
				{ id: '1', name: 'Ada' },
				{ id: '2', name: 'Bob' },
			],
			execute: async (args) => ({ id: args.id, name: 'Ada' }),
		})
		const tools = createToolManager()
		tools.add(tool)

		const result = await tools.execute({
			id: 'call-1',
			name: 'lookupUser',
			arguments: { id: '1', name: 'Ada' },
		})

		if (!result.success) throw new Error('expected the endpoint call to succeed')
		expect(result.value).toEqual({ id: '1', name: 'Ada' })
	})
})
