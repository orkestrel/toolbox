import { afterEach, describe, expect, it } from 'vitest'
import { createBrowser, createBrowserTool, findSystemBrowser } from '@scsr/server'
import type {
	BrowserInterface,
	BrowserMacro,
	BrowserToolInterface,
	BrowserToolResult,
} from '@scsr/server'
import { toArray, toRecord, validateSchema } from '../../../../setup.js'
import * as nodePath from 'node:path'

/** Auto-detected Chromium executable — undefined when no browser is available */
const systemBrowser = findSystemBrowser()

/** Port counter to avoid CDP port conflicts between sequential real browser tests */
let nextCdpPort = 19222

let tool: BrowserToolInterface | undefined
let browser: BrowserInterface | undefined

async function destroyAll(): Promise<void> {
	const currentTool = tool
	const currentBrowser = browser
	tool = undefined
	browser = undefined

	if (currentTool !== undefined) {
		await currentTool.destroy()
		return
	}

	if (currentBrowser !== undefined) {
		await currentBrowser.destroy()
	}
}

afterEach(async () => {
	await destroyAll()
})

function createMissingBrowser(): BrowserInterface {
	browser = createBrowser({
		executable: nodePath.join(process.cwd(), `missing-browser-${Date.now()}`),
		timeout: 50,
		cdp: { port: 19995 },
	})

	return browser
}

function setup(input?: {
	browser?: BrowserInterface
	executable?: string
	memory?: boolean
	macros?: readonly BrowserMacro[]
}): BrowserToolInterface {
	const cdpPort = input?.executable ? nextCdpPort++ : undefined
	tool = createBrowserTool({
		name: 'browser',
		summary: 'Browser automation',
		description: 'Navigate, inspect, and interact with web pages.',
		browser: input?.browser,
		executable: input?.executable,
		headless: true,
		timeout: 30_000,
		memory: input?.memory,
		macros: input?.macros,
		...(cdpPort !== undefined ? { cdp: { port: cdpPort } } : {}),
	})

	return tool
}

function dataUrl(html: string): string {
	return `data:text/html,${encodeURIComponent(html)}`
}

