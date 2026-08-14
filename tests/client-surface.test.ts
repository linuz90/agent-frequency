import { describe, expect, test } from "bun:test";

import { classifyClientSurface, normalizeClientSurface } from "../src/client-surface";

describe("classifyClientSurface", () => {
  test("prefers the outer host app over its inner agent executable", () => {
    expect(classifyClientSurface({
      ancestry: [
        "/opt/bin/codex",
        "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)",
      ],
      clientName: "codex-mcp-client",
    })).toBe("t3-code");

    expect(classifyClientSurface({
      ancestry: [
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      ],
    })).toBe("codex-app");
  });

  test("recognizes Claude desktop and CLI clients", () => {
    expect(classifyClientSurface({
      ancestry: [
        "/Applications/Claude.app/Contents/Resources/claude",
        "/Applications/Claude.app/Contents/MacOS/Claude",
      ],
    })).toBe("claude-app");
    expect(classifyClientSurface({ ancestry: ["/usr/local/bin/claude"] })).toBe("cli");
    expect(classifyClientSurface({ clientName: "codex-mcp-client" })).toBe("cli");
  });

  test("uses a normalized explicit override before heuristics", () => {
    expect(classifyClientSurface({
      explicit: "Claude App",
      ancestry: ["/Applications/T3 Code.app/Contents/MacOS/T3 Code"],
    })).toBe("claude-app");
    expect(normalizeClientSurface("terminal")).toBe("cli");
    expect(normalizeClientSurface("untrusted value")).toBe("unknown");
  });
});
