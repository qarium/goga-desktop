/** UI deadline does not cancel a metadata write; an explicit retry reconciles. */
export const TOPIC_CONTEXT_PREPARE_TIMEOUT_MS = 300000;
export const LINKED_CONTEXT_EXECUTION_BLOCKER =
  "Запуск в отдельной рабочей копии пока недоступен: установленная Goga не передаёт в контейнер необходимые Git-данные. Контекстный запуск безопасно заблокирован.";
export const CONTEXT_INTEGRATION_BLOCKER =
  "Контекстная привязка процессов ещё не включена в этом промежуточном пакете. Прежние запуски доступны в основной папке проекта.";
