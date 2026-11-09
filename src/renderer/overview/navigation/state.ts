import { StateEffect, StateField } from "@codemirror/state";

export interface NavigationOrigin {
  anchor: number;
  head: number;
}
export const pushNavigationOrigin = StateEffect.define<NavigationOrigin>();
export const popNavigationOrigin = StateEffect.define<null>();

// Stable across controllers/reconfiguration: only file-owned history is durable.
export const navigationHistory = StateField.define<readonly NavigationOrigin[]>(
  {
    create: () => [],
    update(value, transaction) {
      let history = transaction.docChanged
        ? value.map(({ anchor, head }) => ({
            anchor: transaction.changes.mapPos(anchor),
            head: transaction.changes.mapPos(head),
          }))
        : value;
      for (const effect of transaction.effects) {
        if (effect.is(pushNavigationOrigin))
          history = [...history.slice(-49), effect.value];
        if (effect.is(popNavigationOrigin)) history = history.slice(0, -1);
      }
      return history;
    },
  },
);
