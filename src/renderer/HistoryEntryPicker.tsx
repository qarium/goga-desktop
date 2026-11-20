import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { SearchablePicker } from "./SearchablePicker";
export function HistoryEntryPicker(props: {
  entries: string[];
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  useLocale();
  return (
    <SearchablePicker
      {...props}
      className="history-entry-picker"
      label={msg("project.historyEntry")}
      placeholder={msg("project.selectAnEntry")}
      emptyLabel={msg("project.noEntries")}
      searchLabel={msg("project.findHistoryEntry")}
      searchPlaceholder={msg("project.entryName")}
      listLabel={msg("project.historyEntries")}
    />
  );
}
