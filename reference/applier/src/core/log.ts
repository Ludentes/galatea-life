/**
 * Where the applier says what it cannot answer anyone with: a store gone away, a bridge's fault, a bug
 * in a promise no caller awaits. One line at a time, never carrying a secret. The entry points give
 * stderr; a host that embeds the applier gives its own.
 */
export type Log = (line: string) => void;

/** Says nothing: the default where no log is given (a test, a host that has not chosen one). */
export const quiet: Log = () => undefined;
