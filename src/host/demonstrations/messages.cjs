"use strict";
// These transport modules also run standalone in Node. Desktop injects its
// formatter, not a renderer or project capability; standalone callers use English.
const english = require("../../../locales/en/hostTerminal.json");
let format = key => english[key.slice("hostTerminal.".length)] ?? key;
exports.install = formatter => { format = formatter; };
const domain = "hostTerminal.";
exports.text = key => format(typeof key === "string" && key.startsWith(domain) && Object.hasOwn(english, key.slice(domain.length))
  ? key : "hostTerminal.commandUnavailable");
exports.helperError = value => {
  if (typeof value !== "string" || !value.startsWith("GOGA_DEMO_HELPER:")) return value;
  const key = value.slice("GOGA_DEMO_HELPER:".length);
  return Object.hasOwn(english, key) ? format("hostTerminal." + key) : format("hostTerminal.commandUnavailable");
};
