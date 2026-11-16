import { useCallback, useState } from "react";

// Hover and keyboard focus share a highlight, not a scroll intent. A fresh
// keyboard request must reveal the row even if hover already selected it or a
// wheel moved it out of view without changing the current index.
export function useOptionFocus(initialIndex = 0) {
  const [focus, setFocus] = useState({
    index: initialIndex,
    source: "keyboard" as "keyboard" | "pointer",
  });
  const setFocused = useCallback(
    (index: number, source: "keyboard" | "pointer" = "keyboard") =>
      setFocus((previous) =>
        source === "pointer" &&
        previous.index === index &&
        previous.source === source
          ? previous
          : { index, source },
      ),
    [],
  );
  return { focus, setFocused };
}
