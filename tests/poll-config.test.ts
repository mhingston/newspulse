import { describe, expect, test } from "bun:test";
import { pollConfig } from "../src/poll-config";
import { config } from "../src/config";

describe("poll configuration", () => {
  test("defaults and validation do not require HTTP credentials", () => {
    expect(pollConfig({})).toEqual({ concurrency: 2, perHost: 1 });
    expect(
      pollConfig({ POLL_CONCURRENCY: "4", POLL_PER_HOST_CONCURRENCY: "2" }),
    ).toEqual({
      concurrency: 4,
      perHost: 2,
    });
    expect(() => pollConfig({ POLL_CONCURRENCY: "0" })).toThrow();
    expect(() => pollConfig({ POLL_PER_HOST_CONCURRENCY: "9" })).toThrow();
  });

  test("the server config still requires MCP_TOKEN, unrelated to poll limits", () => {
    expect(() => config({})).toThrow();
  });
});
