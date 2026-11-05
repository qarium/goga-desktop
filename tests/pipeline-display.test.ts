import { expect, it } from "vitest";
import {
  pipelineDisplayMetadata,
  PIPELINE_DISPLAY_LIMITS,
} from "../src/shared/pipeline-display";
it("keeps catalog labels as literal presentation text, not command syntax", () => {
  expect(
    pipelineDisplayMetadata({
      pipelineName: "Редактор $(not-command)",
      pipelineDescription: "Описание\nUTF-8 🧪",
    }),
  ).toEqual({
    pipelineName: "Редактор $(not-command)",
    pipelineDescription: "Описание\nUTF-8 🧪",
  });
});
it("omits absent or malformed optional display metadata without making execution depend on it", () => {
  expect(pipelineDisplayMetadata({})).toEqual({});
  expect(
    pipelineDisplayMetadata({ pipelineName: {}, pipelineDescription: 42 }),
  ).toEqual({});
});
it("normalizes NUL and bounds optional labels to the existing run journal limits", () => {
  const result = pipelineDisplayMetadata({
    pipelineName: "\0" + "n".repeat(1025),
    pipelineDescription: "\0" + "d".repeat(16001),
  });
  expect(result.pipelineName).toBe("n".repeat(PIPELINE_DISPLAY_LIMITS.name));
  expect(result.pipelineDescription).toBe(
    "d".repeat(PIPELINE_DISPLAY_LIMITS.description),
  );
});
