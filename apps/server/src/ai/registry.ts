import type { AiConfig, AiProviderId } from './config.ts';
import type { AiProvider } from './provider.ts';
import { createAnthropicProvider } from './providers/anthropic.ts';
import { createMockProvider } from './providers/mock.ts';

export type ProviderFactory = (config: AiConfig) => AiProvider;

/**
 * The one place that knows the real providers. A new provider (e.g. Gemini, GDD §1) is one file in
 * providers/ plus one line here and in AI_PROVIDERS; core, rooms and rules do not change (C2).
 */
const factories: Record<AiProviderId, ProviderFactory> = {
  anthropic: createAnthropicProvider,
  mock: (config) => createMockProvider(config),
};

export function providerFor(config: AiConfig): AiProvider {
  return factories[config.provider](config);
}
