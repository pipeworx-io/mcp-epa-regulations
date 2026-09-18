# mcp-epa-regulations

EPA Regulations MCP — US Environmental Protection Agency regulations (40 CFR).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `epa_regulation` | Get the full text of one EPA regulation — a US Environmental Protection Agency rule codified in 40 CFR — by its citation. Returns the exact regulatory wording currently in force. Answers "what does 40 CFR 261 say", "what is the EPA regulation for X", "does the EPA require X", "read 40 CFR 60.1", "the RCRA hazardous waste rule", "the Clean Air Act / Clean Water Act regulation for X". Forgiving citation input: "261.4", "40 CFR 261.4", "§60.1", even "261.4(a)" (paragraph stripped to the section). Covers 40 CFR part 60 new source performance standards (emission standards / Clean Air Act), part 261 identification & listing of hazardous waste (RCRA), part 262 hazardous waste generators, part 122 NPDES permits (Clean Water Act), part 141 national primary drinking water regulations, part 63 NESHAP air toxics, TSCA parts (700s) toxic substances — the whole of Title 40 (air, water, waste, chemicals). This is EPA REGULATIONS (the rules/regulatory text); for EPA DATA (facility enforcement, ECHO compliance, GHG emissions) use the epa-echo / epa-emissions tools. Pass a whole part (e.g. "261" or "60") to get that part's section list. Example: epa_regulation({ citation: "261.4" }) -> exclusions from hazardous waste; epa_regulation({ citation: "40 CFR 60.1" }) -> applicability of emission standards. Keyless. |
| `epa_search` | Keyword search across EPA regulations — US Environmental Protection Agency rules in 40 CFR. Answers "what EPA regulations cover X", "the environmental regulation / EPA rule about X", "find the EPA requirement for X". Great for topics: hazardous waste identification (RCRA), emission standards and air quality (Clean Air Act), NPDES water discharge permits (Clean Water Act), drinking water standards, air toxics / NESHAP, toxic substances (TSCA), Superfund / CERCLA, pesticide registration (FIFRA), greenhouse gas reporting requirements, underground storage tanks, stormwater. Returns matching EPA regulations with citation (40 CFR), heading, excerpt, and source URL. This searches EPA REGULATIONS (regulatory text); for EPA DATA (facility enforcement, ECHO, GHG emissions figures) use the epa-echo / epa-emissions tools. Example: epa_search({ query: "hazardous waste identification" }); epa_search({ query: "emission standards", limit: 15 }). Keyless. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "epa-regulations": {
      "url": "https://gateway.pipeworx.io/epa-regulations/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/epa-regulations/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Epa Regulations data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/epa_regulation \
  -H 'Content-Type: application/json' \
  -d '{"citation":"261.4"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/epa_regulation`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.
