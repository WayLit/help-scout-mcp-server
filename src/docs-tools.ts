/**
 * Help Scout Docs MCP tool registrations. Served at /docs/mcp, distinct from
 * the mailbox MCP at /mcp — see HelpScoutDocsMCP in index.ts. Read AND write
 * tools: this connector is meant for fixing/authoring knowledge-base content,
 * not just searching it.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { MAX_UPLOAD_BYTES, mintUploadToken } from "./docs-assets";
import {
  CreateArticleImageUploadShape,
  CreateArticleShape,
  CreateCollectionShape,
  DeleteArticleShape,
  DeleteCollectionShape,
  GetArticleShape,
  GetCollectionShape,
  ListArticlesShape,
  ListCollectionsShape,
  SearchArticlesShape,
  UpdateArticleShape,
  UpdateCollectionShape,
} from "./docs-schemas";
import { HelpScoutApiError, isHelpScoutApiError } from "./helpscout-api";
import type { HelpScoutDocsAPI } from "./helpscout-docs-api";
import { logger, newRequestId } from "./logger";
import type { Env } from "./types";

function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(error: unknown, toolName: string, email?: string): CallToolResult {
  const requestId = newRequestId();
  if (isHelpScoutApiError(error)) {
    logger.warn("docs tool: HS API error", {
      requestId,
      email,
      toolName,
      errorCode: error.code,
      status: error.status,
      message: error.message,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: error.code,
              message: error.message,
              status: error.status,
              retryAfter: error.retryAfter,
              tool: toolName,
              requestId,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  logger.error("docs tool: unexpected error", {
    requestId,
    email,
    toolName,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: "UNEXPECTED_ERROR",
            message: error instanceof Error ? error.message : String(error),
            tool: toolName,
            requestId,
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

interface CollectionsEnvelope {
  collections: { page: number; pages: number; count: number; items: unknown[] };
}
interface ArticlesEnvelope {
  articles: { page: number; pages: number; count: number; items: unknown[] };
}

/** Collaborators the Docs tools need beyond the API client. */
export interface DocsToolDeps {
  env: Env;
  /**
   * Public origin of this worker, captured from the live request in
   * HelpScoutDocsMCP.fetch(). Returns undefined only if no request has been
   * served yet, in which case the upload URL is returned as a bare path.
   */
  getPublicOrigin: () => string | undefined;
}

