import { initializeAFM } from "./afm-preferences";
// Only main supplies this argument. Never expose process, require or IPC to AFM.
const prefix = "--goga-afm-origin=";
const origin =
  process.argv
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length) ?? "";
initializeAFM(window, origin, process.isMainFrame);
