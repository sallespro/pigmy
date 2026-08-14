import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const PROVIDER_ID = "openai";

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

function builtinModel(modelId) {
  try {
    const provider = openaiProvider();
    return (provider.models ?? []).find((m) => m.id === modelId);
  } catch {
    return undefined;
  }
}

export function createModelRegistry({ modelId, apiKey }) {
  if (apiKey) process.env.OPENAI_API_KEY = apiKey;

  const found = builtinModel(modelId);
  const model = found ?? describeModel(modelId);
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
  return { models, model, fromBuiltinCatalog: Boolean(found) };
}

export async function listAvailableModels(apiKey) {
  const response = await fetch(`${OPENAI_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await response.json();
  if (body.error) return { ok: false, error: body.error, ids: [] };
  const ids = (body.data ?? []).map((m) => m.id).sort();
  return { ok: true, error: null, ids };
}
