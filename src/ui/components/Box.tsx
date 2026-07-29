import { Box as InkBox, Text } from "ink";
import React from "react";

interface BoxProps {
  title?: string;
  borderStyle?: "single" | "round" | "double" | "none";
  borderColor?: string;
  padding?: number;
  paddingX?: number;
  paddingY?: number;
  flex?: number;
  flexDirection?: "row" | "column";
  width?: string | number;
  height?: number;
  minWidth?: number;
  justifyContent?: "flex-start" | "center" | "flex-end" | "space-between";
  alignItems?: "flex-start" | "center" | "flex-end";
  marginTop?: number;
  marginBottom?: number;
  marginX?: number;
  marginY?: number;
  children?: React.ReactNode;
}

export function Box({
  title, borderStyle = "round", borderColor, padding, paddingX, paddingY,
  flex, flexDirection, width, height, minWidth, justifyContent, alignItems,
  marginTop, marginBottom, marginX, marginY, children,
}: BoxProps): React.ReactElement {
  const style: Record<string, any> = {};
  if (flex !== undefined) style.flex = flex;
  if (flexDirection) style.flexDirection = flexDirection;
  if (width !== undefined) style.width = width;
  if (height !== undefined) style.height = height;
  if (minWidth !== undefined) style.minWidth = minWidth;
  if (justifyContent) style.justifyContent = justifyContent;
  if (alignItems) style.alignItems = alignItems;
  if (marginTop !== undefined) style.marginTop = marginTop;
  if (marginBottom !== undefined) style.marginBottom = marginBottom;
  if (marginX !== undefined) style.marginX = marginX;
  if (marginY !== undefined) style.marginY = marginY;

  if (borderStyle === "none") {
    return (
      <InkBox {...style} paddingX={paddingX ?? padding ?? 0} paddingY={paddingY ?? padding ?? 0}>
        {children}
      </InkBox>
    );
  }

  return (
    <InkBox
      borderStyle={borderStyle}
      borderColor={borderColor}
      paddingX={paddingX ?? padding ?? 1}
      paddingY={paddingY ?? padding ?? 0}
      {...style}
    >
      {title ? (
        <InkBox flexDirection="column" width="100%">
          <Text bold color={borderColor}>{title}</Text>
          {children}
        </InkBox>
      ) : children}
    </InkBox>
  );
}