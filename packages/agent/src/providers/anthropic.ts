// Ported from hoihu/4k7 (packages/agent/src/providers/anthropic.ts). Keep the two in sync where it makes sense.
/**
 * Anthropic provider via the official SDK, called directly from the browser with the
 * user's own key (bring-your-own-AI). Streams text/thinking, replays assistant content
 * unchanged, caches the static prefix.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Block, Message, Provider, StepRequest, StepResult, StopReason } from '../types.ts';
import { ANTHROPIC_MODELS, type AnthropicModelInfo, type Effort } from './anthropic-models.ts';

const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  baseURL?: string;
}

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic';
  readonly label: string;
  private client: Anthropic;
  private model: AnthropicModelInfo;

  private opts: AnthropicOptions;

  constructor(opts: AnthropicOptions) {
    this.opts = opts;
    const id = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.model = ANTHROPIC_MODELS.find((m) => m.id === id) ?? { id, label: id, adaptive: true, effort: true, fallbacks: false, price: { input: 0, output: 0 } };
    this.label = this.model.label;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      dangerouslyAllowBrowser: true, // BYO key: the key belongs to the user and never leaves their browser except to Anthropic
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async step(req: StepRequest): Promise<StepResult> {
    const m = this.model;
    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model: m.id,
      max_tokens: this.opts.maxTokens ?? 32000,
      stream: true,
      system: [{ type: 'text', text: req.system }],
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Beta.BetaTool.InputSchema,
        eager_input_streaming: true, // inputs are validated by the kernel's zod schemas
      })),
      messages: toApi(req.messages),
      cache_control: { type: 'ephemeral' },
      ...(m.adaptive ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
      ...(m.effort ? { output_config: { effort: this.opts.effort ?? 'high' } } : {}),
      ...(m.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    };

    const stream = this.client.beta.messages.stream(params, req.signal ? { signal: req.signal } : undefined);
    stream.on('text', (delta) => req.onText?.(delta));
    stream.on('thinking', (delta) => req.onThinking?.(delta));
    const msg = await stream.finalMessage();

    const content: Block[] = [];
    for (const b of msg.content) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
      else if (b.type === 'thinking') content.push({ type: 'thinking', text: b.thinking });
      else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    }
    const u = msg.usage;
    return {
      content,
      raw: msg.content,
      stop: mapStop(msg.stop_reason),
      usage: {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
      model: msg.model,
      ...(msg.stop_reason === 'refusal' && msg.stop_details ? { detail: msg.stop_details.explanation ?? `Declined (${msg.stop_details.category ?? 'policy'})` } : {}),
    };
  }
}

function mapStop(s: string | null): StopReason {
  switch (s) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause_turn';
    default:
      return 'other';
  }
}

/**
 * Assistant turns are replayed from `raw` unchanged; user turns, and assistant turns of another
 * provider (the user switched mid-conversation), are built from blocks.
 */
export function toApi(messages: Message[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && Array.isArray(m.raw)) {
      return { role: 'assistant', content: m.raw as Anthropic.Beta.BetaContentBlockParam[] };
    }
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const b of m.content) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
      else if (b.type === 'image') content.push({ type: 'image', source: { type: 'base64', media_type: b.mimeType as 'image/png' | 'image/jpeg', data: b.data } });
      else if (b.type === 'tool_result') {
        const body = b.images?.length
          ? [
              { type: 'text' as const, text: b.content },
              ...b.images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mimeType as 'image/png' | 'image/jpeg', data: i.data } })),
            ]
          : b.content;
        content.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: body, ...(b.is_error ? { is_error: true } : {}) });
      }
      else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input as Record<string, unknown> });
    }
    return { role: m.role, content };
  });
}
