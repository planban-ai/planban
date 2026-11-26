import { z } from "zod";
import { PLANBAN_STATUSES } from "./types";

export const statusSchema = z.enum(PLANBAN_STATUSES);

export const manifestSchema = z.object({
  version: z.literal(1),
  repoId: z.string().min(1),
  enabled: z.boolean(),
  storage: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("local"),
      root: z.string().min(1).optional(),
    }),
    z.object({
      kind: z.literal("online"),
      url: z.url().refine((value) => {
        const url = new URL(value);
        return !url.username && !url.password && !url.search && !url.hash && url.pathname === "/"
          && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
      }, "Use an HTTPS origin, or HTTP on loopback for development."),
      boardId: z.string().min(1),
    }),
  ]).optional(),
});

export const landingSchema = z.object({
  repo: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
  mergedAt: z.string().min(1),
  url: z.string(),
  recordedAt: z.string().min(1),
  reportedThrough: z.string().min(1).max(200).optional(),
});

const roadmapItemBaseSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: statusSchema,
    priority: z.number().int().nullable().default(null),
    summary: z.string().nullable().default(null),
    nextAction: z.string().nullable().default(null),
    tags: z.array(z.string()).default([]),
    icon: z.string().nullable().default(null),
    blockedBy: z.string().nullable().default(null),
    specDoc: z.string().nullable().default(null),
    planDoc: z.string().nullable().default(null),
    completedAt: z.string().nullable().default(null),
    reviewState: z.enum(["not-ready", "ready-for-review"]).nullish(),
    updatedAt: z.string().nullable().default(null),
    progressNotedAt: z.string().nullish(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    landings: z.array(landingSchema).optional(),
  });

export const roadmapV1ItemSchema = roadmapItemBaseSchema.passthrough();

const roadmapWriter1ItemSchema = roadmapItemBaseSchema.extend({
  isProgramme: z.boolean().default(false),
}).passthrough();

const legacyRoadmapV2ItemSchema = roadmapItemBaseSchema.extend({
  isProgramme: z.boolean(),
  parentId: z.string().min(1).nullable(),
  blockedBy: z.string().min(1).nullable().default(null),
  boardRank: z.number().int().positive().nullable(),
  programmeRank: z.number().int().positive().nullable(),
}).passthrough();

export const roadmapV2ItemSchema = roadmapItemBaseSchema.extend({
  isGroup: z.boolean(),
  parentId: z.string().min(1).nullable(),
  blockedBy: z.string().min(1).nullable().default(null),
  boardRank: z.number().int().positive().nullable(),
  groupRank: z.number().int().positive().nullable(),
}).passthrough();

const roadmapBaseShape = {
  revision: z.number().int().nonnegative().default(1),
  updatedAt: z.string().min(1),
  project: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: z.string().min(1),
    description: z.string().default(""),
    tags: z.array(z.string()).default([]),
  }),
  columns: z
    .array(
      z.object({
        id: statusSchema,
        label: z.string().min(1),
      }),
    )
    .default([]),
  landingInbox: z.array(landingSchema).optional(),
};

export const roadmapV1Schema = z.object({
  version: z.literal(1),
  ...roadmapBaseShape,
  roadmapItems: z.array(roadmapV1ItemSchema).default([]),
});

const roadmapWriter3ItemSchema = legacyRoadmapV2ItemSchema.extend({ reviewState: z.enum(["not-ready", "ready-for-review"]).nullish() });
const roadmapWriter5ItemSchema = legacyRoadmapV2ItemSchema.omit({ reviewState: true });
const roadmapWriter6ItemSchema = roadmapV2ItemSchema.omit({ reviewState: true });

export const roadmapV2Schema = z.union([
  z.object({ version: z.literal(2), writerVersion: z.literal(1), ...roadmapBaseShape, roadmapItems: z.array(roadmapWriter1ItemSchema).default([]) }),
  z.object({ version: z.literal(2), writerVersion: z.literal(2), ...roadmapBaseShape, roadmapItems: z.array(legacyRoadmapV2ItemSchema).default([]) }),
  z.object({ version: z.literal(2), writerVersion: z.literal(3), ...roadmapBaseShape, roadmapItems: z.array(roadmapWriter3ItemSchema).default([]) }),
  z.object({ version: z.literal(2), writerVersion: z.literal(4), ...roadmapBaseShape, roadmapItems: z.array(roadmapWriter3ItemSchema).default([]) }),
  z.object({ version: z.literal(2), writerVersion: z.literal(5), ...roadmapBaseShape, roadmapItems: z.array(roadmapWriter5ItemSchema).default([]) }),
  z.object({ version: z.literal(2), writerVersion: z.literal(6), ...roadmapBaseShape, roadmapItems: z.array(roadmapWriter6ItemSchema).default([]) }),
]);

export const roadmapSchema = z.union([roadmapV1Schema, roadmapV2Schema]);
