/**
 * Jobs and tools as files. A job file is the whole job (machine, stock, tools, operations,
 * drawings) as JSON; the tool library is the user's own cutters, entered once and put into any
 * job. Both are checked against the schema when read: a file from elsewhere cannot bring in a
 * job the program would not have made.
 */
import { z } from 'zod';
import { CamError } from './program.ts';
import { Job, MachineKind, Tool } from './schema.ts';

const VERSION = 1;

/** A tool in the library: the tool as in a job (its number is the one it likes to have) and the machine it is for. */
export const LibraryTool = z.object({ kind: MachineKind, tool: Tool });
export type LibraryTool = z.infer<typeof LibraryTool>;
export const Library = z.array(LibraryTool);
export type Library = z.infer<typeof Library>;

function read(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CamError(`This is not a swarf ${what} file (it is not JSON).`);
  }
}

function problem(e: z.ZodError): string {
  const i = e.issues[0];
  return i ? `${i.path.join('.') || 'file'}: ${i.message}` : 'it does not fit';
}

export function jobFile(job: Job): string {
  return JSON.stringify({ swarf: 'job', version: VERSION, job }, null, 2) + '\n';
}

/** The job in a job file (or a bare job as JSON). Throws CamError with a sentence for the user. */
export function openJobFile(text: string): Job {
  const v = read(text, 'job') as { swarf?: unknown; version?: unknown; job?: unknown } | null;
  if (!v || typeof v !== 'object') throw new CamError('This is not a swarf job file.');
  if (v.swarf === 'tools') throw new CamError('This is a tool library, not a job: import it in the Tools tab.');
  if (typeof v.version === 'number' && v.version > VERSION) throw new CamError('This job file is from a newer swarf.');
  const parsed = Job.safeParse(v.swarf === 'job' ? v.job : v);
  if (!parsed.success) throw new CamError(`This job file does not fit (${problem(parsed.error)}).`);
  return parsed.data;
}

export function libraryFile(lib: Library): string {
  return JSON.stringify({ swarf: 'tools', version: VERSION, tools: lib }, null, 2) + '\n';
}

export function openLibraryFile(text: string): Library {
  const v = read(text, 'tool library') as { swarf?: unknown; version?: unknown; tools?: unknown } | null;
  if (!v || typeof v !== 'object') throw new CamError('This is not a swarf tool library.');
  if (v.swarf === 'job') throw new CamError('This is a job, not a tool library: open it with Open.');
  if (typeof v.version === 'number' && v.version > VERSION) throw new CamError('This tool library is from a newer swarf.');
  const parsed = Library.safeParse(v.tools);
  if (!parsed.success) throw new CamError(`This tool library does not fit (${problem(parsed.error)}).`);
  return parsed.data;
}

const key = (name: string) => name.trim().toLowerCase();
const same = (a: LibraryTool, kind: MachineKind, name: string) => a.kind === kind && key(a.tool.name) === key(name);

/** The library's tool of this name for this machine, if any. */
export function inLibrary(lib: Library, kind: MachineKind, name: string): LibraryTool | undefined {
  return lib.find((e) => same(e, kind, name));
}

/** Put a tool in the library; one of the same name for the same machine is replaced. */
export function keepTool(lib: Library, kind: MachineKind, tool: Tool): Library {
  const entry: LibraryTool = { kind, tool: structuredClone(tool) };
  return lib.some((e) => same(e, kind, tool.name)) ? lib.map((e) => (same(e, kind, tool.name) ? entry : e)) : [...lib, entry];
}

export function dropTool(lib: Library, kind: MachineKind, name: string): Library {
  return lib.filter((e) => !same(e, kind, name));
}

/**
 * Put a library tool into a job: under its own number when that is free, else the next free one.
 * A tool of the same name already in the job is brought up to the library's (keeping its number,
 * so the operations that use it stay with it).
 */
export function takeTool(job: Job, tool: Tool): { job: Job; id: number } {
  const there = job.tools.find((t) => key(t.name) === key(tool.name));
  if (there) return { job: { ...job, tools: job.tools.map((t) => (t === there ? { ...structuredClone(tool), id: there.id } : t)) }, id: there.id };
  const id = job.tools.some((t) => t.id === tool.id) ? Math.max(0, ...job.tools.map((t) => t.id)) + 1 : tool.id;
  return { job: { ...job, tools: [...job.tools, { ...structuredClone(tool), id }].sort((a, b) => a.id - b.id) }, id };
}
