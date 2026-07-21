const ESC = "\u001b[";

const wrap =
  (open: string, close: string, enabled: boolean) =>
  (value: string): string =>
    enabled ? `${open}${value}${close}` : value;

export function createTheme(noColor?: boolean, trueColor?: boolean) {
  const disabled =
    noColor ??
    ("NO_COLOR" in process.env ||
      !process.stdout.isTTY ||
      process.env.TERM === "dumb");
  const useTrueColor =
    trueColor ?? /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? "");
  const palette = useTrueColor
    ? {
        accent: `${ESC}38;2;169;154;255m`,
        text: `${ESC}38;2;236;235;255m`,
        muted: `${ESC}38;2;124;129;159m`,
        selected: `${ESC}48;2;41;39;90m${ESC}38;2;247;245;255m`,
        error: `${ESC}38;2;255;123;145m`,
      }
    : {
        accent: `${ESC}38;5;141m`,
        text: `${ESC}38;5;255m`,
        muted: `${ESC}38;5;102m`,
        selected: `${ESC}48;5;17m${ESC}38;5;255m`,
        error: `${ESC}38;5;204m`,
      };
  const enabled = !disabled;

  return {
    accent: wrap(palette.accent, `${ESC}39m`, enabled),
    text: wrap(palette.text, `${ESC}39m`, enabled),
    muted: wrap(palette.muted, `${ESC}39m`, enabled),
    selected: wrap(palette.selected, `${ESC}39m${ESC}49m`, enabled),
    error: wrap(palette.error, `${ESC}39m`, enabled),
  };
}
