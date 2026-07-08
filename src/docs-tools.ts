/**
 * Help Scout Docs MCP tool registrations. Served at /docs/mcp, distinct from
 * the mailbox MCP at /mcp — see HelpScoutDocsMCP in index.ts. Read AND write
 * tools: this connector is meant for fixing/authoring knowledge-base content,
 * not just searching it.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
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
import { isHelpScoutApiError } from "./helpscout-api";
import type { HelpScoutDocsAPI } from "./helpscout-docs-api";
import { logger, newRequestId } from "./logger";

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

export function registerDocsTools(server: McpServer, api: HelpScoutDocsAPI): void {
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
    "Create a new Docs article in a collection. Defaults to unpublished (status=notpublished) so you can review before it goes live.",
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
    "Update a Docs article. Only provided fields change — omit fields to leave them as-is. Set status to \"published\" to publish, \"notpublished\" to unpublish.",
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
}
