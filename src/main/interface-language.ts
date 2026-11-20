import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSupportedLocale, t } from "../shared/i18n";

/** Read before creating any window; never consult a project folder, personal YAML or the OS language. */
export class DesktopLanguagePreference {
  constructor(private readonly profile: string) {}
  read(): string {
    let fd: number | undefined;
    try {
      fd = openSync(join(this.profile, "interface-language.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 512) return "en";
      const data = Buffer.alloc(513);
      const length = readSync(fd, data, 0, data.length, 0);
      if (length > 512) return "en";
      const { language } = JSON.parse(data.toString("utf8", 0, length));
      return typeof language === "string" && isSupportedLocale(language) ? language : "en";
    } catch { return "en"; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  write(language: unknown): string {
    if (typeof language !== "string" || !isSupportedLocale(language)) throw Error(t("native.unsupportedLanguage"));
    const temp = join(this.profile, ".language-" + randomUUID());
    try {
      mkdirSync(this.profile, { mode: 0o700, recursive: true });
      writeFileSync(temp, JSON.stringify({ language }) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(temp, join(this.profile, "interface-language.json"));
    } catch {
      try { unlinkSync(temp); } catch {}
      throw Error(t("native.languageNotSaved"));
    }
    return language;
  }
}
