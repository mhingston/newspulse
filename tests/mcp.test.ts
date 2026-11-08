import { test } from "bun:test";
import { smoke } from "./smoke";
test("RSS → persisted SQLite → restart → real HTTP MCP client", smoke);
