#!/usr/bin/env node
// Lokal stdio-inngang (Claude Desktop, Claude Code osv.)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

await createServer().connect(new StdioServerTransport());
