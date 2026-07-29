#!/usr/bin/env node
// Eaon Agent CLI entry.

import { Command } from "commander";
import React from "react";
import { CONFIG_PATH } from "./config.js";
import { runHeadless } from "./headless.js";

const program = new Command();

program
  .name("eaon-agent")
  .description("Eaon Agent — token-efficient terminal AI coding agent")
  .version("1.3.0");

program
  .command("chat", { isDefault: true })
  .description("Start the interactive TUI (default)")
  .option("-p, --print <prompt>", "headless: run a single prompt and print the result")
  .option("-y, --yes", "auto-approve all permission prompts (headless)")
  .option("-m, --model <query>", "override main model for this run")
  .option("--max-turns <n>", "max agent turns", parseInt)
  .option("--stats", "print token stats at the end (headless)")
  .action(async (opts) => {
    if (opts.print) {
      const code = await runHeadless({
        prompt: opts.print,
        yes: opts.yes,
        modelQuery: opts.model,
        maxTurns: opts.maxTurns,
        showStats: opts.stats ?? true,
      });
      process.exit(code);
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error('Interactive mode needs a real terminal. Headless usage: eaon-agent -p "your prompt" [--yes] [--stats]');
      process.exit(1);
    }
    const { Runtime } = await import("./core/runtime.js");
    const { render } = await import("ink");
    const { App } = await import("./ui/App.js");
    const rt = new Runtime();
    render(React.createElement(App, { rt }), { exitOnCtrlC: false });
  });

program
  .command("setup")
  .description("Connect providers and pick models (onboarding)")
  .action(async () => {
    const { Runtime } = await import("./core/runtime.js");
    const { render } = await import("ink");
    const { App } = await import("./ui/App.js");
    const rt = new Runtime();
    render(React.createElement(App, { rt, forceSetup: true }), { exitOnCtrlC: false });
  });

program
  .command("config")
  .description("Print config file path")
  .action(() => {
    console.log(CONFIG_PATH);
  });

program.parse();
