import { createInterface } from 'node:readline/promises';

export interface ConfirmationPrompt {
  confirm(question?: string): Promise<boolean>;
}

export class TerminalConfirmationPrompt implements ConfirmationPrompt {
  async confirm(question = 'Apply this Steward init plan? [y/N] '): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new Error('Steward confirmation requires an interactive TTY');
    }
    const terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    try {
      const answer = (await terminal.question(question)).trim().toLowerCase();
      return answer === 'y' || answer === 'yes';
    } finally {
      terminal.close();
    }
  }
}
