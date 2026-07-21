import { afterEach, describe, expect, it, vi } from "vitest";
import { createTheme } from "../../src/tui/theme.js";

describe("Midnight Iris theme", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses true-color ANSI and respects an explicit no-color setting", () => {
    expect(createTheme(false, true).accent("pdf")).toContain(
      "\u001b[38;2;169;154;255m",
    );
    expect(createTheme(true).accent("pdf")).toBe("pdf");
  });

  it("respects NO_COLOR from the environment", () => {
    vi.stubEnv("NO_COLOR", "1");

    expect(createTheme(undefined, true).accent("pdf")).toBe("pdf");
  });

  it("falls back to plain text when stdout is not a TTY", () => {
    const originalIsTty = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });

    try {
      expect(createTheme(undefined, true).selected("pdf")).toBe("pdf");
    } finally {
      if (originalIsTty) {
        Object.defineProperty(process.stdout, "isTTY", originalIsTty);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }
  });
});
