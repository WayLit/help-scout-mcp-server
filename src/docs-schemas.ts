/**
 * Zod input shapes for Help Scout Docs MCP tools.
 */
import { z } from "zod";

const StatusFilter = z.enum(["all", "published", "notpublished"]).default("all");

/**
 * Help Scout article ids are 24-char hex ObjectIds. `related` accepts ids only
 * — unlike `articleId` on getArticle, which the Docs API also resolves by the
 * human-facing article *number* — so reject a number here locally instead of
 * letting it reach the API, where it would either 400 or store a dead link.
 */
const ArticleObjectId = z
  .string()
  .regex(
    /^[0-9a-f]{24}$/i,
    "Must be a 24-character hex article id (article.id), not an article number (article.number).",
  );

const RELATED_IDS =
  "Internal 24-char hex ids of related articles — use article.id, not article.number.";

/**
 * `categories`, `keywords`, and `related` are whole-list fields on update: the
 * Docs API replaces the list outright rather than appending, and only a literal
 * null empties it. Nullable so that clear is expressible at all — with plain
 * `.optional()` a caller can add or replace entries but never remove them.
 */
function replaceableList<T extends z.ZodType>(item: T, lead: string) {
  return z
    .array(item)
    .nullable()
    .optional()
    .describe(
      `${lead} Replaces the whole list rather than appending, so include every entry you want ` +
        "to keep. Omit to leave it untouched; pass null to remove all.",
    );
}

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
  related: z.array(ArticleObjectId).optional().describe(RELATED_IDS),
};

export const UpdateArticleShape = {
  articleId: z.string(),
  name: z.string().optional(),
  text: z.string().optional().describe("Article body, plain text or HTML."),
  status: z.enum(["published", "notpublished"]).optional(),
  categories: replaceableList(
    z.string(),
    "Ids of the categories the article belongs to. Clearing it returns the article to Uncategorized.",
  ),
  keywords: replaceableList(z.string(), "Search keywords for the article."),
  related: replaceableList(
    ArticleObjectId,
    `${RELATED_IDS} Read the article's current related ids first if you mean to add to them.`,
  ),
};

export const DeleteArticleShape = {
  articleId: z.string(),
};

export const CreateArticleImageUploadShape = {
  articleId: z.string().describe("The article the image will be attached to. Must already exist."),
  fileName: z
    .string()
    .optional()
    .describe("Optional name to store the image under. Defaults to the uploaded file's name."),
};
