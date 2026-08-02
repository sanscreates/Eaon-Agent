// Provider registry: resolve providers/models from config, list all models for sub-agents.

import type { EaonConfig, ModelRef, Provider } from "../types.js";
import { anthropicBackend } from "./anthropic.js";
import type { LLMBackend } from "./base.js";
import { echoBackend } from "./echo.js";
import { openaiBackend } from "./openai.js";

const backends: Record<string, LLMBackend> = {
  openai: openaiBackend,
  anthropic: anthropicBackend,
  echo: echoBackend,
};

export function backendFor(p: Provider): LLMBackend {
  const b = backends[p.type];
  if (!b) throw new Error(`Unknown provider type: ${p.type}`);
  return b;
}

export function findProvider(cfg: EaonConfig, id: string): Provider | undefined {
  return cfg.providers.find((p) => p.id === id);
}

export function resolveModel(cfg: EaonConfig, ref: ModelRef): { provider: Provider; model: string } {
  const p = findProvider(cfg, ref.provider);
  if (!p) throw new Error(`Provider not configured: ${ref.provider}`);
  return { provider: p, model: ref.model };
}

export interface ListedModel {
  provider: string;
  providerName: string;
  model: string;
  role?: "main" | "compressor";
}

export interface ProviderPreset {
  id: string;
  name: string;
  type: "openai" | "anthropic";
  baseUrl: string;
  keyEnv: string;
  hint: string;
  /** Only keep models passing this predicate (e.g. free-tier gateways). */
  filter?: (modelId: string) => boolean;
  /** Models used when the /models endpoint is unreachable. */
  fallbackModels?: string[];
}

/** Every model the user has configured across providers — used by sub-agent picker. */
export function listAllModels(cfg: EaonConfig): ListedModel[] {
  const out: ListedModel[] = [];
  for (const p of cfg.providers) {
    for (const m of p.models) {
      out.push({
        provider: p.id,
        providerName: p.name,
        model: m,
        role: cfg.main?.provider === p.id && cfg.main?.model === m ? "main" : cfg.compressor?.provider === p.id && cfg.compressor?.model === m ? "compressor" : undefined,
      });
    }
  }
  return out;
}

/** Resolve a free-form model query ("deepseek-v4-flash" or "openrouter/deepseek...") to a ModelRef. */
export function matchModel(cfg: EaonConfig, query: string): ModelRef | undefined {
  const q = query.trim();
  if (!q) return undefined;
  if (q.includes("/")) {
    const [prov, ...rest] = q.split("/");
    const p = findProvider(cfg, prov);
    if (p) return { provider: p.id, model: rest.join("/") };
  }
  const all = listAllModels(cfg);
  const exact = all.find((m) => m.model === q);
  if (exact) return { provider: exact.provider, model: exact.model };
  const partial = all.filter((m) => m.model.toLowerCase().includes(q.toLowerCase()));
  if (partial.length) return { provider: partial[0].provider, model: partial[0].model };
  // fall back: use main provider with the raw model id
  if (cfg.main) return { provider: cfg.main.provider, model: q };
  return undefined;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "anthropic", name: "Anthropic (native)", type: "anthropic", baseUrl: "https://api.anthropic.com", keyEnv: "ANTHROPIC_API_KEY", hint: "Claude models" },
  { id: "openai", name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", hint: "GPT models" },
  { id: "openrouter", name: "OpenRouter", type: "openai", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", hint: "many models, one key" },
  { id: "deepseek", name: "DeepSeek", type: "openai", baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY", hint: "cheap + strong" },
  { id: "groq", name: "Groq", type: "openai", baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", hint: "very fast" },
  { id: "together", name: "Together AI", type: "openai", baseUrl: "https://api.together.xyz/v1", keyEnv: "TOGETHER_API_KEY", hint: "open models" },
  { id: "fireworks", name: "Fireworks", type: "openai", baseUrl: "https://api.fireworks.ai/inference/v1", keyEnv: "FIREWORKS_API_KEY", hint: "open models" },
  { id: "mistral", name: "Mistral", type: "openai", baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY", hint: "Mistral models" },
  { id: "cerebras", name: "Cerebras", type: "openai", baseUrl: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY", hint: "very fast" },
  { id: "xai", name: "xAI", type: "openai", baseUrl: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY", hint: "Grok" },
  { id: "gemini", name: "Google Gemini (OpenAI-compat)", type: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY", hint: "Gemini via compat API" },
  { id: "ollama", name: "Ollama (local)", type: "openai", baseUrl: "http://localhost:11434/v1", keyEnv: "", hint: "local, no key needed" },
  { id: "lmstudio", name: "LM Studio (local)", type: "openai", baseUrl: "http://localhost:1234/v1", keyEnv: "", hint: "local, no key needed" },
  { id: "wyvernhub", name: "WyvernHub Free (poolside)", type: "openai", baseUrl: "https://osaii.wyvernhub.net/api/v1", keyEnv: "", hint: "free, no API key — poolside models only", filter: (id) => id.startsWith("poolside/"), fallbackModels: ["poolside/laguna-xs-2.1", "poolside/laguna-s-2.1"] },
  { id: "custom", name: "Custom OpenAI-compatible", type: "openai", baseUrl: "", keyEnv: "", hint: "any /v1 endpoint" },
];
