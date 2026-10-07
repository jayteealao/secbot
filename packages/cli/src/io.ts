import { createInterface } from "node:readline";

/** The CLI's console, injectable for tests. */
export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Lines the owner types, until end of input. */
  lines(): AsyncIterable<string>;
}

export const processIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  lines: () => createInterface({ input: process.stdin, terminal: false }),
};
