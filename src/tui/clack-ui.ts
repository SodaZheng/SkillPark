import * as clack from "@clack/prompts";
import type { OutputPort, PromptPort } from "./ports.js";
import { CANCELLED } from "./ports.js";
import { selectMany } from "./searchable-multiselect.js";

export function createClackUi(): { prompts: PromptPort; output: OutputPort } {
  return {
    prompts: {
      async selectOne(message, choices) {
        const result = await clack.select({
          message,
          options: choices.map((choice) => ({
            value: choice.value,
            label: choice.label,
            ...(choice.hint === undefined ? {} : { hint: choice.hint }),
            ...(choice.disabled === undefined
              ? {}
              : { disabled: choice.disabled }),
          })),
        });
        return clack.isCancel(result) ? CANCELLED : result;
      },
      selectMany,
      async confirm(message) {
        const result = await clack.confirm({ message, initialValue: false });
        return clack.isCancel(result) ? CANCELLED : result;
      },
    },
    output: {
      intro: clack.intro,
      info: clack.log.info,
      success: clack.log.success,
      warning: clack.log.warn,
      error: clack.log.error,
      outro: clack.outro,
      write: (message) => process.stdout.write(`${message}\n`),
      progress: (maximum) => clack.progress({ max: maximum }),
    },
  };
}
