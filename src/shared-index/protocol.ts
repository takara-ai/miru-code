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
export const gitCommitId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const identitySchema = z.strictObject({
  tenant: z.string().min(1).max(128),
  principal: z.string().min(1).max(200),
});

export const revisionSchema = z.strictObject({ repository: repositoryId, path: filePath });

export const changeSchema = revisionSchema.extend({
  previousRevision: revision.nullable(),
  revision,
  gitSync: z.literal(true).optional(),
  content: z
    .string()
    .max(128_000)
    .refine((value) => !value.includes("\0"))
    .nullable(),
});

export const gitStateSchema = z.strictObject({ repository: repositoryId });

export const gitSyncSchema = gitStateSchema.extend({
  action: z.enum(["begin", "finish"]),
  target: gitCommitId,
  base: gitCommitId.nullable(),
});

export const gitSyncStateSchema = z.object({
  completed: gitCommitId.nullable(),
  active: gitCommitId.nullable(),
});

export const querySchema = z.strictObject({
  query: z.string().trim().min(1).max(2_000),
  repositories: z.array(repositoryId).min(1).max(16),
  limit: z.number().int().min(1).max(10).default(5),
});

export type Identity = z.infer<typeof identitySchema>;
export type FileChange = z.infer<typeof changeSchema>;
export type GitSync = z.infer<typeof gitSyncSchema>;
export type GitState = z.infer<typeof gitSyncStateSchema>;
export type SharedQuery = z.input<typeof querySchema>;
export type SharedResult = SearchResult & { repository: string };
export const fileUpdateSchema = z.object({
  state: z.enum(["updated", "unchanged"]),
  embeddedChunks: z.number().int().min(0),
});
export const fileRevisionSchema = z.object({ revision: revision.nullable() });
export const sharedResultsSchema = z.array(
  z.object({
    repository: repositoryId,
    score: z.number(),
    chunk: z.object({
      content: z.string(),
      file_path: filePath,
      start_line: z.number().int().min(1),
      end_line: z.number().int().min(1),
      language: z.string().nullable(),
    }),
  }),
);
export type FileUpdate = z.infer<typeof fileUpdateSchema>;

export class SharedIndexError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
