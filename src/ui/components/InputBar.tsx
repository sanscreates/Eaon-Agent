import { Box, Text } from "ink";
import React, { useState } from "react";
import { Autocomplete } from "./Autocomplete.js";

interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  history: string[];
  accent?: string;
  placeholder?: string;
  cavemanLevel?: string;
  isFocused: boolean;
}

export function InputBar({
  value, onChange, onSubmit, disabled, history,
  placeholder, cavemanLevel, isFocused,
}: InputBarProps): React.ReactElement {
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompletePrefix, setAutocompletePrefix] = useState("");

  const borderColor = isFocused ? "#f4b942" : (disabled ? "gray" : "gray");

  const handleInput = (input: string) => {
    onChange(input);
    const lastWord = input.split(/[\s\n]/).pop() ?? "";
    if (lastWord.startsWith("@") || lastWord.startsWith("/")) {
      setAutocompletePrefix(lastWord);
      setShowAutocomplete(true);
    } else {
      setShowAutocomplete(false);
    }
  };

  const handleAutocompleteSelect = (selected: string) => {
    const parts = value.split(/[\s\n]/);
    parts[parts.length - 1] = selected;
    onChange(parts.join(" "));
    setShowAutocomplete(false);
  };

  const display = value || placeholder || "";
  const tokenEst = Math.max(1, Math.ceil(value.length / 4));

  return (
    <Box flexDirection="column" width="100%">
      {showAutocomplete && isFocused ? (
        <Autocomplete
          prefix={autocompletePrefix}
          onSelect={handleAutocompleteSelect}
          onClose={() => setShowAutocomplete(false)}
        />
      ) : null}

      <Box
        borderStyle="round"
        borderColor={borderColor}
        paddingX={1}
        width="100%"
      >
        {cavemanLevel && cavemanLevel !== "off" ? (
          <Box marginRight={1}>
            <Text color="#f4b942" bold dimColor={disabled}>[{cavemanLevel}]</Text>
          </Box>
        ) : null}
        <Text bold color={isFocused ? "#f4b942" : "gray"} dimColor={disabled}>❯</Text>
        <Text wrap="wrap" dimColor={!value && !disabled}>{display}</Text>
        {isFocused && !disabled ? <Text color="#f4b942">▌</Text> : null}
        <Box marginLeft={1}>
          <Text dimColor>{tokenEst}</Text>
        </Box>
      </Box>
    </Box>
  );
}