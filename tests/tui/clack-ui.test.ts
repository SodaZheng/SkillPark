import { afterEach, describe, expect, it, vi } from "vitest";
import { createClackUi } from "../../src/tui/clack-ui.js";
import { CANCELLED } from "../../src/tui/ports.js";

const clack = vi.hoisted(() => ({
  cancelValue: Symbol("clack-cancel"),
  confirm: vi.fn(),
  intro: vi.fn(),
  isCancel: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  outro: vi.fn(),
  progress: vi.fn(),
}));

vi.mock("@clack/prompts", () => clack);

describe("Clack UI adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clack.confirm.mockReset();
    clack.isCancel.mockReset();
    clack.progress.mockReset();
  });

  it("maps a cancelled confirmation to CANCELLED", async () => {
    clack.confirm.mockResolvedValue(clack.cancelValue);
    clack.isCancel.mockImplementation((value) => value === clack.cancelValue);

    const ui = createClackUi();

    await expect(ui.prompts.confirm("Continue?")).resolves.toBe(CANCELLED);
    expect(clack.confirm).toHaveBeenCalledWith({
      initialValue: false,
      message: "Continue?",
    });
  });

  it("writes plain lines through the output port", () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    createClackUi().output.write("summary");

    expect(write).toHaveBeenCalledWith("summary\n");
  });

  it("creates a progress bar with the requested maximum", () => {
    const progressBar = {
      advance: vi.fn(),
      error: vi.fn(),
      message: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    clack.progress.mockReturnValue(progressBar);

    const created = createClackUi().output.progress?.(4);

    expect(clack.progress).toHaveBeenCalledWith({ max: 4 });
    expect(created).toBe(progressBar);
  });
});
