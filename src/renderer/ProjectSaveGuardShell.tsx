import { Component, createRef, type ReactNode } from "react";

type Props = {
  projectSaveOnly: boolean;
  className: string;
  children: ReactNode;
};
const guard = "data-project-save-guard";

/** Keep the native interlock, but don't dim the whole workspace for a local save.
 * Snapshot before React applies disabled; never brighten already unavailable actions. */
export class ProjectSaveGuardShell extends Component<Props> {
  private readonly shell = createRef<HTMLDivElement>();
  private readonly preserved = new Set<HTMLButtonElement>();

  getSnapshotBeforeUpdate(previous: Props): HTMLButtonElement[] | null {
    if (
      previous.projectSaveOnly ||
      !this.props.projectSaveOnly ||
      !this.shell.current
    )
      return null;
    return Array.from(
      this.shell.current.querySelectorAll<HTMLButtonElement>("button:enabled"),
    ).filter((button) => !button.closest("[hidden], [inert]"));
  }

  componentDidUpdate(
    _previous: Props,
    _state: unknown,
    before: HTMLButtonElement[] | null,
  ) {
    if (!this.props.projectSaveOnly) return this.clear();
    if (!before) return;
    for (const button of before) {
      if (!button.matches(":disabled") || !this.shell.current?.contains(button))
        continue;
      button.setAttribute(guard, "");
      this.preserved.add(button);
    }
  }

  private clear() {
    for (const button of this.preserved) button.removeAttribute(guard);
    this.preserved.clear();
  }

  componentWillUnmount() {
    this.clear();
  }

  render() {
    return (
      <div ref={this.shell} className={this.props.className}>
        {this.props.children}
      </div>
    );
  }
}
