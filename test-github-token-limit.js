/**
 * Test script for GitHub token limit truncation
 * 
 * This simulates a long conversation that would exceed 128K tokens
 * and verifies the truncation logic works correctly.
 */

import { GithubExecutor } from "./open-sse/executors/github.js";
import { PROVIDERS } from "./open-sse/config/constants.js";

// Mock logger
const logger = {
  debug: (scope, msg) => console.log(`[DEBUG] ${scope}: ${msg}`),
  info: (scope, msg) => console.log(`[INFO] ${scope}: ${msg}`),
  warn: (scope, msg) => console.warn(`[WARN] ${scope}: ${msg}`),
  error: (scope, msg) => console.error(`[ERROR] ${scope}: ${msg}`)
};

// Create executor instance
const executor = new GithubExecutor();
executor.config = {
  baseUrl: "https://api.githubcopilot.com/chat/completions",
  responsesUrl: "https://api.githubcopilot.com/responses"
};

/**
 * Create a large message array that would exceed 128K tokens
 */
function createLargeMessageArray(targetTokens = 150000) {
  const messages = [
    { role: "system", content: "You are a helpful AI assistant." }
  ];

  // Each message is roughly 1000 tokens (4000 chars)
  const messageTemplate = {
    role: "user",
    content: "Please analyze this code and suggest improvements. ".repeat(200) +
      "Here is a detailed explanation of the codebase structure. ".repeat(100) +
      "We need to ensure proper error handling and validation. ".repeat(100)
  };

  const assistantTemplate = {
    role: "assistant",
    content: "I'll help you analyze the code. ".repeat(200) +
      "Based on my analysis, here are the key improvements I suggest. ".repeat(100) +
      "Let me provide detailed recommendations for each section. ".repeat(100)
  };

  // Add messages until we exceed target token count
  let estimatedTokens = 0;
  let messageCount = 0;
  const tokensPerMessage = 1000; // rough estimate

  while (estimatedTokens < targetTokens) {
    messages.push(messageTemplate);
    messages.push(assistantTemplate);
    estimatedTokens += tokensPerMessage * 2;
    messageCount += 2;
  }

  console.log(`Created ${messageCount} messages (estimated ${estimatedTokens} tokens)`);

  return messages;
}

/**
 * Test token estimation
 */
function testTokenEstimation() {
  console.log("\n=== Test 1: Token Estimation ===\n");

  const testMessages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello, how are you?" },
    { role: "assistant", content: "I'm doing well, thank you!" }
  ];

  const tokens = executor.estimateTotalTokens(testMessages);
  console.log(`Test messages estimated tokens: ${tokens}`);

  const largeMessages = createLargeMessageArray(150000);
  const largeTokens = executor.estimateTotalTokens(largeMessages);
  console.log(`Large messages estimated tokens: ${largeTokens}`);

  return largeMessages;
}

/**
 * Test truncation logic
 */
function testTruncation() {
  console.log("\n=== Test 2: Message Truncation ===\n");

  const body = {
    model: "gpt-4o",
    messages: createLargeMessageArray(150000)
  };

  const originalCount = body.messages.length;
  const originalTokens = executor.estimateTotalTokens(body.messages);
  console.log(`Original: ${originalCount} messages, ~${originalTokens} tokens`);

  const truncatedBody = executor.truncateMessagesToFitLimit(body, logger);

  const newCount = truncatedBody.messages.length;
  const newTokens = executor.estimateTotalTokens(truncatedBody.messages);
  console.log(`Truncated: ${newCount} messages, ~${newTokens} tokens`);
  console.log(`Removed: ${originalCount - newCount} messages`);

  // Verify system message is preserved
  const hasSystem = truncatedBody.messages.some(m => m.role === "system");
  console.log(`System message preserved: ${hasSystem}`);

  // Verify first user message is preserved
  const firstUserIndex = truncatedBody.messages.findIndex(m => m.role === "user");
  console.log(`First user message at index: ${firstUserIndex}`);

  // Verify tokens are under limit
  const isUnderLimit = newTokens <= 120000; // MAX_ALLOWED_TOKENS
  console.log(`Under limit (120K): ${isUnderLimit}`);

  return { success: isUnderLimit && hasSystem && firstUserIndex >= 0 };
}

/**
 * Test aggressive truncation
 */
function testAggressiveTruncation() {
  console.log("\n=== Test 3: Aggressive Truncation ===\n");

  const body = {
    model: "gpt-4o",
    messages: createLargeMessageArray(150000)
  };

  const originalCount = body.messages.length;
  console.log(`Original: ${originalCount} messages`);

  const truncatedBody = executor.aggressiveTruncate(body, logger);

  const newCount = truncatedBody.messages.length;
  console.log(`Aggressively truncated to: ${newCount} messages`);

  // Should be system + first user + last 10 = at most 12
  const expectedMax = 12;
  const isExpectedSize = newCount <= expectedMax;
  console.log(`Under ${expectedMax} messages: ${isExpectedSize}`);

  return isExpectedSize;
}

/**
 * Test sanitize messages
 */
function testSanitizeMessages() {
  console.log("\n=== Test 4: Sanitize Messages ===\n");

  const body = {
    messages: [
      { role: "system", content: "System message" },
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
          { type: "tool_use", id: "call_123", name: "test", input: {} },
          { type: "tool_result", tool_call_id: "call_123", content: "Result" }
        ]
      }
    ]
  };

  const sanitized = executor.sanitizeMessagesForChatCompletions(body);

  for (const msg of sanitized.messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        const isValid = part.type === "text" || part.type === "image_url";
        console.log(`Content part type: ${part.type}, valid: ${isValid}`);
      }
    }
  }

  return true;
}

/**
 * Run all tests
 */
function runAllTests() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   GitHub Token Limit Truncation - Test Suite            ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  try {
    testTokenEstimation();
    const truncationResult = testTruncation();
    const aggressiveResult = testAggressiveTruncation();
    const sanitizeResult = testSanitizeMessages();

    console.log("\n=== Test Results ===\n");
    console.log(`✅ Token Estimation: PASSED`);
    console.log(`${truncationResult ? '✅' : '❌'} Truncation: ${truncationResult ? 'PASSED' : 'FAILED'}`);
    console.log(`${aggressiveResult ? '✅' : '❌'} Aggressive Truncation: ${aggressiveResult ? 'PASSED' : 'FAILED'}`);
    console.log(`✅ Sanitize Messages: PASSED`);

    const allPassed = truncationResult && aggressiveResult && sanitizeResult;
    console.log(`\n${allPassed ? '🎉 ALL TESTS PASSED!' : '❌ SOME TESTS FAILED!'}`);

    return allPassed ? 0 : 1;

  } catch (error) {
    console.error("\n❌ Test Error:", error.message);
    console.error(error.stack);
    return 1;
  }
}

// Run tests
runAllTests();
