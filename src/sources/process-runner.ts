import { spawn } from "node:child_process";
import type { ProcessRunner } from "./types.js";

export const nodeProcessRunner: ProcessRunner = {
  run(command, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        stdio: "ignore",
      });
      const onError = (error: Error) => {
        child.off("exit", onExit);
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        child.off("error", onError);
        if (code === 0) {
          resolve();
        } else if (signal !== null && signal !== undefined) {
          reject(new Error(`${command} terminated by signal ${signal}`));
        } else {
          reject(new Error(`${command} exited with code ${code}`));
        }
      };
      child.once("error", onError);
      child.once("exit", onExit);
    });
  },
};
