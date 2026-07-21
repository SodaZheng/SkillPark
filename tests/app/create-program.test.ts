import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/app/create-program.js";

describe("createProgram", () => {
  it("exposes the SkillPark package identity", () => {
    const program = createProgram();
    expect(program.name()).toBe("skillpark");
    expect(program.version()).toBe("0.1.0");
    expect(program.description()).toBe("Park and load agent skills on demand.");
  });
});
