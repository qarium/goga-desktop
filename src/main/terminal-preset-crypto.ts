import type { SafeStorage } from "electron";
import type { TerminalPresetCrypto } from "../host/terminal-preset-store";
/** No keychain access at construction or catalog navigation; no fallback provider. */
export function createTerminalPresetCrypto(
  native: Pick<
    SafeStorage,
    "encryptString" | "decryptString" | "isEncryptionAvailable"
  >,
  platform: NodeJS.Platform = process.platform,
): TerminalPresetCrypto {
  function requireProtection() {
    let ready = false;
    try {
      ready = platform === "darwin" && native.isEncryptionAvailable();
    } catch {
      /* Do not leak platform error details. */
    }
    if (!ready)
      throw Error(
        "Защита пресетов недоступна. Проверьте доступ к связке ключей macOS.",
      );
  }
  return {
    seal(plain) {
      requireProtection();
      try {
        const result = native.encryptString(plain);
        if (!Buffer.isBuffer(result) || !result.length) throw Error();
        return result.toString("base64");
      } catch {
        throw Error(
          "Не удалось зашифровать данные пресета. Исходные данные не сохранены.",
        );
      }
    },
    open(sealed) {
      const data = Buffer.from(sealed, "base64");
      if (!data.length || data.toString("base64") !== sealed)
        throw Error("Защищённые данные терминала повреждены.");
      requireProtection();
      try {
        return native.decryptString(data);
      } catch {
        throw Error(
          "Не удалось расшифровать данные терминала. Проверьте связку ключей macOS.",
        );
      }
    },
  };
}
