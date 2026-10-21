import { z } from "zod";

export const TOPIC_POPUP_FRAME_PREFIX = "goga-topic-picker:";
export const topicPopupIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const coordinate = z.number().int().min(0).max(100_000);
export const topicPopupBoundsSchema = z
  .object({
    x: coordinate,
    y: coordinate,
    width: coordinate.min(1),
    height: coordinate.min(1),
  })
  .strict();
export type TopicPopupBounds = z.infer<typeof topicPopupBoundsSchema>;
