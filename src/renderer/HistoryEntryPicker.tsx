import { SearchablePicker } from "./SearchablePicker";
export function HistoryEntryPicker(props: {
  entries: string[];
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  return (
    <SearchablePicker
      {...props}
      className="history-entry-picker"
      label="Запись истории"
      placeholder="Выберите запись"
      emptyLabel="Нет записей"
      searchLabel="Найти запись истории"
      searchPlaceholder="Название записи"
      listLabel="Записи истории"
    />
  );
}
