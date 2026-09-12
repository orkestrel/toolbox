// The consumer-side guides-parity entry runs `@orkestrel/guide` against this
// repository's own `guides/README.md` manifest. The constants that follow are this
// package's own, as is the executed section that closes the file.

import { GuideCommand } from '@orkestrel/guide/server'
import { readInventory } from '@orkestrel/test/server'
import { createVitest } from 'vitest/node'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** The one guide this package sources, whose tagline the README pitch equals. */
const GUIDE_SPEC = 'guides/toolbox.md'
/** The package identity that binds its manifest, module map, and README pitch. */
const PACKAGE_NAME = '@orkestrel/toolbox'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({
	[PACKAGE_NAME]: 'src/core',
	'@orkestrel/toolbox/server': 'src/server',
	'@src/core': 'src/core',
	'@src/server': 'src/server',
})
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten, and the assertion that follows it fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([
	'class TerminalBridge',
	'class TerminalConnection',
])

await new GuideCommand({
	root: new URL('../', import.meta.url),
	patterns: ['src/**/*.ts', 'tests/**/*.ts', 'guides/*.md', '*.md', 'package.json'],
	modules: MODULES,
	languages: FENCE_LANGUAGES,
	language: EXAMPLE_LANGUAGE,
	reader: readInventory,
	runner: createVitest,
}).execute(async ({ files, report, rows }) => {
	const { isRecord, parseJSON } = await import('@orkestrel/contract')
	const { computeSymbolKey, findMissingSymbols } = await import('@orkestrel/guide')
	const { createToolManager } = await import('@orkestrel/tool')
	const { requireValue } = await import('@orkestrel/test')
	const {
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
	} = await import('@src/core')
	const { describe, expect, it } = await import('vitest')
	const manifest = parseJSON(requireValue(files['package.json'], 'Missing inventory: package.json'))
	if (!isRecord(manifest)) throw new Error('Invalid package manifest: package.json')

	it('manifest lists at least one guide', () => {
		expect(report.input).toEqual([])
		expect(rows.length).toBeGreaterThan(0)
		expect(rows.map((row) => row.entry.spec)).toContain(GUIDE_SPEC)
	})

	// The example half of the equality case is silent over an empty population: with no
	// title on either side, the comparison has no pair. This pins the population this
	// repository's own guide contributes.
	it('pairs at least one example title across the guide and the source', () => {
		expect(report.examples.titles.filter((finding) => finding.spec === GUIDE_SPEC)).toEqual([])
	})

	it('opens the README with the guide tagline', () => {
		expect(manifest.name).toBe(PACKAGE_NAME)
		expect(report.pitch).toEqual([])
	})

	for (const { entry, guide, source } of rows) {
		describe(`${entry.concept}`, () => {
			it('uses only listed fence languages', () => {
				expect(report.fences.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('extracts a non-empty documented surface', () => {
				expect(guide.surface().length).toBeGreaterThan(0)
			})

			it('carries a summary for every documented and declared symbol', () => {
				expect(guide.surface().filter((symbol) => symbol.summary === undefined)).toEqual([])
				expect(source.surface().filter((symbol) => symbol.summary === undefined)).toEqual([])
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

			it('documents a populated method group', () => {
				expect(report.sections.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('keeps behavioral interfaces and implementing classes in parity', () => {
				expect(report.methods.filter((finding) => finding.spec === entry.spec)).toEqual([])
				expect(report.declarations.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('keeps every compared summary and example equal to its source', () => {
				expect(report.drift.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('documents an example for every Surface function', () => {
				expect(report.examples.fences.filter((finding) => finding.spec === entry.spec)).toEqual([])
				expect(report.examples.functions.filter((finding) => finding.spec === entry.spec)).toEqual(
					[],
				)
			})

			it('documents an example for every method', () => {
				expect(report.examples.methods.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('imports only real exports in every ```ts fence', () => {
				expect(report.imports.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('resolves every relative link', () => {
				expect(report.links.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('links only to test files that exist', () => {
				expect(report.tests.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})
		})
	}

	// The EXECUTED half. Every preceding check reads a name from guide or source text.
	// These cases run the flagship fences and assert the values their comments claim.
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
})
