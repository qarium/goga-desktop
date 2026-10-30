# YAML highlighting correction

`lezer-yaml-1.0.4.patch` fixes the ready-made @lezer/yaml parser used by
@codemirror/lang-yaml. In block context, a leading `-` or `?` is an indicator
only when followed by a YAML separator. Otherwise it must take the existing
plain-key detection branch. The previous dispatch skipped it, rejected valid
`->Type:` keys and desynchronized the following quoted signature.

Only those two dispatch conditions change, in both ESM and CommonJS exports.
No source rewriting, regex signature parsing, schema interpretation, new YAML
engine or synchronous whole-document CST pass is introduced. The original
incremental parser, highlighting tags, license and other behavior are kept.

Upstream source: https://github.com/lezer-parser/yaml/blob/main/src/tokens.js
Upstream version:1.0.4 (MIT; Marijn Haverbeke and contributors).

`npm ci` applies this patch through `postinstall` using the standard macOS/Linux
`/usr/bin/patch` tool. Version and before/after SHA256 are checked, and a failed
or partial application fails the install, rather than silently using a broken
or unknown parser. Repeated application is a no-op. No network is needed.

When upgrading @lezer/yaml, first verify the indicator-key regressions. Remove
this patch and its install hook when the upstream correction is available;
otherwise review the new source and regenerate the patch/hashes explicitly.
