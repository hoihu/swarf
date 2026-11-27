/**
 * Something to tell the user about the job: a check's error or warning, a line of the emitted
 * G-code the lint stops at, or a note from the review (worth a look, not an error). Where it is:
 * the operation, the move (index into the flattened move list, see program.walk) or the G-code line.
 */
export interface Diagnostic {
  severity: 'error' | 'warning' | 'note';
  code: string;
  message: string;
  opId?: string;
  /** Index into the flattened move list (see program.walk). */
  move?: number;
  /** 1-based line of the G-code text. */
  line?: number;
}