describe('BrowserTool', () => {
	describe('construction', () => {
		it('creates with name, summary, and description', () => {
			const currentTool = setup()
			expect(currentTool.name).toBe('browser')
			expect(currentTool.summary).toBe('Browser automation')
			expect(currentTool.description).toBe('Navigate, inspect, and interact with web pages.')
		})

		it('exposes valid JSON Schema parameters', () => {
			const currentTool = setup()
			const errors = validateSchema(currentTool.parameters)
			expect(errors).toEqual([])
		})

		it('exposes the configured browser instance', () => {
			const currentBrowser = createMissingBrowser()
			const currentTool = setup({ browser: currentBrowser })
			expect(currentTool.browser).toBe(currentBrowser)
		})

		it('pre-loads macros from input', () => {
			const macro: BrowserMacro = {
				id: 'test-macro',
				name: 'Test Macro',
				steps: [{ operation: 'status' }],
			}
			const currentTool = setup({ macros: [macro] })
			expect(currentTool.macro('test-macro')).toEqual(macro)
			expect(currentTool.macros().size).toBe(1)
		})
	})

	describe('lazy initialization', () => {
		it('init() does not eagerly connect the browser', async () => {
			const currentBrowser = createMissingBrowser()
			const currentTool = setup({ browser: currentBrowser })

			await expect(currentTool.init()).resolves.toBeUndefined()
			expect(currentTool.connected).toBe(false)
			expect(currentTool.browser.status).toBe('idle')
		})

		it('status reports an idle disconnected browser before launch', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({ operation: 'status' })
			const output = toRecord(result.output)

			expect(result.ok).toBe(true)
			expect(result.operation).toBe('status')
			expect(output['connected']).toBe(false)
			expect(output['status']).toBe('idle')
			expect(output['engine']).toBe('chromium')
			expect(output['count']).toBe(0)
		})

		it('lists zero pages before launch', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({ operation: 'pages' })
			const output = toRecord(result.output)
			const pages = toArray(output['pages'])

			expect(result.ok).toBe(true)
			expect(output['count']).toBe(0)
			expect(pages).toEqual([])
		})
	})

	describe('connection failures', () => {
		it('returns a tool-level error when launch fails', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({ operation: 'launch' })

			expect(result.ok).toBe(false)
			expect(result.operation).toBe('launch')
			expect(typeof result.error).toBe('string')
			expect(String(result.error).length).toBeGreaterThan(0)
		})

		it('returns a tool-level error when navigate triggers a failed auto-connect', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({
				operation: 'navigate',
				url: 'https://example.com',
			})

			expect(result.ok).toBe(false)
			expect(result.operation).toBe('navigate')
			expect(typeof result.error).toBe('string')
			expect(String(result.error).length).toBeGreaterThan(0)
		})
	})

	describe('argument validation', () => {
		it('returns error for missing operation', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({})

			expect(result.ok).toBe(false)
			expect(result.operation).toBe('status')
			expect(result.error).toContain('Missing or invalid operation')
		})

		it('returns error for unknown operation', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({ operation: 'explode' })

			expect(result.ok).toBe(false)
			expect(result.operation).toBe('status')
			expect(result.error).toContain('Unknown operation')
		})

		it('navigate requires url', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({ operation: 'navigate' })

			expect(result.ok).toBe(false)
			expect(result.error).toContain('url')
		})

		it('click requires selector', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({ operation: 'click' })

			expect(result.ok).toBe(false)
			expect(result.error).toContain('selector')
		})

		it('fill requires selector and value', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })

			const noSelector = await currentTool.execute({ operation: 'fill', value: 'x' })
			expect(noSelector.ok).toBe(false)
			expect(noSelector.error).toContain('selector')

			const noValue = await currentTool.execute({ operation: 'fill', selector: '#x' })
			expect(noValue.ok).toBe(false)
			expect(noValue.error).toContain('value')
		})

		it('select requires selector and values', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })

			const noSelector = await currentTool.execute({ operation: 'select', values: ['a'] })
			expect(noSelector.ok).toBe(false)
			expect(noSelector.error).toContain('selector')

			const noValues = await currentTool.execute({ operation: 'select', selector: '#x' })
			expect(noValues.ok).toBe(false)
			expect(noValues.error).toContain('values')
		})

		it('evaluate requires expression', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({ operation: 'evaluate' })

			expect(result.ok).toBe(false)
			expect(result.error).toContain('expression')
		})

		it('wait requires selector', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({ operation: 'wait' })

			expect(result.ok).toBe(false)
			expect(result.error).toContain('selector')
		})
	})

	describe('result shape', () => {
		it('ok result has operation, ok, output, error, category, and duration', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({ operation: 'status' })

			expect(result).toHaveProperty('operation')
			expect(result).toHaveProperty('ok')
			expect(result).toHaveProperty('output')
			expect(result).toHaveProperty('error')
			expect(result).toHaveProperty('category')
			expect(result).toHaveProperty('duration')
			expect(result.ok).toBe(true)
			expect(result.error).toBeUndefined()
			expect(result.category).toBeUndefined()
			expect(typeof result.duration).toBe('number')
		})

		it('error result has undefined output, string error, and error category', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({ operation: 'launch' })

			expect(result.ok).toBe(false)
			expect(result.output).toBeUndefined()
			expect(typeof result.error).toBe('string')
			expect(typeof result.category).toBe('string')
			expect(typeof result.duration).toBe('number')
		})
	})

	describe('macro management', () => {
		it('defines and stores a macro in memory', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({
				macro: {
					id: 'login',
					name: 'Login Flow',
					steps: [
						{ operation: 'navigate', url: 'https://example.com' },
						{ operation: 'fill', selector: '#user', value: 'admin' },
					],
				},
				memory: true,
			})

			expect(result.ok).toBe(true)
			expect(result.operation).toBe('batch')
			const output = toRecord(result.output)
			expect(output['id']).toBe('login')
			expect(output['name']).toBe('Login Flow')
			expect(output['steps']).toBe(2)
			expect(output['stored']).toBe(true)

			// Verify in-memory storage
			const macro = currentTool.macro('login')
			expect(macro).toBeDefined()
			expect(macro?.name).toBe('Login Flow')
			expect(macro?.steps.length).toBe(2)
		})

		it('respects default memory flag from constructor', async () => {
			const currentTool = setup({ browser: createMissingBrowser(), memory: true })
			await currentTool.execute({
				macro: {
					id: 'auto-saved',
					name: 'Auto Saved',
					steps: [{ operation: 'status' }],
				},
			})

			expect(currentTool.macro('auto-saved')).toBeDefined()
		})

		it('does not store without memory or persist flag when memory=false', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			await currentTool.execute({
				macro: {
					id: 'ephemeral',
					name: 'Ephemeral',
					steps: [{ operation: 'status' }],
				},
			})

			expect(currentTool.macro('ephemeral')).toBeUndefined()
		})

		it('lists stored macros', async () => {
			const currentTool = setup({
				browser: createMissingBrowser(),
				macros: [
					{ id: 'a', name: 'Macro A', steps: [{ operation: 'status' }] },
					{ id: 'b', name: 'Macro B', steps: [{ operation: 'pages' }, { operation: 'status' }] },
				],
			})

			const result = await currentTool.execute({ macros: true })
			expect(result.ok).toBe(true)
			const output = toRecord(result.output)
			const macros = toArray(output['macros'])
			expect(output['count']).toBe(2)
			expect(macros.length).toBe(2)
		})

		it('forgets a single macro by id', async () => {
			const currentTool = setup({
				browser: createMissingBrowser(),
				macros: [{ id: 'removable', name: 'Removable', steps: [{ operation: 'status' }] }],
			})

			expect(currentTool.macro('removable')).toBeDefined()

			const result = await currentTool.execute({ forget: 'removable' })
			expect(result.ok).toBe(true)
			expect(currentTool.macro('removable')).toBeUndefined()
		})

		it('forgets all macros', async () => {
			const currentTool = setup({
				browser: createMissingBrowser(),
				macros: [
					{ id: 'x', name: 'X', steps: [] },
					{ id: 'y', name: 'Y', steps: [] },
				],
			})

			expect(currentTool.macros().size).toBe(2)

			const result = await currentTool.execute({ forget: true })
			expect(result.ok).toBe(true)
			expect(currentTool.macros().size).toBe(0)
		})

		it('returns error for invalid forget value', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({ forget: 42 })

			expect(result.ok).toBe(false)
			expect(result.error).toContain('Invalid "forget" value')
		})

		it('reports when forgetting a non-existent macro', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({ forget: 'ghost' })

			expect(result.ok).toBe(true)
			const output = toRecord(result.output)
			expect(output['success']).toBe(false)
			expect(String(output['message'])).toContain('not found')
		})

		it('rejects macro without id', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({
				macro: { name: 'No ID', steps: [{ operation: 'status' }] },
				memory: true,
			})

			expect(result.ok).toBe(false)
			expect(result.error).toContain('id')
		})

		it('rejects macro without name', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({
				macro: { id: 'no-name', steps: [{ operation: 'status' }] },
				memory: true,
			})

			expect(result.ok).toBe(false)
			expect(result.error).toContain('name')
		})

		it('rejects macro without steps', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({
				macro: { id: 'empty', name: 'Empty', steps: [] },
				memory: true,
			})

			expect(result.ok).toBe(false)
			expect(result.error).toContain('steps')
		})
	})

	describe('macro replay', () => {
		it('replays a stored macro by id', async () => {
			const currentTool = setup({
				browser: createMissingBrowser(),
				macros: [
					{
						id: 'check-status',
						name: 'Check Status',
						steps: [{ operation: 'status' }],
					},
				],
			})

			const result = await currentTool.execute({ macroId: 'check-status' })
			expect(result.ok).toBe(true)
			expect(result.operation).toBe('batch')
			const output = toRecord(result.output)
			expect(output['completed']).toBe(1)
			expect(output['total']).toBe(1)
		})

		it('returns error for non-existent macroId', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({ macroId: 'missing' })

			expect(result.ok).toBe(false)
			expect(result.error).toContain('Macro not found')
		})

		it('provides available IDs hint when macro not found', async () => {
			const currentTool = setup({
				browser: createMissingBrowser(),
				macros: [{ id: 'exists', name: 'Exists', steps: [{ operation: 'status' }] }],
			})

			const result = await currentTool.execute({ macroId: 'missing' })
			expect(result.ok).toBe(false)
			expect(result.error).toContain('exists')
		})
	})

	describe('batch operations', () => {
		it('executes multiple status steps in batch', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({
				steps: [{ operation: 'status' }, { operation: 'pages' }],
			})

			expect(result.ok).toBe(true)
			expect(result.operation).toBe('batch')
			const output = toRecord(result.output)
			expect(output['completed']).toBe(2)
			expect(output['total']).toBe(2)
			const results = toArray(output['results']) as BrowserToolResult[]
			expect(results.length).toBe(2)
			expect(results[0]?.ok).toBe(true)
			expect(results[0]?.operation).toBe('status')
			expect(results[1]?.ok).toBe(true)
			expect(results[1]?.operation).toBe('pages')
		})

		it('stops batch on first failure', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({
				steps: [
					{ operation: 'status' },
					{ operation: 'navigate' }, // Missing url — will fail
					{ operation: 'status' }, // Should not execute
				],
			})

			expect(result.ok).toBe(true) // Batch itself succeeds
			const output = toRecord(result.output)
			expect(output['completed']).toBe(1) // Only status succeeded
			expect(output['total']).toBe(3)
			const results = toArray(output['results']) as BrowserToolResult[]
			expect(results.length).toBe(2) // status + failed navigate
			expect(results[0]?.ok).toBe(true)
			expect(results[1]?.ok).toBe(false)
		})

		it('reports error for step with missing operation', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({
				steps: [{ url: 'https://example.com' }],
			})

			expect(result.ok).toBe(true)
			const output = toRecord(result.output)
			expect(output['completed']).toBe(0)
			const results = toArray(output['results']) as BrowserToolResult[]
			expect(results.length).toBe(1)
			expect(results[0]?.ok).toBe(false)
			expect(results[0]?.error).toContain('missing or invalid operation')
		})

		it('reports error for step with unknown operation', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({
				steps: [{ operation: 'nonexistent' }],
			})

			expect(result.ok).toBe(true)
			const output = toRecord(result.output)
			const results = toArray(output['results']) as BrowserToolResult[]
			expect(results[0]?.ok).toBe(false)
			expect(results[0]?.error).toContain('unknown operation')
		})

		it('handles empty steps array', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({ steps: [] })

			expect(result.ok).toBe(true)
			const output = toRecord(result.output)
			expect(output['completed']).toBe(0)
			expect(output['total']).toBe(0)
		})
	})

	describe('status includes macros', () => {
		it('status output contains macro information', async () => {
			const currentTool = setup({
				browser: createMissingBrowser(),
				macros: [{ id: 'a', name: 'A', steps: [{ operation: 'status' }] }],
			})

			const result = await currentTool.execute({ operation: 'status' })
			const output = toRecord(result.output)
			expect(output['macroCount']).toBe(1)
			const macros = toArray(output['macros'])
			expect(macros.length).toBe(1)
		})
	})

	describe('dispatch priority', () => {
		it('macros=true takes priority over operation', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({ macros: true, operation: 'status' })

			expect(result.ok).toBe(true)
			expect(result.operation).toBe('batch')
			const output = toRecord(result.output)
			expect(output).toHaveProperty('macros')
		})

		it('forget takes priority over operation', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({ forget: true, operation: 'status' })

			expect(result.ok).toBe(true)
			expect(result.operation).toBe('batch')
		})

		it('steps takes priority over operation', async () => {
			const currentTool = setup({ browser: createMissingBrowser() })
			const result = await currentTool.execute({
				steps: [{ operation: 'status' }],
				operation: 'pages',
			})

			expect(result.ok).toBe(true)
			expect(result.operation).toBe('batch')
		})
	})

	describe.runIf(systemBrowser !== undefined)('real browser operations', () => {
		it('launches, fills, selects, evaluates, and closes', async () => {
			const executable = systemBrowser
			if (executable === undefined) {
				throw new Error('Expected system browser for real browser test')
			}

			const startUrl = dataUrl(`
                    <html lang="en">
                    <head><title>Browser Tool Test</title></head>
                    <body>
                        <form>
                            <input id="query" value="">
                            <select id="choice">
                                <option value="alpha">Alpha</option>
                                <option value="beta">Beta</option>
                            </select>
                            <button id="submit" type="button">Go</button>
                        </form>
                    </body>
                </html>
            `)

			const currentTool = setup({ executable })

			const launch = await currentTool.execute({ operation: 'launch' })
			expect(launch.ok).toBe(true)

			const navigate = await currentTool.execute({ operation: 'navigate', url: startUrl })
			expect(navigate.ok).toBe(true)

			const fill = await currentTool.execute({
				operation: 'fill',
				selector: '#query',
				value: 'browser tool test',
			})
			expect(fill.ok).toBe(true)

			const select = await currentTool.execute({
				operation: 'select',
				selector: '#choice',
				values: ['beta'],
			})
			expect(select.ok).toBe(true)

			const click = await currentTool.execute({ operation: 'click', selector: '#submit' })
			expect(click.ok).toBe(true)

			const evaluate = await currentTool.execute({
				operation: 'evaluate',
				expression: `({
                    query: document.querySelector('#query')?.value,
                    choice: document.querySelector('#choice')?.value,
                    title: document.title,
                })`,
			})
			const evaluateOutput = toRecord(evaluate.output)
			const evaluateResult = toRecord(evaluateOutput['result'])
			expect(evaluate.ok).toBe(true)
			expect(evaluateResult['query']).toBe('browser tool test')
			expect(evaluateResult['choice']).toBe('beta')
			expect(evaluateResult['title']).toBe('Browser Tool Test')

			const content = await currentTool.execute({ operation: 'content' })
			const contentOutput = toRecord(content.output)
			expect(content.ok).toBe(true)
			expect(contentOutput['title']).toBe('Browser Tool Test')

			const close = await currentTool.execute({ operation: 'close' })
			const closeOutput = toRecord(close.output)
			expect(close.ok).toBe(true)
			expect(closeOutput['remaining']).toBe(0)
		})

		it('executes batch form fill with real browser', async () => {
			const executable = systemBrowser
			if (executable === undefined) {
				throw new Error('Expected system browser for real browser test')
			}

			const formUrl = dataUrl(`
				<html lang="en">
				<head><title>Batch Form</title></head>
				<body>
					<input id="first" value="">
					<input id="second" value="">
					<p id="done">ready</p>
				</body>
				</html>
			`)

			const currentTool = setup({ executable })

			const launchResult = await currentTool.execute({ operation: 'launch' })
			expect(launchResult.ok).toBe(true)

			const result = await currentTool.execute({
				steps: [
					{ operation: 'navigate', url: formUrl },
					{ operation: 'fill', selector: '#first', value: 'hello' },
					{ operation: 'fill', selector: '#second', value: 'world' },
					{
						operation: 'evaluate',
						expression: `({
							first: document.querySelector('#first')?.value,
							second: document.querySelector('#second')?.value,
						})`,
					},
				],
			})

			expect(result.ok).toBe(true)
			expect(result.operation).toBe('batch')
			const output = toRecord(result.output)
			expect(output['completed']).toBe(4)
			expect(output['total']).toBe(4)

			const results = toArray(output['results']) as BrowserToolResult[]
			const evalResult = results[3]
			expect(evalResult?.ok).toBe(true)
			const evalOutput = toRecord(evalResult?.output)
			const evalData = toRecord(evalOutput['result'])
			expect(evalData['first']).toBe('hello')
			expect(evalData['second']).toBe('world')
		})

		it('saves macro and replays it with real browser', async () => {
			const executable = systemBrowser
			if (executable === undefined) {
				throw new Error('Expected system browser for real browser test')
			}

			const pageUrl = dataUrl(`
				<html lang="en">
				<head><title>Macro Test</title></head>
				<body><p id="target">macro content</p></body>
				</html>
			`)

			const currentTool = setup({ executable, memory: true })

			const defineResult = await currentTool.execute({
				macro: {
					id: 'visit-page',
					name: 'Visit test page',
					steps: [
						{ operation: 'launch' },
						{ operation: 'navigate', url: pageUrl },
						{ operation: 'content' },
					],
				},
				memory: true,
			})
			expect(defineResult.ok).toBe(true)

			const replayResult = await currentTool.execute({ macroId: 'visit-page' })
			expect(replayResult.ok).toBe(true)
			expect(replayResult.operation).toBe('batch')
			const output = toRecord(replayResult.output)
			expect(output['completed']).toBe(3)

			const results = toArray(output['results']) as BrowserToolResult[]
			const contentResult = results[2]
			expect(contentResult?.ok).toBe(true)
			const contentOutput = toRecord(contentResult?.output)
			expect(String(contentOutput['text'])).toContain('macro content')
		})

		it('scroll and hover work with real elements', async () => {
			const executable = systemBrowser
			if (executable === undefined) {
				throw new Error('Expected system browser for real browser test')
			}

			const pageUrl = dataUrl(`
				<html lang="en">
				<head><title>Scroll Test</title></head>
				<body style="height:3000px">
					<div id="top" style="height:50px">Top</div>
					<div id="bottom" style="position:absolute;top:2500px">Bottom</div>
				</body>
				</html>
			`)

			const currentTool = setup({ executable })

			await currentTool.execute({ operation: 'launch' })
			await currentTool.execute({ operation: 'navigate', url: pageUrl })

			const scrollResult = await currentTool.execute({
				operation: 'scroll',
				selector: '#bottom',
			})
			expect(scrollResult.ok).toBe(true)

			const hoverResult = await currentTool.execute({
				operation: 'hover',
				selector: '#top',
			})
			expect(hoverResult.ok).toBe(true)

			const scrollXY = await currentTool.execute({
				operation: 'scroll',
				x: 0,
				y: 0,
			})
			expect(scrollXY.ok).toBe(true)
		})

		it('create and close multiple pages', async () => {
			const executable = systemBrowser
			if (executable === undefined) {
				throw new Error('Expected system browser for real browser test')
			}

			const currentTool = setup({ executable })

			await currentTool.execute({ operation: 'launch' })

			const page2 = await currentTool.execute({
				operation: 'create',
				url: 'about:blank',
			})
			expect(page2.ok).toBe(true)
			const page2Output = toRecord(page2.output)
			expect(page2Output['index']).toBe(1)

			const pagesResult = await currentTool.execute({ operation: 'pages' })
			const pagesOutput = toRecord(pagesResult.output)
			expect(pagesOutput['count']).toBe(2)

			const closeResult = await currentTool.execute({ operation: 'close', page: 0 })
			expect(closeResult.ok).toBe(true)
			const closeOutput = toRecord(closeResult.output)
			expect(closeOutput['remaining']).toBe(1)
		})

		it('disconnect and reconnect preserves session', async () => {
			const executable = systemBrowser
			if (executable === undefined) {
				throw new Error('Expected system browser for real browser test')
			}

			const currentTool = setup({ executable })

			await currentTool.execute({ operation: 'launch' })
			expect(currentTool.connected).toBe(true)

			const disconnectResult = await currentTool.execute({ operation: 'disconnect' })
			expect(disconnectResult.ok).toBe(true)
			expect(currentTool.connected).toBe(false)

			const reconnectResult = await currentTool.execute({ operation: 'reconnect' })
			expect(reconnectResult.ok).toBe(true)
			expect(currentTool.connected).toBe(true)
		})

		it('screenshot returns base64 data', async () => {
			const executable = systemBrowser
			if (executable === undefined) {
				throw new Error('Expected system browser for real browser test')
			}

			const currentTool = setup({ executable })

			await currentTool.execute({ operation: 'launch' })
			await currentTool.execute({
				operation: 'navigate',
				url: dataUrl('<html lang="en"><body>Screenshot test</body></html>'),
			})

			const result = await currentTool.execute({
				operation: 'screenshot',
				format: 'png',
			})
			expect(result.ok).toBe(true)
			const output = toRecord(result.output)
			expect(typeof output['data']).toBe('string')
			expect(String(output['data']).length).toBeGreaterThan(0)
			expect(output['format']).toBe('png')
		})

		it('error categorization works for selector timeout', async () => {
			const executable = systemBrowser
			if (executable === undefined) {
				throw new Error('Expected system browser for real browser test')
			}

			const currentTool = setup({ executable })

			await currentTool.execute({ operation: 'launch' })
			await currentTool.execute({
				operation: 'navigate',
				url: dataUrl('<html lang="en"><body>Empty</body></html>'),
			})

			const result = await currentTool.execute({
				operation: 'click',
				selector: '#nonexistent',
				timeout: 500,
			})
			expect(result.ok).toBe(false)
			expect(result.category).toBe('selector')
		})
	})
})
