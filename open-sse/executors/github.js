import { BaseExecutor } from "./base.js";
import { PROVIDERS, OAUTH_ENDPOINTS, HTTP_STATUS } from "../config/constants.js";
import { openaiToOpenAIResponsesRequest } from "../translator/request/openai-responses.js";
import { openaiResponsesToOpenAIResponse } from "../translator/response/openai-responses.js";
import { initState } from "../translator/index.js";
import { parseSSELine, formatSSE } from "../utils/streamHelpers.js";
import crypto from "crypto";

// GitHub Copilot context limit: 128K tokens
// We use a slightly lower limit to leave room for the response
const GITHUB_CONTEXT_LIMIT = 128000;
const CONTEXT_BUFFER = 8000; // Buffer for the response
const MAX_ALLOWED_TOKENS = GITHUB_CONTEXT_LIMIT - CONTEXT_BUFFER;

// Rough token estimation: ~4 characters per token
const CHARS_PER_TOKEN = 4;

export class GithubExecutor extends BaseExecutor {
  constructor() {
    super("github", PROVIDERS.github);
    this.knownCodexModels = new Set();
  }

  buildUrl(model, stream, urlIndex = 0) {
    return this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const token = credentials.copilotToken || credentials.accessToken;
    return {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "copilot-integration-id": "vscode-chat",
      "editor-version": "vscode/1.107.1",
      "editor-plugin-version": "copilot-chat/0.26.7",
      "user-agent": "GitHubCopilotChat/0.26.7",
      "openai-intent": "conversation-panel",
      "x-github-api-version": "2025-04-01",
      "x-request-id": crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      "x-vscode-user-agent-library-version": "electron-fetch",
      "X-Initiator": "user",
      "Accept": stream ? "text/event-stream" : "application/json"
    };
  }

  // Sanitize messages for GitHub Copilot /chat/completions endpoint.
  // The endpoint only accepts 'text' and 'image_url' content part types.
  // Tool-related content (tool_use, tool_result, thinking) must be serialized as text.
  sanitizeMessagesForChatCompletions(body) {
    if (!body?.messages) return body;

    const sanitized = { ...body };
    sanitized.messages = body.messages.map(msg => {
      // assistant messages with only tool_calls have content: null — leave as-is
      if (!msg.content) return msg;

      // String content is always fine
      if (typeof msg.content === "string") return msg;

      // Array content: filter/convert unsupported part types
      if (Array.isArray(msg.content)) {
        const cleanContent = msg.content
          .map(part => {
            if (part.type === "text") return part;
            if (part.type === "image_url") return part;
            // Serialize tool_use, tool_result, thinking, etc. as text
            const text = part.text || part.content || JSON.stringify(part);
            return { type: "text", text: typeof text === "string" ? text : JSON.stringify(text) };
          })
          .filter(part => part.text !== ""); // remove empty text parts

        // If all content was stripped (e.g. only tool_result with no text), drop content
        return { ...msg, content: cleanContent.length > 0 ? cleanContent : null };
      }

      return msg;
    });

    return sanitized;
  }

