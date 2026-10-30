/** Exit confirmation holds metadata only: never file content or recovery copies. */
export class OverviewExitGuard {
  private paths: string[] = [];
  private busy = false;
  private revision = 0;
  private approved = -1;
  constructor(private confirm: (paths: string[]) => Promise<boolean>) {}
  update(paths: string[], busy: boolean) {
    const next = [...new Set(paths)].sort();
    if (
      JSON.stringify(next) !== JSON.stringify(this.paths) ||
      busy !== this.busy
    ) {
      this.paths = next;
      this.busy = busy;
      this.revision++;
    }
  }
  async beforeClose() {
    if (this.busy) return false;
    const issued = this.revision;
    if (this.paths.length && !(await this.confirm([...this.paths])))
      return false;
    if (this.busy || issued !== this.revision) return false;
    this.approved = issued;
    return true;
  }
  validate() {
    if (this.busy || this.approved !== this.revision)
      throw Error(
        "Файлы обзора изменились перед выходом. Сохраните их или подтвердите выход заново.",
      );
  }
}
