# Guides

A dual-axis index into this repository's guides — by concept, and by directory under AGENTS' documentation contract.

## By concept

| Concept | Spec                               | Source                                                   | Tests                                                                            |
| ------- | ---------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Toolbox | [`src/toolbox.md`](src/toolbox.md) | [`src/core`](../src/core), [`src/server`](../src/server) | [`tests/src/core`](../tests/src/core), [`tests/src/server`](../tests/src/server) |

## By directory

| Directory    | Guide                              |
| ------------ | ---------------------------------- |
| `src/core`   | [`src/toolbox.md`](src/toolbox.md) |
| `src/server` | [`src/toolbox.md`](src/toolbox.md) |

## Dependency reference

[`src/agent.md`](src/agent.md) is a byte-identical mirror of the guide for
`@orkestrel/agent` — a runtime dependency supplying the agent, conversation,
and delegation surfaces this package's concrete tools drive. It documents
**that package's** surface, not anything sourced in this repo.

[`src/workspace.md`](src/workspace.md) is a byte-identical mirror of the guide
for `@orkestrel/workspace` — the runtime dependency supplying the workspace,
file, manager, and store surfaces this package's workspace tool drives. It
documents **that package's** surface, not anything sourced in this repo.

[`src/tool.md`](src/tool.md) is a byte-identical mirror of the guide for
`@orkestrel/tool` — the runtime dependency supplying `ToolInterface`,
`createTool`, `ToolManager`, and the call/result envelope this package's
concrete tools plug into. It documents **that package's** surface, not
anything sourced in this repo.

[`src/contract.md`](src/contract.md) is a byte-identical mirror of the guide
for `@orkestrel/contract` — a runtime dependency, the shape DSL a tool's
`operation`-discriminated contract compiles through. It documents **that
package's** surface (guards, combinators, parsers, and the shape DSL), not
anything sourced in this repo; it is kept here so a reader of this package
can see the primitives it is built from without leaving this guide set.

[`src/workflow.md`](src/workflow.md) is a byte-identical mirror of the guide
for `@orkestrel/workflow` — a runtime dependency, the workflow primitives the
workflow-authoring tool wraps. It documents **that package's** surface, not
anything sourced in this repo; it is kept here for the same reason.

[`src/guide.md`](src/guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity
test suite (`tests/guides/src/parity.test.ts`). It documents **that
package's** surface (`Guide` / `Source`, the manifest and comparison
helpers), not anything sourced in this repo; it is kept here so a reader of
the parity suite can see the primitives it is built from without leaving
this guide set.

[`src/database.md`](src/database.md) is a byte-identical mirror of the guide
for `@orkestrel/database` — a runtime dependency, the typed database layer
(`DatabaseInterface`, `DriverInterface`, `KeyFunction`, the `QueryInput` /
`Condition` query DSL) `createDatabaseTool` wraps. It documents **that
package's** surface, not anything sourced in this repo; it is kept here so a
reader of this package can see the primitives it is built from without
leaving this guide set.

[`src/relation.md`](src/relation.md) is a byte-identical mirror of the guide
for `@orkestrel/relation` — a runtime dependency, the declarative ORM layer
(`RelationManagerInterface`, `ModelInterface`, `Include`) `createRelationTool`
wraps. It documents **that package's** surface, not anything sourced in this
repo; it is kept here for the same reason.

[`src/server.md`](src/server.md) is a byte-identical mirror of the guide for
`@orkestrel/server` — a runtime dependency supplying the SSE stream primitive
used by this package's terminal routes.

[`src/terminal.md`](src/terminal.md) is a byte-identical mirror of the guide for
`@orkestrel/terminal` — a runtime dependency supplying the prompt manager and
client surfaces this package's terminal tools and routes drive.

[`src/scaffold.md`](src/scaffold.md) is a byte-identical mirror of the guide for
`@orkestrel/scaffold` — the devDependency supplying this repository's
workspace-blueprint and policy infrastructure.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; documentation is an enforced contract.