  /**
   * Estimate token count for a message (rough approximation)
   * Uses ~4 characters per token heuristic
   */
  estimateMessageTokens(message) {
    const content = message.content;
    let chars = 0;

    if (typeof content === "string") {
      chars = content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text" && part.text) {
          chars += part.text.length;
        } else if (part.type === "image_url") {
          // Base64 images: estimate based on data URL length
          chars += (part.image_url?.url || "").length;
        } else {
          // Other content types: estimate from JSON size
          chars += JSON.stringify(part).length;
        }
      }
    }

    // Add overhead for role, tool_calls, etc.
    const overhead = JSON.stringify({
      role: message.role,
      tool_calls: message.tool_calls || [],
      tool_call_id: message.tool_call_id || ""
    }).length;

    return Math.ceil((chars + overhead) / CHARS_PER_TOKEN);
  }

  /**
   * Estimate total tokens for all messages
   */
  estimateTotalTokens(messages) {
    if (!messages || !Array.isArray(messages)) return 0;
    return messages.reduce((sum, msg) => sum + this.estimateMessageTokens(msg), 0);
  }

  /**
   * Truncate messages to fit within the context limit
   * Strategy: Keep system messages, always keep first and last user messages,
   * and progressively remove older messages from the middle
   */
  truncateMessagesToFitLimit(body, log) {
    if (!body?.messages) return body;

    const messages = body.messages;
    const estimatedTokens = this.estimateTotalTokens(messages);

    if (estimatedTokens <= MAX_ALLOWED_TOKENS) {
      return body; // No truncation needed
    }

    log?.warn("GITHUB", `Estimated tokens (${estimatedTokens}) exceed limit (${MAX_ALLOWED_TOKENS}). Truncating...`);

    // Separate system messages from regular messages
    const systemMessages = messages.filter(m => m.role === "system");
    const regularMessages = messages.filter(m => m.role !== "system");

    // We'll keep: all system messages + truncated regular messages
    // Strategy: Keep first user message and last N messages that fit
    let truncated = [];
    let currentTokens = systemMessages.reduce((sum, m) => sum + this.estimateMessageTokens(m), 0);

    // Always keep the first user message (usually contains the main request)
    const firstUserMsg = regularMessages.find(m => m.role === "user");
    if (firstUserMsg) {
      truncated.push(firstUserMsg);
      currentTokens += this.estimateMessageTokens(firstUserMsg);
    }

    // Add messages from the end until we approach the limit
    // Leave some buffer for safety
    const targetTokens = MAX_ALLOWED_TOKENS - 4000; // Extra safety buffer

    for (let i = regularMessages.length - 1; i >= 0; i--) {
      const msg = regularMessages[i];
      if (msg === firstUserMsg) continue; // Skip if we already added it

      const msgTokens = this.estimateMessageTokens(msg);

      if (currentTokens + msgTokens <= targetTokens) {
        truncated.unshift(msg);
        currentTokens += msgTokens;
      } else {
        // Stop when adding this message would exceed the limit
        break;
      }
    }

    // Prepend system messages at the beginning
    const result = {
      ...body,
      messages: [...systemMessages, ...truncated]
    };

    log?.info("GITHUB", `Truncated from ${messages.length} to ${result.messages.length} messages (estimated ${currentTokens} tokens)`);

    return result;
  }

  async execute(options) {
    const { model, log } = options;

    // Only use /responses for models that are explicitly known to need it (e.g. gpt codex models)
    if (this.knownCodexModels.has(model)) {
      log?.debug("GITHUB", `Using cached /responses route for ${model}`);
      return this.executeWithResponsesEndpoint(options);
    }

    // First truncate messages to fit within context limit, then sanitize
    const truncatedBody = this.truncateMessagesToFitLimit(options.body, log);

    // Sanitize messages before sending to /chat/completions
    // This handles Claude models on GitHub Copilot which reject non-text/image_url content types
    const sanitizedOptions = {
      ...options,
      body: this.sanitizeMessagesForChatCompletions(truncatedBody)
    };

    const result = await super.execute(sanitizedOptions);

    if (result.response.status === HTTP_STATUS.BAD_REQUEST) {
      const errorBody = await result.response.clone().text();
      
      if (errorBody.includes("not accessible via the /chat/completions endpoint")) {
        log?.warn("GITHUB", `Model ${model} requires /responses. Switching...`);
        this.knownCodexModels.add(model);
        return this.executeWithResponsesEndpoint(options);
      }

      // Handle token limit errors by aggressively truncating and retrying
      if (errorBody.includes("exceeds the limit") || errorBody.includes("token")) {
        log?.warn("GITHUB", `Token limit error from API: ${errorBody.substring(0, 200)}`);
        // Already truncated above — this means our estimate was too generous
        // Try with even more aggressive truncation
        const aggressiveBody = this.aggressiveTruncate(truncatedBody, log);
        const retryOptions = {
          ...options,
          body: this.sanitizeMessagesForChatCompletions(aggressiveBody)
        };
        return super.execute(retryOptions);
      }
    }

    return result;
  }

  /**
   * Aggressive truncation: keep only system + first user + last 10 messages
   * Used as fallback when initial truncation wasn't enough
   */
  aggressiveTruncate(body, log) {
    if (!body?.messages) return body;

    const messages = body.messages;
    const systemMessages = messages.filter(m => m.role === "system");
    const regularMessages = messages.filter(m => m.role !== "system");

    const firstUser = regularMessages.find(m => m.role === "user");
    const lastMessages = regularMessages.slice(-10);

    // Ensure we don't add firstUser twice
    let result;
    if (firstUser && !lastMessages.includes(firstUser)) {
      result = [...systemMessages, firstUser, ...lastMessages];
    } else {
      result = [...systemMessages, ...lastMessages];
    }

    log?.warn("GITHUB", `Aggressive truncation: ${messages.length} → ${result.length} messages`);

    return { ...body, messages: result };
  }

  async executeWithResponsesEndpoint({ model, body, stream, credentials, signal, log }) {
    const url = this.config.responsesUrl;
    const headers = this.buildHeaders(credentials, stream);
    
    // Truncate messages before translation to fit within context limit
    const truncatedBody = this.truncateMessagesToFitLimit(body, log);
    const transformedBody = openaiToOpenAIResponsesRequest(model, truncatedBody, stream, credentials);

    log?.debug("GITHUB", "Sending translated request to /responses");

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformedBody),
      signal
    });

    // Handle token limit errors with aggressive truncation
    if (!response.ok && response.status === HTTP_STATUS.BAD_REQUEST) {
      const errorBody = await response.clone().text();
      if (errorBody.includes("exceeds the limit") || errorBody.includes("token")) {
        log?.warn("GITHUB", `Token limit error from /responses: ${errorBody.substring(0, 200)}`);
        const aggressiveBody = this.aggressiveTruncate(truncatedBody, log);
        const retryTransformed = openaiToOpenAIResponsesRequest(model, aggressiveBody, stream, credentials);
        
        const retryResponse = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(retryTransformed),
          signal
        });

        if (retryResponse.ok) {
          return this.buildResponseStream(retryResponse, model, url, headers, retryTransformed);
        }
      }
    }

    if (!response.ok) {
      return { response, url, headers, transformedBody };
    }

    return this.buildResponseStream(response, model, url, headers, transformedBody);
  }

  buildResponseStream(response, model, url, headers, transformedBody) {
    const state = initState("openai-responses");
    state.model = model;

    const decoder = new TextDecoder();
    let buffer = "";

    const transformStream = new TransformStream({
      async transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const parsed = parseSSELine(trimmed);
          if (!parsed) continue;

          if (parsed.done) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            continue;
          }

          const converted = openaiResponsesToOpenAIResponse(parsed, state);
          if (converted) {
            const sseString = formatSSE(converted, "openai");
            controller.enqueue(new TextEncoder().encode(sseString));
          }
        }
      },
      flush(controller) {
        if (buffer.trim()) {
           const parsed = parseSSELine(buffer.trim());
           if (parsed && !parsed.done) {
             const converted = openaiResponsesToOpenAIResponse(parsed, state);
             if (converted) {
               controller.enqueue(new TextEncoder().encode(formatSSE(converted, "openai")));
             }
           }
        }
      }
    });

    const convertedStream = response.body.pipeThrough(transformStream);

    return {
      response: new Response(convertedStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      }),
      url,
      headers,
      transformedBody
    };
  }

  async refreshCopilotToken(githubAccessToken, log) {
    try {
      const response = await fetch("https://api.github.com/copilot_internal/v2/token", {
        headers: {
          "Authorization": `token ${githubAccessToken}`,
          "User-Agent": "GithubCopilot/1.0",
          "Editor-Version": "vscode/1.100.0",
          "Editor-Plugin-Version": "copilot/1.300.0",
          "Accept": "application/json"
        }
      });
      if (!response.ok) return null;
      const data = await response.json();
      log?.info?.("TOKEN", "Copilot token refreshed");
      return { token: data.token, expiresAt: data.expires_at };
    } catch (error) {
      log?.error?.("TOKEN", `Copilot refresh error: ${error.message}`);
      return null;
    }
  }

  async refreshGitHubToken(refreshToken, log) {
    try {
      const response = await fetch(OAUTH_ENDPOINTS.github.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret
        })
      });
      if (!response.ok) return null;
      const tokens = await response.json();
      log?.info?.("TOKEN", "GitHub token refreshed");
      return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
    } catch (error) {
      log?.error?.("TOKEN", `GitHub refresh error: ${error.message}`);
      return null;
    }
  }

  async refreshCredentials(credentials, log) {
    let copilotResult = await this.refreshCopilotToken(credentials.accessToken, log);
    
    if (!copilotResult && credentials.refreshToken) {
      const githubTokens = await this.refreshGitHubToken(credentials.refreshToken, log);
      if (githubTokens?.accessToken) {
        copilotResult = await this.refreshCopilotToken(githubTokens.accessToken, log);
        if (copilotResult) {
          return { ...githubTokens, copilotToken: copilotResult.token, copilotTokenExpiresAt: copilotResult.expiresAt };
        }
        return githubTokens;
      }
    }
    
    if (copilotResult) {
      return { accessToken: credentials.accessToken, refreshToken: credentials.refreshToken, copilotToken: copilotResult.token, copilotTokenExpiresAt: copilotResult.expiresAt };
    }
    
    return null;
  }

  needsRefresh(credentials) {
    // Always refresh if no copilotToken
    if (!credentials.copilotToken) return true;
    
    if (credentials.copilotTokenExpiresAt) {
      // Handle both Unix timestamp (seconds) and ISO string
      let expiresAtMs = credentials.copilotTokenExpiresAt;
      if (typeof expiresAtMs === "number" && expiresAtMs < 1e12) {
        expiresAtMs = expiresAtMs * 1000; // Convert seconds to ms
      } else if (typeof expiresAtMs === "string") {
        expiresAtMs = new Date(expiresAtMs).getTime();
      }
      if (expiresAtMs - Date.now() < 5 * 60 * 1000) return true;
    }
    return super.needsRefresh(credentials);
  }
}

export default GithubExecutor;
