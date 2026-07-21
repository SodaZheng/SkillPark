export const CANCELLED = Symbol("cancelled");
export type Cancelled = typeof CANCELLED;

export interface SelectionChoice {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface PromptPort {
  selectOne?(
    message: string,
    choices: SelectionChoice[],
  ): Promise<string | Cancelled>;
  selectMany(
    message: string,
    choices: SelectionChoice[],
  ): Promise<string[] | Cancelled>;
  confirm(message: string): Promise<boolean | Cancelled>;
}

export interface ProgressPort {
  start(message: string): void;
  message(message: string): void;
  advance(step: number, message: string): void;
  stop(message: string): void;
  error(message: string): void;
}

export interface OutputPort {
  intro(message: string): void;
  info(message: string): void;
  success(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  outro(message: string): void;
  write(message: string): void;
  progress?(maximum: number): ProgressPort;
}

export interface InputPort {
  read(): Promise<string>;
}
