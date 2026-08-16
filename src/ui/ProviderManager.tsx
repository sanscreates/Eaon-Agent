// Interactive provider & model manager — opened with /provider from the TUI.
// Edit provider details (name, base URL, API key), add/remove/rename models
// and delete providers. The shared helpers in config.ts keep the
// main/compressor references consistent; this component just mutates the live
// config, saves it and bumps a re-render counter.

import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import {
  addProviderModel,
  refChangesText,
  removeProvider,
  removeProviderModel,
  renameProviderModel,
  saveConfig,
  updateProvider,
} from "../config.js";
import type { Runtime } from "../core/runtime.js";
import type { Theme } from "../themes.js";
import { Select, TextField } from "./components.js";
import { isMouseInput } from "./mouse.js";

type Mode =
  | "list"
  | "menu"
  | "name"
  | "key"
  | "url"
  | "models"
  | "modelMenu"
  | "addModel"
  | "renameModel"
  | "confirm";

const ADD_MODEL = "__add__";

export function ProviderManager(props: {
  rt: Runtime;
  theme: Theme;
  onDone: () => void;
  onChanged: () => void;
}): React.ReactElement {
  const accent = props.theme.accent;
  const errorColor = props.theme.error;
  const cfg = props.rt.cfg;
  const [mode, setMode] = useState<Mode>("list");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [status, setStatus] = useState("");
  const [, setVersion] = useState(0);
  // cfg is mutated in place — every change needs an explicit re-render
  const refresh = () => setVersion((v) => v + 1);

  const provider = cfg.providers.find((p) => p.id === providerId);
  const holdsMain = !!provider && cfg.main?.provider === provider.id;
  const holdsCompressor = !!provider && cfg.compressor?.provider === provider.id;

  const commit = (message: string) => {
    try {
      saveConfig(cfg);
    } catch {
      message += " (warning: could not write config file)";
    }
    props.onChanged();
    refresh();
    setStatus(message);
  };

  // Escape walks one level up; Select/TextField own every other key.
  useInput((input, key) => {
    if (isMouseInput(input)) return;
    if (key.escape) {
      if (mode === "list") props.onDone();
      else if (mode === "menu" || mode === "confirm") setMode("list");
      else if (mode === "modelMenu") setMode("models");
      else if (mode === "models") setMode("menu");
      else if (mode === "name" || mode === "key" || mode === "url") setMode("menu");
      else if (mode === "addModel" || mode === "renameModel") setMode("models");
    }
  });

  const backToList = () => {
    setProviderId("");
    setMode("list");
  };

  return (
    <Box flexDirection="column" overflow="hidden" paddingX={1} flexGrow={1}>
      <Text bold color={accent}>
        Providers &amp; models {mode === "list" ? "" : `— ${providerId || ""}${model && (mode === "modelMenu" || mode === "addModel" || mode === "renameModel") ? ` / ${model}` : ""}`}
      </Text>
      <Text dimColor>edit and delete providers and models · Esc back · changes save to ~/.eaon/config.json</Text>
      <Text> </Text>

      {mode === "list" ? (
        <Box flexDirection="column">
          <Select
            accent={accent}
            limit={8}
            items={cfg.providers.map((p) => {
              const roles = [cfg.main?.provider === p.id ? "main" : "", cfg.compressor?.provider === p.id ? "compressor" : ""].filter(Boolean).join("/");
              return {
                label: `${p.id} — ${p.name}`,
                value: p.id,
                hint: `${p.models.length} model(s)${roles ? ` · ${roles}` : ""}`,
              };
            })}
            onSelect={(id) => {
              if (!id) return;
              setProviderId(id);
              setStatus("");
              setMode("menu");
            }}
          />
          <Text> </Text>
          <Text dimColor>add providers with /setup · delete/edit with the menu above</Text>
        </Box>
      ) : null}

      {mode === "menu" && provider ? (
        <Box flexDirection="column">
          <Text>
            <Text bold>{provider.id}</Text>
            <Text dimColor> · {provider.type}{provider.baseUrl ? ` · ${provider.baseUrl}` : ""} · {provider.models.length} model(s){holdsMain ? " · holds main" : ""}{holdsCompressor ? " · holds compressor" : ""}</Text>
          </Text>
          <Text> </Text>
          <Select
            accent={accent}
            items={[
              { label: "Edit display name", value: "name" },
              { label: `API key (${provider.apiKey ? "set — edit or clear" : "not set"})`, value: "key" },
              { label: `Base URL (${provider.baseUrl ? "edit or clear" : "not set"})`, value: "url" },
              { label: "Models — add / remove / rename", value: "models" },
              { label: "Delete provider", value: "delete", hint: "removes it and its models" },
              { label: "Back", value: "back" },
            ]}
            onSelect={(v) => {
              setStatus("");
              if (v === "back") backToList();
              else if (v === "delete") setMode("confirm");
              else setMode(v as Mode);
            }}
          />
        </Box>
      ) : null}

      {mode === "name" && provider ? (
        <TextField
          accent={accent}
          label={`Display name for ${provider.id}`}
          defaultValue={provider.name}
          onSubmit={(v) => {
            updateProvider(cfg, provider.id, { name: v });
            commit(`Name updated → ${v}`);
            setMode("menu");
          }}
        />
      ) : null}

      {mode === "key" && provider ? (
        <Box flexDirection="column">
          <TextField
            accent={accent}
            label={`API key for ${provider.id} (empty clears · \${ENV_VAR} allowed)`}
            defaultValue={provider.apiKey ?? ""}
            mask
            allowEmpty
            onSubmit={(v) => {
              updateProvider(cfg, provider.id, { apiKey: v });
              commit(v ? "API key updated." : "API key cleared.");
              setMode("menu");
            }}
          />
        </Box>
      ) : null}

      {mode === "url" && provider ? (
        <TextField
          accent={accent}
          label={`Base URL for ${provider.id} (empty = none)`}
          defaultValue={provider.baseUrl ?? ""}
          allowEmpty
          onSubmit={(v) => {
            updateProvider(cfg, provider.id, { baseUrl: v });
            commit(`Base URL ${v ? `→ ${v}` : "cleared"}.`);
            setMode("menu");
          }}
        />
      ) : null}

      {mode === "models" && provider ? (
        <Box flexDirection="column">
          <Select
            accent={accent}
            limit={8}
            items={[
              { label: "+ Add a model", value: ADD_MODEL, hint: "type the model id" },
              ...provider.models.map((m) => {
                const isMain = cfg.main?.provider === provider.id && cfg.main?.model === m;
                const isComp = cfg.compressor?.provider === provider.id && cfg.compressor?.model === m;
                return { label: m, value: m, hint: isMain ? "main" : isComp ? "compressor" : undefined };
              }),
              { label: "Back", value: "__back__" },
            ]}
            onSelect={(v) => {
              setStatus("");
              if (v === ADD_MODEL) setMode("addModel");
              else if (v === "__back__") setMode("menu");
              else {
                setModel(v);
                setMode("modelMenu");
              }
            }}
          />
        </Box>
      ) : null}

      {mode === "modelMenu" && provider ? (
        <Box flexDirection="column">
          <Text>
            <Text bold>{provider.id}/{model}</Text>
            <Text dimColor>{cfg.main?.provider === provider.id && cfg.main?.model === model ? " (main)" : cfg.compressor?.provider === provider.id && cfg.compressor?.model === model ? " (compressor)" : ""}</Text>
          </Text>
          <Text> </Text>
          <Select
            accent={accent}
            items={[
              { label: "Rename", value: "rename" },
              { label: "Delete", value: "delete", hint: "removes the model" },
              { label: "Back", value: "back" },
            ]}
            onSelect={(v) => {
              if (v === "back") setMode("models");
              else if (v === "rename") setMode("renameModel");
              else {
                const res = removeProviderModel(cfg, provider.id, model);
                const extra = refChangesText(res);
                commit(`Model ${model} deleted.${extra ? ` ${extra}` : ""}`);
                setModel("");
                setMode("models");
              }
            }}
          />
        </Box>
      ) : null}

      {mode === "addModel" && provider ? (
        <TextField
          accent={accent}
          label={`Model id to add to ${provider.id} (e.g. ${provider.models[0] ?? "provider/model"})`}
          onSubmit={(v) => {
            if (!addProviderModel(cfg, provider.id, v)) {
              setStatus(`'${v}' is already on ${provider.id}.`);
              refresh();
              return;
            }
            commit(`Model ${v} added to ${provider.id}. Switch with /model ${provider.id}/${v}`);
            setMode("models");
          }}
        />
      ) : null}

      {mode === "renameModel" && provider ? (
        <TextField
          accent={accent}
          label={`Rename ${model} to`}
          defaultValue={model}
          onSubmit={(v) => {
            if (!renameProviderModel(cfg, provider.id, model, v)) {
              setStatus(`Cannot rename to '${v}' — missing or duplicate.`);
              refresh();
              return;
            }
            commit(`Model ${model} → ${v}.`);
            setModel(v);
            setMode("models");
          }}
        />
      ) : null}

      {mode === "confirm" && provider ? (
        <Box flexDirection="column">
          <Text color={errorColor}>Delete provider '{provider.id}' ({provider.models.length} model(s))?</Text>
          {holdsMain ? <Text color={errorColor}>It holds the main model — Eaon will switch to another model or unset main.</Text> : null}
          {holdsCompressor ? <Text color={errorColor}>It holds the compressor — compression falls back to the main model.</Text> : null}
          <Text> </Text>
          <Select
            accent={accent}
            items={[
              { label: "No — keep it", value: "no" },
              { label: "Yes — delete", value: "yes" },
            ]}
            onSelect={(v) => {
              if (v !== "yes") {
                setMode("menu");
                return;
              }
              const res = removeProvider(cfg, provider.id);
              const extra = refChangesText(res);
              commit(`Provider ${provider.id} deleted.${extra ? ` ${extra}` : ""}`);
              backToList();
            }}
          />
        </Box>
      ) : null}

      {!cfg.providers.length && mode === "list" ? <Text dimColor>No providers configured — run /setup first.</Text> : null}

      <Text> </Text>
      {status ? <Text color={accent}>  {status}</Text> : null}
    </Box>
  );
}
