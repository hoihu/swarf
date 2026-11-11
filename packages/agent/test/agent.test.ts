import { describe, expect, it } from 'vitest';
import { EXAMPLES, analyze, emptyJob, type Job } from '@swarf/cam';
import { toApi as anthropicApi } from '../src/providers/anthropic.ts';
import { toApi as openaiApi } from '../src/providers/openai.ts';
import { SYSTEM_PROMPT, Agent, CAM_TOOLS, formatJobContext, DEMO_FALLBACK, DEMO_SCRIPTS, ScriptedProvider, runCamTool, type AgentEvent, type Block, type JobPort, type Script } from '../src/index.ts';

function port(job: Job): JobPort & { job: Job } {
  const p = { job, get: () => p.job, set: (j: Job) => (p.job = j) };
  return p;
}

async function turn(agent: Agent, text: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await agent.run(text, (e) => events.push(e));
  return events;
}

const use = (name: string, input: unknown): Block => ({ type: 'tool_use', id: '', name, input });

describe('tools', () => {
  it('have plain object schemas', () => {
    for (const t of CAM_TOOLS) expect(t.input_schema.type).toBe('object');
  });

  it('validate edits and answer with the checks', () => {
    const p = port(emptyJob('lathe'));
    const bad = runCamTool(p, 'add_operation', { operation: { type: 'lathe_turn', tool: 1, diameter: -3, zEnd: -10 } })!;
    expect(bad.isError).toBe(true);
    expect(p.job.operations).toHaveLength(0);

    const ok = runCamTool(p, 'add_operation', { operation: { type: 'lathe_turn', tool: 1, diameter: 20, zEnd: -10 } })!;
    expect(ok.isError).toBe(false);
    expect(ok.content).toMatch(/checks: clean/);
    expect(p.job.operations[0]!.id).toBe('op1');

    const upd = runCamTool(p, 'update_operation', { id: 'op1', changes: { zEnd: -80 } })!;
    expect(upd.content).toMatch(/CHUCK/);

    runCamTool(p, 'add_operation', { operation: { type: 'lathe_face', tool: 1 }, before: 'op1' });
    expect(p.job.operations.map((o) => o.id)).toEqual(['op2', 'op1']);
    runCamTool(p, 'move_operation', { id: 'op2' });
    expect(p.job.operations.map((o) => o.id)).toEqual(['op1', 'op2']);
    runCamTool(p, 'remove_operation', { id: 'op1' });
    expect(p.job.operations.map((o) => o.id)).toEqual(['op2']);

    const g = runCamTool(p, 'get_gcode', { opId: 'op2' })!;
    expect(g.content).toMatch(/G18 G7/);
  });
});

describe('material', () => {
  it('set_stock can change only the material, and the context shows the cutting data', () => {
    const p = port(EXAMPLES.lathe());
    const stock = p.job.stock;
    expect(runCamTool(p, 'set_stock', {})!.isError).toBe(true);
    const r = runCamTool(p, 'set_stock', { workMaterial: 'steel', material: 'C45' })!;
    expect(r.isError).toBeFalsy();
    expect(p.job.stock).toEqual(stock);
    expect(p.job.workMaterial).toBe('steel');
    const ctx = formatJobContext(p.job);
    expect(ctx).toContain('material: steel (Steel, C45)');
    expect(ctx).toMatch(/T1 turning: .*vc 120 m\/min, 0\.08 mm\/rev, 0\.5 mm\/pass/);
  });
});

describe('pictures', () => {
  const pic = { data: 'aGVsbG8=', mimeType: 'image/jpeg' };

  it('a picture attached to a message reaches the model with the words, and the prompt says how to read it', async () => {
    let seen: Block[] = [];
    const script: Script = { name: 'look', match: /sketch/, steps: [({ messages }) => { seen = messages.at(-1)!.content; return [{ type: 'text', text: 'I read Ø20 × 30.' }]; }] };
    const agent = new Agent({ provider: new ScriptedProvider([script]), job: port(emptyJob('lathe')) });
    const events: AgentEvent[] = [];
    await agent.run('Make the part in this sketch', (e) => events.push(e), undefined, [pic]);
    expect(seen[0]).toEqual({ type: 'image', ...pic });
    const text = seen.find((b) => b.type === 'text') as Extract<Block, { type: 'text' }>;
    expect(text.text).toMatch(/Make the part in this sketch\n\n\[A picture is attached to this message\.\]$/);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
    expect(SYSTEM_PROMPT).toMatch(/never take a size by measuring the picture/);
  });

  it('goes to Claude as an image block and to OpenAI-style APIs as an image_url, with the text', () => {
    const messages = [{ role: 'user' as const, content: [{ type: 'image' as const, ...pic }, { type: 'text' as const, text: 'this part' }] }];
    expect(anthropicApi(messages)[0]!.content).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: pic.data } }, { type: 'text', text: 'this part' }]);
    const o = openaiApi('sys', messages);
    expect(o[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'this part' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aGVsbG8=' } }] });
    expect(o).toHaveLength(2);
  });

  it('after a question was asked, the answer may carry a picture: tool results first', async () => {
    let seen: Block[] = [];
    const script: Script = {
      name: 'ask',
      match: /bracket/,
      steps: [[{ type: 'tool_use', id: 'q1', name: 'ask_user', input: { question: 'Which side up?', options: ['A', 'B'] } }], ({ messages }) => { seen = messages.at(-1)!.content; return [{ type: 'text', text: 'ok' }]; }],
    };
    const agent = new Agent({ provider: new ScriptedProvider([script]), job: port(emptyJob('mill')) });
    await agent.run('a bracket', () => {});
    await agent.run('A, as in this photo', () => {}, undefined, [pic]);
    expect(seen.map((b) => b.type)).toEqual(['tool_result', 'image', 'text']);
  });
});

