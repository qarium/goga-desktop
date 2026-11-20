import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";
import { initializeInterfaceLanguage } from "./useLocale";
void initializeInterfaceLanguage(window.goga).then(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});
