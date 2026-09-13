/** Normalize thrown values at external I/O boundaries without weakening strict catch types. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BridgeError extends Error {
  constructor(message: string, public status = 400, public details?: unknown) {
    super(message);
    this.name = 'BridgeError';
  }
}
