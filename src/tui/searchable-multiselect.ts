import { isCancel, Prompt } from "@clack/core";
import type { Key } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { SelectionChoice } from "./ports.js";
import { CANCELLED } from "./ports.js";
import { createTheme } from "./theme.js";

export interface SelectionState {
  searchMode: boolean;
  selected: Set<string>;
}

type VisibleSelection = string | Pick<SelectionChoice, "value" | "disabled">;

export function reduceSelectionKey(
  state: SelectionState,
  key: string,
  visible: readonly VisibleSelection[],
): SelectionState {
  if (key === "/") {
    return { searchMode: true, selected: new Set(state.selected) };
  }
  if (key !== "a" || state.searchMode) {
    return state;
  }

  const enabledValues = visible.flatMap((choice) => {
    if (typeof choice === "string") {
      return [choice];
    }
    return choice.disabled ? [] : [choice.value];
  });
  const selected = new Set(state.selected);
  const allSelected = enabledValues.every((value) => selected.has(value));

  for (const value of enabledValues) {
    if (allSelected) {
      selected.delete(value);
    } else {
      selected.add(value);
    }
  }

  return { ...state, selected };
}

export interface SelectManyIo {
  input?: Readable;
  output?: Writable;
  noColor?: boolean;
}

interface SkillMultiSelectPromptOptions extends SelectManyIo {
  choices: SelectionChoice[];
  message: string;
  theme: ReturnType<typeof createTheme>;
}

// AutocompletePrompt tracks readline's private line buffer, which can retain action
// characters on current Node versions. A non-tracking Prompt keeps this reducer authoritative.
class SkillMultiSelectPrompt extends Prompt<string[]> {
  searchMode = false;
  selectedValues: string[] = [];
  private readonly choices: SelectionChoice[];
  private readonly message: string;
  private query = "";
  private readonly theme: ReturnType<typeof createTheme>;

  get cursor(): number {
    return this._cursor;
  }

  get filteredOptions(): SelectionChoice[] {
    const search = this.query.toLowerCase();
    if (!search) {
      return this.choices;
    }
    return this.choices.filter((choice) =>
      `${choice.label} ${choice.hint ?? ""}`.toLowerCase().includes(search),
    );
  }

  constructor(options: SkillMultiSelectPromptOptions) {
    super(
      {
        validate: (value) =>
          value && value.length > 0 ? undefined : "Select at least one item",
        ...(options.input ? { input: options.input } : {}),
        ...(options.output ? { output: options.output } : {}),
        render() {
          return renderSkillMultiSelect(this as SkillMultiSelectPrompt);
        },
      },
      false,
    );
    this.choices = options.choices;
    this.message = options.message;
    this.theme = options.theme;
    this._cursor = this.findEnabledCursor(0, 1);
    this.on("key", (char, key) => this.handleKey(char, key));
  }

  get searchQuery(): string {
    return this.query;
  }

  get promptMessage(): string {
    return this.message;
  }

  get promptTheme(): ReturnType<typeof createTheme> {
    return this.theme;
  }

  private handleKey(char: string | undefined, key: Key): void {
    if (key.name === "up" || key.name === "down") {
      const direction = key.name === "up" ? -1 : 1;
      this._cursor = this.findEnabledCursor(
        this._cursor + direction,
        direction,
      );
      return;
    }

    if (key.name === "space") {
      const focused = this.filteredOptions[this._cursor];
      if (focused && !focused.disabled) {
        const selected = new Set(this.selectedValues);
        if (selected.has(focused.value)) {
          selected.delete(focused.value);
        } else {
          selected.add(focused.value);
        }
        this.selectedValues = [...selected];
      }
      return;
    }

    if (key.name === "return") {
      this._setValue([...this.selectedValues]);
      return;
    }

    if (key.name === "backspace" && this.searchMode) {
      this.query = this.query.slice(0, -1);
      this._cursor = this.findEnabledCursor(0, 1);
      return;
    }

    if (char?.length !== 1 || key.ctrl || key.meta) {
      return;
    }

    if (!this.searchMode && char === "/") {
      this.searchMode = true;
      this.query = "";
      this._cursor = this.findEnabledCursor(0, 1);
      return;
    }

    if (!this.searchMode && char === "a") {
      const next = reduceSelectionKey(
        { searchMode: false, selected: new Set(this.selectedValues) },
        char,
        this.filteredOptions,
      );
      this.selectedValues = [...next.selected];
      return;
    }

    if (this.searchMode) {
      this.query += char;
      this._cursor = this.findEnabledCursor(0, 1);
    }
  }

  private findEnabledCursor(start: number, direction: -1 | 1): number {
    const options = this.filteredOptions;
    if (options.length === 0) {
      return 0;
    }

    for (let offset = 0; offset < options.length; offset += 1) {
      const index =
        (start + offset * direction + options.length) % options.length;
      if (!options[index]?.disabled) {
        return index;
      }
    }
    return 0;
  }
}

function renderSkillMultiSelect(prompt: SkillMultiSelectPrompt): string {
  const theme = prompt.promptTheme;
  if (prompt.state === "submit") {
    return theme.accent(`${prompt.selectedValues.length} selected`);
  }
  if (prompt.state === "cancel") {
    return theme.muted("Cancelled");
  }

  const search = prompt.searchMode ? ` / ${prompt.searchQuery}` : "";
  const rows = prompt.filteredOptions.map((option, index) => {
    const checked = prompt.selectedValues.includes(option.value) ? "◆" : "◇";
    const label = `${checked} ${option.label}${option.hint ? `  ${option.hint}` : ""}`;
    if (option.disabled) {
      return theme.muted(`  ${label}`);
    }
    return index === prompt.cursor
      ? theme.selected(`› ${label}`)
      : `  ${label}`;
  });
  const feedback = prompt.state === "error" ? [theme.error(prompt.error)] : [];

  return [
    theme.accent(prompt.promptMessage),
    theme.muted(`Search${search}`),
    ...feedback,
    ...rows,
    theme.muted(
      "↑↓ move  space select  a all  / search  enter confirm  esc cancel",
    ),
  ].join("\n");
}

export async function selectMany(
  message: string,
  choices: SelectionChoice[],
  io: SelectManyIo = {},
): Promise<string[] | typeof CANCELLED> {
  const theme = createTheme(io.noColor);
  const prompt = new SkillMultiSelectPrompt({ choices, message, theme, ...io });
  const result = await prompt.prompt();

  if (isCancel(result)) {
    return CANCELLED;
  }
  if (
    !Array.isArray(result) ||
    !result.every((value) => typeof value === "string")
  ) {
    throw new TypeError("Multi-select prompt submitted an invalid selection");
  }
  return result;
}