describe('review', () => {
  it('the job state carries what is worth a look, for a review to start from', () => {
    const job = { ...EXAMPLES.mill(), operations: [...EXAMPLES.mill().operations].reverse() };
    const ctx = formatJobContext(job);
    expect(ctx).toMatch(/worth a look \(computed; not errors\):\n {2}ORDER_FACE op1: /);
    expect(ctx).toContain('HOLDING_UNKNOWN: Nothing is entered about how the block is held');
    expect(formatJobContext(EXAMPLES.lathe())).not.toContain('worth a look');
  });
});

describe('drawings', () => {
  it('summarises drawings for the model and moves them with place_shape', () => {
    const shape = { id: 's1', name: 'plate.dxf', at: { x: 0, y: 0 }, paths: [{ closed: true, pts: [[0, 0], [40, 0], [40, 30], [0, 30]] as [number, number][] }, { closed: false, pts: [[5, 5], [10, 5]] as [number, number][] }] };
    const p = port({ ...EXAMPLES.mill(), shapes: [shape] });
    const ctx = formatJobContext(p.job);
    expect(ctx).toMatch(/s1 plate\.dxf: 40\.0 × 30\.0 mm, on the stock at X0\.0–40\.0 Y0\.0–30\.0; 1 closed outline\(s\) \(largest 1200 mm²\), 1 open path/);
    const r = runCamTool(p, 'place_shape', { id: 's1', x: 10, y: 5 })!;
    expect(r.isError).toBe(false);
    expect(p.job.shapes[0]!.at).toEqual({ x: 10, y: 5 });
    const got = JSON.parse(runCamTool(p, 'get_job', {})!.content);
    expect(got.job.shapes[0].paths).toEqual([{ closed: true, points: 4 }, { closed: false, points: 2 }]);
  });
});

describe('agent loop', () => {
  it('runs the offline pin demo to a clean job', async () => {
    const p = port(emptyJob('lathe'));
    const agent = new Agent({ provider: new ScriptedProvider(DEMO_SCRIPTS, { fallback: DEMO_FALLBACK }), job: p });
    const events = await turn(agent, 'turn a pin Ø12 x 30');
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'complete' });
    expect(events.filter((e) => e.type === 'tool')).toHaveLength(4);
    expect(p.job.operations.map((o) => o.type)).toEqual(['lathe_face', 'lathe_turn', 'lathe_chamfer', 'lathe_partoff']);
    expect(analyze(p.job).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('runs the pocket demo on the mill', async () => {
    const p = port(EXAMPLES.mill());
    const agent = new Agent({ provider: new ScriptedProvider(DEMO_SCRIPTS), job: p });
    await turn(agent, 'pocket 30 x 20 x 4');
    const last = p.job.operations.at(-1)!;
    expect(last).toMatchObject({ type: 'mill_pocket_rect', w: 30, h: 20, zBottom: -4, x: 25, y: 15 });
  });

  it('does not finish while the job has errors', async () => {
    const script: Script = {
      name: 'chuck',
      match: /long/,
      steps: [
        [use('add_operation', { operation: { id: 'op1', type: 'lathe_turn', tool: 1, diameter: 20, zEnd: -80 } })],
        [{ type: 'text', text: 'Done.' }],
        [use('update_operation', { id: 'op1', changes: { zEnd: -40 } })],
        [{ type: 'text', text: 'Shortened it to stay clear of the chuck.' }],
      ],
    };
    const p = port(emptyJob('lathe'));
    const agent = new Agent({ provider: new ScriptedProvider([script]), job: p });
    const events = await turn(agent, 'a long shaft');
    const verify = events.filter((e) => e.type === 'verify');
    expect(verify).toHaveLength(1);
    expect((verify[0] as Extract<AgentEvent, { type: 'verify' }>).message).toMatch(/CHUCK/);
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'complete' });
    expect(p.job.operations[0]).toMatchObject({ zEnd: -40 });
  });

  it('asks the user and continues with the answer', async () => {
    const script: Script = {
      name: 'ask',
      match: /chamfer/,
      steps: [
        [use('ask_user', { question: 'Which edge?', options: ['front', 'shoulder'] })],
        ({ messages }) => {
          const answer = JSON.stringify(messages.at(-1));
          return [{ type: 'text', text: answer.includes('The user answered: front') ? 'Front it is.' : 'no answer' }];
        },
      ],
    };
    const agent = new Agent({ provider: new ScriptedProvider([script]), job: port(emptyJob('lathe')) });
    const first = await turn(agent, 'add a chamfer');
    expect(first).toContainEqual({ type: 'question', question: 'Which edge?', options: ['front', 'shoulder'] });
    expect(first.at(-1)).toEqual({ type: 'done', reason: 'question' });
    const second = await turn(agent, 'front');
    const text = second.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
    expect(text).toBe('Front it is.');
  });
});
