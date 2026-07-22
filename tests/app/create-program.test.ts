import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/app/create-program.js";
import pkg from "../../package.json" with { type: "json" };

describe("createProgram", () => {
  it("exposes the SkillPark package identity", () => {
    const program = createProgram();
    expect(program.name()).toBe("skillpark");
    expect(program.version()).toBe(pkg.version);
    expect(program.description()).toBe("Park and load agent skills on demand.");
  });
});
