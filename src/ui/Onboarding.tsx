// Onboarding wizard — runs on first launch (and via `eaon setup`).
// Connect a provider, pick the main model (does the work) and the cheaper
// compressor model (summarizes old context), pick caveman level. Saved to
// ~/.eaon/config.json.

import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { loadConfig, saveConfig } from "../config.js";
import { backendFor, PROVIDER_PRESETS } from "../providers/registry.js";
import type { Theme } from "../themes.js";
import type { CavemanLevel, Provider } from "../types.js";
import { Select, Spinner, TextField } from "./components.js";

type Step = "welcome" | "preset" | "apikey" | "baseurl" | "fetch" | "manual-models" | "mainmodel" | "compmodel" | "caveman" | "done";

export function Onboarding(props: { onDone: () => void; theme?: Theme }): React.ReactElement {
  const accent = props.theme?.accent ?? "yellow";
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
        let list = (await backendFor(prov).listModels?.(prov)) ?? [];
        // Free-tier gateways expose more than they offer free — keep only the
        // models the preset allows (e.g. poolside on WyvernHub).
        if (preset.filter) list = list.filter(preset.filter);
        if (!list.length) throw new Error("empty list");
        setModels(list);
        setStep("mainmodel");
      } catch (e: any) {
        if (preset.fallbackModels?.length) {
          // No-key endpoints may not expose /models at all — ship the known list.
          setModels(preset.fallbackModels);
          setStep("mainmodel");
        } else {
          setError(e.message ?? String(e));
          setStep("manual-models");
        }
      }
    })();
  }, [step]);

  const finish = (compressorModel: string | undefined, caveman: CavemanLevel) => {
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
    // undefined = single-model mode: no separate compressor, main does it all.
    if (compressorModel) cfg.compressor = { provider: prov.id, model: compressorModel };
    else delete cfg.compressor;
    cfg.caveman = { enabled: caveman !== "off", level: caveman };
    saveConfig(cfg);
    setStep("done");
    setTimeout(props.onDone, 600);
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={props.theme?.border ?? accent} paddingX={2} paddingY={1} marginY={1}>
      <Text bold color={accent}>Eaon Agent — setup</Text>
      <Text dimColor>why use many tokens when few do the trick</Text>
      <Text> </Text>

      {step === "welcome" ? (
        <Box flexDirection="column">
          <Text>Models, one or two:</Text>
          <Text>  <Text bold>main</Text> — strong model, does the agentic work</Text>
          <Text>  <Text bold>compressor</Text> — optional cheap model, summarizes old context</Text>
          <Text> </Text>
          <Text>You bring your own API key(s) — or pick <Text bold>WyvernHub Free</Text> for a free, key-less setup (poolside models). Single-model mode works too: skip the compressor entirely.</Text>
          <Text>Press <Text bold>Enter</Text> to connect a provider.</Text>
        </Box>
      ) : null}

      {step === "preset" ? (
        <Box flexDirection="column">
          <Text bold>Pick a provider:</Text>
          <Select
            accent={accent}
            items={PROVIDER_PRESETS.map((p) => ({ label: p.name, value: p.id, hint: p.hint }))}
            onSelect={(id) => {
              const p = PROVIDER_PRESETS.find((x) => x.id === id)!;
              setPreset(p);
              setBaseUrl(p.baseUrl);
              const envKey = p.keyEnv ? process.env[p.keyEnv] : "";
              if (envKey) setApiKey(`\${${p.keyEnv}}`);
              // No key to ask for → straight to the base URL / model fetch.
              if (!p.keyEnv) setStep("baseurl");
              else setStep("apikey");
            }}
          />
        </Box>
      ) : null}

      {step === "apikey" ? (
        <Box flexDirection="column">
          <TextField
            accent={accent}
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
            accent={accent}
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

      {step === "fetch" ? <Spinner label={`fetching models from ${preset.name}…`} color={accent} /> : null}

      {step === "manual-models" ? (
        <Box flexDirection="column">
          <Text color={accent}>Could not fetch model list ({error}).</Text>
          <TextField
            accent={accent}
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
          <Select accent={accent} items={models.map((m) => ({ label: m, value: m }))} onSelect={(m) => { setMainModel(m); setStep("compmodel"); }} />
        </Box>
      ) : null}

      {step === "compmodel" ? (
        <Box flexDirection="column">
          <Text bold>Compressor model (only summarizes — pick the cheapest):</Text>
          <Select
            accent={accent}
            items={[
              { label: "same as main (single-model mode)", value: "same", hint: "one model does everything — no second API key needed" },
              ...models.map((m) => ({ label: m, value: m })),
            ]}
            onSelect={(m) => { setCompModel(m === "same" ? "" : m); setStep("caveman"); }}
          />
        </Box>
      ) : null}

      {step === "caveman" ? (
        <Box flexDirection="column">
          <Text bold>Caveman level (output compression, ~65% fewer output tokens):</Text>
          <Select
            accent={accent}
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

      {step === "done" ? <Text color={accent}>✔ Saved to ~/.eaon/config.json — starting…</Text> : null}
    </Box>
  );
}
