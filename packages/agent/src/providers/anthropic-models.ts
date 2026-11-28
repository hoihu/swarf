/** Anthropic's models, apart from the provider so the SDK stays out of the first load. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicModelInfo {
  id: string;
  label: string;
  /** Adaptive thinking supported (all current models except Haiku 4.5). */
  adaptive: boolean;
  /** output_config.effort supported. */
  effort: boolean;
  /** Server-side refusal fallbacks recommended by default. */
  fallbacks: boolean;
  /** USD per million tokens (input, output). Cache reads bill at 0.1×, writes at 1.25× input. */
  price: { input: number; output: number };
}

export const ANTHROPIC_MODELS: AnthropicModelInfo[] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', adaptive: true, effort: true, fallbacks: true, price: { input: 5, output: 25 } },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', adaptive: true, effort: true, fallbacks: false, price: { input: 4, output: 20 } },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', adaptive: true, effort: true, fallbacks: true, price: { input: 10, output: 50 } },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', adaptive: true, effort: true, fallbacks: false, price: { input: 2, output: 10 } },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', adaptive: false, effort: false, fallbacks: false, price: { input: 1, output: 5 } },
];
