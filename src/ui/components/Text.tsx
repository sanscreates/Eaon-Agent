import { Text as InkText } from "ink";
import React from "react";

type TextVariant = "primary" | "secondary" | "muted" | "accent" | "success" | "warning" | "error";

interface TextProps {
  variant?: TextVariant;
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
  italic?: boolean;
  wrap?: "wrap" | "truncate" | "truncate-end" | "truncate-middle";
  children?: React.ReactNode;
}

const variantColor: Record<TextVariant, string | undefined> = {
  primary: undefined,
  secondary: "gray",
  muted: "gray",
  accent: "#f4b942",
  success: "#86c06a",
  warning: "#f4b942",
  error: "#ef6b73",
};

export function Text({
  variant, color, bold, dimColor, italic, wrap, children,
}: TextProps): React.ReactElement {
  const resolvedColor = color ?? (variant ? variantColor[variant] : undefined);
  return (
    <InkText
      color={resolvedColor}
      bold={bold}
      dimColor={dimColor ?? (variant === "muted" || variant === "secondary")}
      italic={italic}
      wrap={wrap ?? "wrap"}
    >
      {children}
    </InkText>
  );
}