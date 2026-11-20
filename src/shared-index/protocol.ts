import * as z from "zod";
import type { SearchResult } from "../types.ts";

const pathSegment = /^[\w.-]+$/;
export const repositoryId = z
  .string()
  .max(180)
  .refine((value) =>
    value.split("/").every((part) => pathSegment.test(part) && part !== "." && part !== ".."),
  );
const filePath = z
  .string()
  .max(512)
  .refine((value) =>
    value
      .split("/")
      .every(
        (part) => part.length > 0 && part !== "." && part !== ".." && !/[\\\0\r\n]/.test(part),
      ),
  );
const revision = z.string().min(1).max(128);

export const identitySchema = z.strictObject({
  tenant: z.string().min(1).max(128),
  principal: z.string().min(1).max(200),
});

export const revisionSchema = z.strictObject({ repository: repositoryId, path: filePath });

export const changeSchema = revisionSchema.extend({
  previousRevision: revision.nullable(),
  revision,
  content: z
    .string()
    .max(128_000)
    .refine((value) => !value.includes("\0"))
    .nullable(),
});

export const querySchema = z.strictObject({
  query: z.string().trim().min(1).max(2_000),
  repositories: z.array(repositoryId).min(1).max(16),
  limit: z.number().int().min(1).max(10).default(5),
});

export type Identity = z.infer<typeof identitySchema>;
export type FileChange = z.infer<typeof changeSchema>;
export type SharedQuery = z.input<typeof querySchema>;
export type SharedResult = SearchResult & { repository: string };
export interface FileUpdate {
  state: "updated" | "unchanged";
  embeddedChunks: number;
}

export class SharedIndexError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
