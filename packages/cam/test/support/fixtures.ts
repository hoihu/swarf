// Helpers shared by the cam tests.
import { EXAMPLES, Job, analyze, type OperationInput } from '../../src/index.ts';
import type { JobInput } from '../../src/schema.ts';

export const codes = (job: Job) => analyze(job).diagnostics.map((d) => d.code);
export const withOps = (kind: 'lathe' | 'mill', ops: OperationInput[], patch: Partial<JobInput> = {}): Job =>
  Job.parse({ ...EXAMPLES[kind](), operations: ops, ...patch });
