/**
 * Model resolution.
 *
 * pi ships an `openaiProvider()` whose auth and streaming wiring is exactly
 * what this harness wants, but whose static model catalog is generated at
 * build time and is empty in a plain npm install. So rather than hand-rolling
 * a provider, this module reuses pi's own construction (`envApiKeyAuth` +
 * `openAIResponsesApi`) and supplies the model descriptor itself.
 *
 * If a future pi build already lists the model, that entry is used unchanged.
 */

import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const PROVIDER_ID = "openai";

/**
 * Descriptor for a GPT-5.x-family model on the OpenAI Responses API.
 *
 * Context window and max output are the published GPT-5.x family limits. Cost
 * is declared zero: this harness does no billing accounting, and inventing a
 * price would be a claim without a witness.
 */
export function describeModel(id) {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider: PROVIDER_ID,
    baseUrl: OPENAI_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400_000,
    maxTokens: 128_000,
  };
}

/** The model entry pi already knows for this id, or undefined. */
function builtinModel(modelId) {
  try {
    const provider = openaiProvider();
    return (provider.models ?? []).find((m) => m.id === modelId);
  } catch {
    // A provider that cannot be constructed simply contributes no catalog.
    return undefined;
  }
}

/**
 * Build a `Models` registry able to stream `modelId`.
 *
 * The key is passed through the provider's api-key auth. pi's `envApiKeyAuth`
 * resolves from the process environment, so the caller sets `OPENAI_API_KEY`
 * in `process.env` before constructing the registry; the value is never
 * written to disk or logged by this module.
 */
export function createModelRegistry({ modelId, apiKey }) {
  if (apiKey) process.env.OPENAI_API_KEY = apiKey;

  const model = builtinModel(modelId) ?? describeModel(modelId);
  const base = openaiProvider();

  const provider = createProvider({
    id: PROVIDER_ID,
    name: "OpenAI",
    baseUrl: OPENAI_BASE_URL,
    auth: base.auth,
    models: [model],
    api: openAIResponsesApi(),
  });

  const models = createModels();
  models.setProvider(provider);
  return { models, model, fromBuiltinCatalog: Boolean(builtinModel(modelId)) };
}
