/** Error thrown by a `Run` implementation. Carries stdout so a caller can recognise a benign non-zero exit. */
export class CommandError extends Error {
  constructor(message: string, readonly code: 'COMMAND_FAILED' | 'TIMEOUT', readonly stdout = '') { super(message) }
}
