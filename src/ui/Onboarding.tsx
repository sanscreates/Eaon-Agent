// Onboarding wizard — runs on first launch (and via `eaon setup`).
// Connect a provider, pick the main model (does the work) and the cheaper
// compressor model (summarizes old context), pick caveman level. Saved to
// ~/.eaon/config.json.

import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { loadConfig, saveConfig } from "../config.js";
import { backendFor, PROVIDER_PRESETS } from "../providers/registry.js";
import type { CavemanLevel, Provider } from "../types.js";
import { Select, Spinner, TextField } from "./components.js";

type Step = "welcome" | "preset" | "apikey" | "baseurl" | "fetch" | "manual-models" | "mainmodel" | "compmodel" | "caveman" | "done";

export function Onboarding(props: { onDone: () => void }): React.ReactElement {
  const [step, setStep] = useState<Step>("welcome");
  const [preset, setPreset] = useState(PROVIDER_PRESETS[0]);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [mainModel, setMainModel] = useState("");
  const [compModel, setCompModel] = useState("");
  const [error, setError] = useState("");

  useInput(
    (_input, key) => {
      if (step === "welcome" && key.return) setStep("preset");
    },
    { isActive: step === "welcome" },
  );

  useEffect(() => {
    if (step !== "fetch") return;
    (async () => {
      const prov: Provider = { id: preset.id, name: preset.name, type: preset.type, baseUrl: baseUrl || preset.baseUrl, apiKey, models: [] };
      try {
        const list = (await backendFor(prov).listModels?.(prov)) ?? [];
        if (!list.length) throw new Error("empty list");
        setModels(list);
        setStep("mainmodel");
      } catch (e: any) {
        setError(e.message ?? String(e));
        setStep("manual-models");
      }
    })();
  }, [step]);

  const finish = (compressorModel: string, caveman: CavemanLevel) => {
    const cfg = loadConfig();
    const prov: Provider = {
      id: preset.id,
      name: preset.name,
      type: preset.type,
      baseUrl: baseUrl || preset.baseUrl || undefined,
      apiKey: apiKey || undefined,
      models,
    };
    cfg.providers = [...cfg.providers.filter((p) => p.id !== prov.id), prov];
    cfg.main = { provider: prov.id, model: mainModel };
    cfg.compressor = { provider: prov.id, model: compressorModel };
    cfg.caveman = { enabled: caveman !== "off", level: caveman };
    saveConfig(cfg);
    setStep("done");
    setTimeout(props.onDone, 600);
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1} marginY={1}>
      <Text bold color="yellow">Eaon Agent — setup</Text>
      <Text dimColor>why use many tokens when few do the trick</Text>
      <Text> </Text>

      {step === "welcome" ? (
        <Box flexDirection="column">
          <Text>Two models, one agent:</Text>
          <Text>  <Text bold>main</Text> — strong model, does the agentic work</Text>
          <Text>  <Text bold>compressor</Text> — cheap model, summarizes old context so main stays lean</Text>
          <Text> </Text>
          <Text>You bring your own API key(s). Press <Text bold>Enter</Text> to connect a provider.</Text>
        </Box>
      ) : null}

      {step === "preset" ? (
        <Box flexDirection="column">
          <Text bold>Pick a provider:</Text>
          <Select
            items={PROVIDER_PRESETS.map((p) => ({ label: p.name, value: p.id, hint: p.hint }))}
            onSelect={(id) => {
              const p = PROVIDER_PRESETS.find((x) => x.id === id)!;
              setPreset(p);
              setBaseUrl(p.baseUrl);
              const envKey = p.keyEnv ? process.env[p.keyEnv] : "";
              if (envKey) setApiKey(`\${${p.keyEnv}}`);
              if (p.id === "ollama" || p.id === "lmstudio") setStep("baseurl");
              else setStep("apikey");
            }}
          />
        </Box>
      ) : null}

      {step === "apikey" ? (
        <Box flexDirection="column">
          <TextField
            label={`API key for ${preset.name}${preset.keyEnv ? ` (blank = use env ${preset.keyEnv})` : ""}`}
            mask
            allowEmpty={!!preset.keyEnv}
            onSubmit={(v) => {
              setApiKey(v || (preset.keyEnv ? `\${${preset.keyEnv}}` : ""));
              setStep("baseurl");
            }}
          />
        </Box>
      ) : null}

      {step === "baseurl" ? (
        <Box flexDirection="column">
          <TextField
            label="Base URL"
            defaultValue={baseUrl || preset.baseUrl}
            allowEmpty={preset.type === "anthropic"}
            onSubmit={(v) => {
              setBaseUrl(v);
              setStep("fetch");
            }}
          />
        </Box>
      ) : null}

      {step === "fetch" ? <Spinner label={`fetching models from ${preset.name}…`} /> : null}

      {step === "manual-models" ? (
        <Box flexDirection="column">
          <Text color="yellow">Could not fetch model list ({error}).</Text>
          <TextField
            label="Models, comma-separated"
            onSubmit={(v) => {
              setModels(v.split(",").map((s) => s.trim()).filter(Boolean));
              setStep("mainmodel");
            }}
          />
        </Box>
      ) : null}

      {step === "mainmodel" ? (
        <Box flexDirection="column">
          <Text bold>Main model (does the work):</Text>
          <Select items={models.map((m) => ({ label: m, value: m }))} onSelect={(m) => { setMainModel(m); setStep("compmodel"); }} />
        </Box>
      ) : null}

      {step === "compmodel" ? (
        <Box flexDirection="column">
          <Text bold>Compressor model (pick the cheapest — it only summarizes):</Text>
          <Select
            items={models.map((m) => ({ label: m, value: m }))}
            onSelect={(m) => { setCompModel(m); setStep("caveman"); }}
          />
        </Box>
      ) : null}

      {step === "caveman" ? (
        <Box flexDirection="column">
          <Text bold>Caveman level (output compression, ~65% fewer output tokens):</Text>
          <Select
            items={[
              { label: "full", value: "full", hint: "default — short fragments" },
              { label: "lite", value: "lite", hint: "normal sentences, no filler" },
              { label: "ultra", value: "ultra", hint: "maximum compression" },
              { label: "wenyan", value: "wenyan", hint: "classical Chinese — densest" },
              { label: "off", value: "off", hint: "normal verbose mode" },
            ]}
            onSelect={(v) => finish(compModel, v as CavemanLevel)}
          />
        </Box>
      ) : null}

      {step === "done" ? <Text color="yellow">✔ Saved to ~/.eaon/config.json — starting…</Text> : null}
    </Box>
  );
}
