import { useEffect, useState } from "react";

export function useTerminalSize(): { rows: number; cols: number } {
  const [size, setSize] = useState(() => ({
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  }));

  useEffect(() => {
    const onResize = () => {
      setSize({
        rows: process.stdout.rows ?? 24,
        cols: process.stdout.columns ?? 80,
      });
    };
    process.stdout.on("resize", onResize);
    return () => { process.stdout.off("resize", onResize); };
  }, []);

  return size;
}