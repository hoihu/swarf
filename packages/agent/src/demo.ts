/**
 * Offline demo scenarios for the scripted provider: the whole loop (tools, checks, verification)
 * runs without an API key. Numbers in the request are picked up, so "pin Ø12 x 30" works.
 */
import type { Block, Message } from './types.ts';
import type { Script } from './providers/scripted.ts';

const nums = (s: string) => [...s.matchAll(/(\d+(?:[.,]\d+)?)/g)].map((m) => Number(m[1]!.replace(',', '.')));
const use = (name: string, input: unknown): Block => ({ type: 'tool_use', id: '', name, input });
const say = (text: string): Block => ({ type: 'text', text });

/** The stock as the job state shows it to the model. */
function stockFrom(messages: Message[]): { bar?: { d: number; out: number }; block?: { x: number; y: number; z: number } } {
  const first = messages.findLast((m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text.includes('<job_state>')));
  const text = first?.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n') ?? '';
  const bar = text.match(/stock: bar Ø([\d.]+), ([\d.]+) mm out/);
  if (bar) return { bar: { d: Number(bar[1]), out: Number(bar[2]) } };
  const block = text.match(/stock: block ([\d.]+)×([\d.]+)×([\d.]+)/);
  if (block) return { block: { x: Number(block[1]), y: Number(block[2]), z: Number(block[3]) } };
  return {};
}

export const DEMO_SCRIPTS: Script[] = [
  {
    name: 'pin',
    match: /\b(pin|shaft|bolt|turn|drehen|welle|stift)\b/i,
    steps: [
      ({ userText, messages }) => {
        const s = stockFrom(messages);
        if (!s.bar) return [say('This demo turns pins on the lathe; switch the machine to the lathe example first.')];
        const [d = Math.min(16, s.bar.d - 2), len = 25] = nums(userText);
        if (d >= s.bar.d) return [say(`Ø${d} does not fit in the Ø${s.bar.d} bar.`)];
        return [
          say(`Plan: face, turn Ø${d} over ${len} mm, chamfer the end, part off with 3 mm extra for the face of the next part.`),
          use('add_operation', { operation: { type: 'lathe_face', tool: 1, z: 0 } }),
          use('add_operation', { operation: { type: 'lathe_turn', tool: 1, diameter: d, zEnd: -len } }),
          use('add_operation', { operation: { type: 'lathe_chamfer', tool: 1, diameter: d, z: 0, size: 0.5 } }),
          use('add_operation', { operation: { type: 'lathe_partoff', tool: 2, z: -(len + 3) } }),
        ];
      },
      [say('Done: faced, turned and chamfered, then parted off. Check the tool change to the parting blade (M0 pause) and the stickout before you run it.')],
    ],
  },
  {
    name: 'pocket',
    match: /\b(pocket|tasche)\b/i,
    steps: [
      ({ userText, messages }) => {
        const s = stockFrom(messages);
        if (!s.block) return [say('This demo mills pockets; switch the machine to the mill example first.')];
        const [w = 30, h = 20, depth = 5] = nums(userText);
        if (w + 4 > s.block.x || h + 4 > s.block.y) return [say(`A ${w}×${h} pocket does not fit in the ${s.block.x}×${s.block.y} block with walls left.`)];
        return [
          say(`Plan: a ${w}×${h} pocket, ${depth} mm deep, centred in the block.`),
          use('add_operation', {
            operation: { type: 'mill_pocket_rect', tool: 1, x: (s.block.x - w) / 2, y: (s.block.y - h) / 2, w, h, zBottom: -depth },
          }),
        ];
      },
      [say('Added the pocket. It plunges straight in, so the endmill must be centre-cutting.')],
    ],
  },
];

export const DEMO_FALLBACK =
  'This is the offline demo: it only knows two requests, e.g. "turn a pin Ø16 x 25" (lathe) or "pocket 30 x 20 x 5" (mill). Add an API key in Settings to talk to a real model.';
