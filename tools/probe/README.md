# Capability probe

Runs an AI CLI (`claude`, `codex`, `agy`) through fixed scenarios and records its real output as
fixtures. No dependencies beyond Node 18+.

```bash
node tools/probe/probe.mjs <claude|codex|agy> [--scenario hello,mcp,shell,artifact,resume|all]
                                              [--model <id>] [--bin <path>] [--out fixtures]
                                              [--timeout <sec>] [--redact value1,value2]
```

- `probe-mcp.mjs` is a minimal stdio MCP server that logs every message and exposes one tool,
  `probe_get_context`.
- Exit code is `0` when all checks pass, `1` otherwise. Fixtures are written either way.

See [docs/integrations/README.md](../../docs/integrations/README.md) for what the outputs mean.
