# @orkestrel/toolbox

Concrete, LLM-callable tools for the `@orkestrel` line. Toolbox supplies workflow
authoring, workspace editing, sub-agent delegation, terminal prompts, database and
relation operations, and schema inference over the
[`@orkestrel/tool`](https://github.com/orkestrel/tool) runtime.

The runtime envelope and registry (`ToolInterface`, `ToolCall`, `ToolResult`,
`createTool`, and `createToolManager`) live in `@orkestrel/tool`. This package supplies
the concrete handlers that plug into that runtime, including workspace operations over
`@orkestrel/workspace` and agent delegation over `@orkestrel/agent`.

## Install

```sh
npm install @orkestrel/toolbox
```

## Example

```ts
import { createToolManager } from '@orkestrel/tool'
import { createWorkspaceTool } from '@orkestrel/toolbox'

const tools = createToolManager()
tools.add(createWorkspaceTool())

const result = await tools.execute({
	id: 'write-1',
	name: 'workspace',
	arguments: {
		operation: 'write',
		path: 'notes.txt',
		content: 'hello',
	},
})
```

Core tools are published from `@orkestrel/toolbox`; terminal route integration is
published from `@orkestrel/toolbox/server`.

## Requirements

- Node.js >= 22
- Dual ESM and CommonJS builds

## Guide

See [`guides/src/toolbox.md`](guides/src/toolbox.md). The vendored
[`guides/src/tool.md`](guides/src/tool.md) and
[`guides/src/workspace.md`](guides/src/workspace.md) document the runtime dependencies.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