export function registerDocsTools(
  server: McpServer,
  api: HelpScoutDocsAPI,
  deps: DocsToolDeps,
): void {
  // ── listCollections ─────────────────────────────────────────────────
  server.tool(
    "listCollections",
    "List Help Scout Docs collections (knowledge-base sections).",
    ListCollectionsShape,
    async (input): Promise<CallToolResult> => {
      try {
        const response = await api.get<CollectionsEnvelope>("/collections", {
          siteId: input.siteId,
          visibility: input.visibility,
          sort: input.sort,
          order: input.order,
          page: input.page,
        });
        return textResult({
          ...response.collections,
          usage: "Use collection.id with getCollection, listArticles, or createArticle.",
        });
      } catch (err) {
        return errorResult(err, "listCollections", api.userEmail);
      }
    },
  );

  // ── getCollection ────────────────────────────────────────────────────
  server.tool(
    "getCollection",
    "Get a single Docs collection by ID.",
    GetCollectionShape,
    async (input): Promise<CallToolResult> => {
      try {
        const response = await api.get<{ collection: unknown }>(
          `/collections/${input.collectionId}`,
        );
        return textResult(response.collection);
      } catch (err) {
        return errorResult(err, "getCollection", api.userEmail);
      }
    },
  );

  // ── createCollection ─────────────────────────────────────────────────
  server.tool(
    "createCollection",
    "Create a new Docs collection.",
    CreateCollectionShape,
    async (input): Promise<CallToolResult> => {
      try {
        const result = await api.write("POST", "/collections", {
          siteId: input.siteId,
          name: input.name,
          description: input.description,
          visibility: input.visibility,
        });
        return textResult({ success: true, ...(result as object) });
      } catch (err) {
        return errorResult(err, "createCollection", api.userEmail);
      }
    },
  );

  // ── updateCollection ─────────────────────────────────────────────────
  server.tool(
    "updateCollection",
    "Update a Docs collection's name, description, or visibility. Only provided fields change.",
    UpdateCollectionShape,
    async (input): Promise<CallToolResult> => {
      try {
        const { collectionId, ...body } = input;
        await api.write("PUT", `/collections/${collectionId}`, body);
        return textResult({ success: true, collectionId });
      } catch (err) {
        return errorResult(err, "updateCollection", api.userEmail);
      }
    },
  );

  // ── deleteCollection ─────────────────────────────────────────────────
  server.tool(
    "deleteCollection",
    "Permanently delete a Docs collection and all its articles. Irreversible.",
    DeleteCollectionShape,
    async (input): Promise<CallToolResult> => {
      try {
        await api.write("DELETE", `/collections/${input.collectionId}`);
        return textResult({ success: true, collectionId: input.collectionId });
      } catch (err) {
        return errorResult(err, "deleteCollection", api.userEmail);
      }
    },
  );

  // ── listArticles ─────────────────────────────────────────────────────
  server.tool(
    "listArticles",
    "List articles across the whole Docs site. Use searchArticles to scope to a collection or keyword.",
    ListArticlesShape,
    async (input): Promise<CallToolResult> => {
      try {
        const response = await api.get<ArticlesEnvelope>("/articles", {
          status: input.status,
          sort: input.sort,
          order: input.order,
          page: input.page,
          pageSize: input.pageSize,
        });
        return textResult({
          ...response.articles,
          usage: "Use article.id with getArticle, updateArticle, or deleteArticle.",
        });
      } catch (err) {
        return errorResult(err, "listArticles", api.userEmail);
      }
    },
  );

  // ── searchArticles ───────────────────────────────────────────────────
  server.tool(
    "searchArticles",
    "Search Docs articles by keyword, optionally scoped to a collection. Use this to find stale articles by topic.",
    SearchArticlesShape,
    async (input): Promise<CallToolResult> => {
      try {
        const response = await api.get<ArticlesEnvelope>("/search/articles", {
          query: input.query,
          collectionId: input.collectionId,
          siteId: input.siteId,
          status: input.status,
          visibility: input.visibility,
          page: input.page,
        });
        return textResult({
          ...response.articles,
          usage: "Use article.id with getArticle, updateArticle, or deleteArticle.",
        });
      } catch (err) {
        return errorResult(err, "searchArticles", api.userEmail);
      }
    },
  );

  // ── getArticle ───────────────────────────────────────────────────────
  server.tool(
    "getArticle",
    "Get a full Docs article by ID, including its body text. Pass draft=true to read unpublished draft changes.",
    GetArticleShape,
    async (input): Promise<CallToolResult> => {
      try {
        const response = await api.get<{ article: unknown }>(`/articles/${input.articleId}`, {
          draft: input.draft || undefined,
        });
        return textResult(response.article);
      } catch (err) {
        return errorResult(err, "getArticle", api.userEmail);
      }
    },
  );

  // ── createArticle ────────────────────────────────────────────────────
  server.tool(
    "createArticle",
    "Create a new Docs article in a collection. Defaults to unpublished (status=notpublished) so you can review before it goes live. Pass related to link sibling articles by their internal id.",
    CreateArticleShape,
    async (input): Promise<CallToolResult> => {
      try {
        const result = await api.write("POST", "/articles?reload=true", {
          collectionId: input.collectionId,
          name: input.name,
          text: input.text,
          status: input.status,
          categories: input.categories,
          keywords: input.keywords,
          related: input.related,
        });
        return textResult({ success: true, ...(result as object) });
      } catch (err) {
        return errorResult(err, "createArticle", api.userEmail);
      }
    },
  );

  // ── updateArticle ────────────────────────────────────────────────────
  server.tool(
    "updateArticle",
    'Update a Docs article. Only provided fields change — omit fields to leave them as-is. Set status to "published" to publish, "notpublished" to unpublish. The list fields (categories, keywords, related) each replace their whole list rather than appending to it; pass null to clear one.',
    UpdateArticleShape,
    async (input): Promise<CallToolResult> => {
      try {
        const { articleId, ...body } = input;
        await api.write("PUT", `/articles/${articleId}`, body);
        return textResult({ success: true, articleId });
      } catch (err) {
        return errorResult(err, "updateArticle", api.userEmail);
      }
    },
  );

  // ── deleteArticle ────────────────────────────────────────────────────
  server.tool(
    "deleteArticle",
    "Permanently delete a Docs article. Irreversible.",
    DeleteArticleShape,
    async (input): Promise<CallToolResult> => {
      try {
        await api.write("DELETE", `/articles/${input.articleId}`);
        return textResult({ success: true, articleId: input.articleId });
      } catch (err) {
        return errorResult(err, "deleteArticle", api.userEmail);
      }
    },
  );

  // ── createArticleImageUpload ─────────────────────────────────────────
  server.tool(
    "createArticleImageUpload",
    "Get a one-time URL for uploading an image into a Docs article. Image bytes " +
      "never pass through this tool — it returns an uploadUrl and uploadToken that a " +
      "local uploader posts the file to, and that upload returns the image's filelink. " +
      "To place the image, read the article with getArticle, insert an <img> tag " +
      "pointing at the filelink, and save with updateArticle. When adding several " +
      "images, upload them all first and then apply every <img> tag in one " +
      "updateArticle call — updateArticle replaces the whole body, so one call per " +
      "image would discard the previous insertions.",
    CreateArticleImageUploadShape,
    async (input): Promise<CallToolResult> => {
      try {
        if (!(await api.hasApiKey())) {
          throw new HelpScoutApiError(
            "REAUTH_REQUIRED",
            "Help Scout Docs API key required. Visit /docs-api-key/enter to connect one.",
            401,
          );
        }
        // Fail here rather than after the user's local uploader has already run.
        // Also resolves the id to bind into the token: GET /articles/{…} takes
        // an id or a sequential number, but POST /assets/article takes only the
        // id, so echoing back whatever the caller passed would let an
        // article-number mint succeed and then fail at upload time — with the
        // single-use token already burned.
        const { article } = await api.get<{ article?: { id?: string } }>(
          `/articles/${input.articleId}`,
        );
        const articleId = article?.id ?? input.articleId;

        const { token, expiresAt } = await mintUploadToken(
          deps.env,
          api.userEmail,
          articleId,
          input.fileName,
        );
        const origin = deps.getPublicOrigin();
        const uploadPath = "/docs/assets/upload";
        return textResult({
          uploadUrl: origin ? `${origin}${uploadPath}` : uploadPath,
          uploadToken: token,
          expiresAt,
          articleId,
          maxBytes: MAX_UPLOAD_BYTES,
          allowedFormats: ["png", "jpeg", "gif", "webp"],
          usage:
            "POST the image to uploadUrl as multipart/form-data with the file in a " +
            "`file` field and header `Authorization: Bearer <uploadToken>`. The token " +
            "is single-use and expires at expiresAt. The response contains `filelink`. " +
            'Then getArticle, splice <img src="<filelink>"> into the body, and save ' +
            "with updateArticle. Uploading several images? Collect every filelink " +
            "first, then apply them all in one updateArticle call — updateArticle " +
            "overwrites the whole body.",
        });
      } catch (err) {
        return errorResult(err, "createArticleImageUpload", api.userEmail);
      }
    },
  );
}
