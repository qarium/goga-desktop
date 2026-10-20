import type { BuildRepeatPreparation } from "../shared/build-repeat";

/** Never suggests that sensitive values were restored from persisted history. */
export function BuildRepeatNotice({
  preparation,
  missingEnvKeys,
  missingProxy,
  reviewed,
  onReview,
  ownerError,
}: {
  preparation: BuildRepeatPreparation;
  missingEnvKeys: string[];
  missingProxy: boolean;
  reviewed: boolean;
  onReview: (reviewed: boolean) => void;
  ownerError?: string;
}) {
  return (
    <section
      className="build-group build-group-body"
      aria-label="Подготовка повторной сборки"
    >
      <h3>Проверьте параметры повторной сборки</h3>
      {preparation.legacyIncomplete && (
        <p className="error" role="note">
          Для этого старого запуска сохранена только краткая сводка. Прежние
          переменные окружения, прокси, лимиты и остальные параметры неизвестны.
          Проверьте всю форму и заново укажите необходимые параметры: пустые
          поля не означают, что раньше они не использовались.
        </p>
      )}
      <p className="hint">
        Восстановлены только несекретные параметры и путь плана. Сборка ещё не
        запущена. Перед запуском заново проверяются текущая рабочая копия и
        версия плана.
      </p>
      {preparation.requiredEnvKeys.length > 0 && (
        <>
          <p>
            Значения всех переменных этого запуска не сохранялись. Введите их
            заново:
          </p>
          <ul>
            {preparation.requiredEnvKeys.map((key) => (
              <li key={key}>
                <code>{key}</code> —{" "}
                {missingEnvKeys.includes(key)
                  ? "нужно значение"
                  : "введено заново"}
              </li>
            ))}
          </ul>
        </>
      )}
      {preparation.requiresProxy && (
        <p>
          {missingProxy
            ? "Прокси не сохранён. Введите полный адрес заново, включая необходимые учётные данные."
            : "Прокси введён заново."}
        </p>
      )}
      {(missingEnvKeys.length > 0 || missingProxy) && (
        <p className="hint">
          Без перечисленных значений повтор недоступен. Удаление строки не
          отменяет это требование.
        </p>
      )}
      {ownerError && (
        <p className="error" role="alert">
          {ownerError}
        </p>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={reviewed}
          disabled={missingEnvKeys.length > 0 || missingProxy || !!ownerError}
          onChange={(event) => onReview(event.target.checked)}
        />
        Я проверил параметры повторной сборки и заново ввёл недостающие значения
      </label>
    </section>
  );
}
