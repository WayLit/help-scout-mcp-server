/**
 * Zod input shapes for Help Scout Docs MCP tools.
 */
import { z } from "zod";

const StatusFilter = z.enum(["all", "published", "notpublished"]).default("all");

export const ListCollectionsShape = {
  siteId: z.string().optional(),
  visibility: z.enum(["all", "public", "private"]).default("all"),
  sort: z.enum(["number", "visibility", "order", "name", "createdAt", "updatedAt"]).optional(),
  order: z.enum(["asc", "desc"]).default("asc"),
  page: z.number().min(1).default(1),
};

export const GetCollectionShape = {
  collectionId: z.string(),
};

export const CreateCollectionShape = {
  siteId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  visibility: z.enum(["public", "private"]).default("public"),
};

export const UpdateCollectionShape = {
  collectionId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  visibility: z.enum(["public", "private"]).optional(),
};

export const DeleteCollectionShape = {
  collectionId: z.string(),
};

export const ListArticlesShape = {
  status: StatusFilter,
  sort: z.enum(["number", "status", "name", "popularity", "createdAt", "updatedAt"]).optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().min(1).default(1),
  pageSize: z.number().min(1).max(100).default(50),
};

export const SearchArticlesShape = {
  query: z.string(),
  collectionId: z.string().optional(),
  siteId: z.string().optional(),
  status: StatusFilter,
  visibility: z.enum(["all", "public", "private"]).default("all"),
  page: z.number().min(1).default(1),
};

export const GetArticleShape = {
  articleId: z.string(),
  draft: z.boolean().default(false),
};

export const CreateArticleShape = {
  collectionId: z.string(),
  name: z.string(),
  text: z.string().describe("Article body, plain text or HTML."),
  status: z.enum(["published", "notpublished"]).default("notpublished"),
  categories: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
};

export const UpdateArticleShape = {
  articleId: z.string(),
  name: z.string().optional(),
  text: z.string().optional().describe("Article body, plain text or HTML."),
  status: z.enum(["published", "notpublished"]).optional(),
  categories: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
};

export const DeleteArticleShape = {
  articleId: z.string(),
};
