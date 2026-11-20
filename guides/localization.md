# Interface languages

English is the default, independently of the system language. **Settings → General → Language** changes a Desktop-wide preference, not the Goga configuration or an environment variable. Language packs ship in the app and are available offline. System-owned controls may still follow macOS. Terminal output, AFM pages, identifiers and user-written text stay as written.

## Add a language

1. Copy the [English pack](../locales/en) into a sibling directory named with a canonical BCP 47 language tag. Update its manifest's `tag` and native `name`. English is the reference for required domains and keys; Russian is a complete supported pack too.
2. Translate the values, not the keys. Use whole sentences with named parameters such as `{name}`. Preserve parameter names and placeholders without translating them. Use locale-specific i18next plural suffixes (`_one`, `_few`, `_many`, `_other`, as appropriate); supply a numeric `count`. The generator checks keys, parameters, nonempty values and the target language's plural categories. Do not include markup, user data or local paths in a translation.
3. Run `npm run locales:generate`, then `npm run locales:check`, `npm run typecheck`, and the language tests. Commit the packs **and** the generated registry together. No new settings option or switch statement is required. To change the README recording, see the [tour guide](readme-tour.md); recordings are not required for the language picker.
4. Verify the packaged interface offline: settings, narrow toolbars, errors, keyboard and screen reader labels, terminal chrome, and a language switch while editing. Language changes must not remount the shell, save a draft or start an operation.

## Use a message

Keep Desktop text in the appropriate domain. In React subscribe with `useLocale()` and call `t("domain.key", {name})` when rendering. In the main process and other surfaces, format at display time. A module-level translated string captures whichever locale happened to be active at import time: keep keys instead. Never use translated messages or user-visible labels as state, identifiers, permission checks or persistence keys. Preserve legacy user data and externally produced output without attempting to translate it.

Use **Pipeline**, **Workflow**, **Run**, **Stage**, **Build**, **Topic** and **Working copy** consistently. The Project tab for `.goga/usages` is **Usages**. The operation that runs `goga topics propagate` is **Propagate to base and publish**, distinct from publishing a topic branch. Confirm ambiguous new domain terms with the product owner before freezing their labels.
