/**
 * Real integration test for GitHub token limit
 * 
 * This creates a mock request with large payload and verifies
 * the executor properly handles it.
 */

import { GithubExecutor } from "./open-sse/executors/github.js";

const executor = new GithubExecutor();
executor.config = {
  baseUrl: "https://api.githubcopilot.com/chat/completions",
  responsesUrl: "https://api.githubcopilot.com/responses"
};

const logger = {
  debug: (scope, msg) => console.log(`[DEBUG] ${scope}: ${msg}`),
  info: (scope, msg) => console.log(`[INFO] ${scope}: ${msg}`),
  warn: (scope, msg) => console.warn(`[WARN] ${scope}: ${msg}`),
  error: (scope, msg) => console.error(`[ERROR] ${scope}: ${msg}`)
};

/**
 * Create realistic large conversation
 */
function createRealisticLargeConversation() {
  const messages = [
    {
      role: "system",
      content: "You are Claude Code, Anthropic's official CLI for coding."
    }
  ];

  // Simulate a long coding session
  const codingScenarios = [
    {
      user: "Can you help me build a REST API with Node.js and Express?",
      assistant: "I'll help you build a REST API with Node.js and Express. Let me create the basic structure for you..."
    },
    {
      user: "Add authentication with JWT",
      assistant: "I'll add JWT authentication to your API. Here's how to implement it..."
    },
    {
      user: "Now add database integration with MongoDB",
      assistant: "I'll integrate MongoDB into your application. Here are the necessary changes..."
    },
    {
      user: "Add input validation and error handling",
      assistant: "I'll add comprehensive input validation and error handling..."
    },
    {
      user: "Add unit tests for all endpoints",
      assistant: "I'll write unit tests using Jest for all your API endpoints..."
    },
    {
      user: "Add rate limiting middleware",
      assistant: "I'll implement rate limiting using express-rate-limit..."
    }
  ];

  // Repeat scenarios many times to exceed token limit
  for (let i = 0; i < 25; i++) {
    for (const scenario of codingScenarios) {
      messages.push({ role: "user", content: scenario.user + " " + "Please provide detailed code examples and explanations. ".repeat(10) });
      messages.push({ role: "assistant", content: scenario.assistant + " " + "Here's the complete implementation with comments: ".repeat(20) });
    }
  }

  return messages;
}

/**
 * Test with realistic conversation
 */
function testRealisticConversation() {
  console.log("=== Realistic Conversation Test ===\n");

  const body = {
    model: "gpt-4o",
    messages: createRealisticLargeConversation(),
    stream: true
  };

  const originalCount = body.messages.length;
  const originalTokens = executor.estimateTotalTokens(body.messages);

  console.log(`Original conversation:`);
  console.log(`  - Messages: ${originalCount}`);
  console.log(`  - Estimated tokens: ${originalTokens.toLocaleString()}`);
  console.log(`  - Exceeds limit: ${originalTokens > 120000 ? 'YES' : 'NO'}`);

  // Test truncation
  const truncatedBody = executor.truncateMessagesToFitLimit(body, logger);

  const newCount = truncatedBody.messages.length;
  const newTokens = executor.estimateTotalTokens(truncatedBody.messages);

  console.log(`\nAfter truncation:`);
  console.log(`  - Messages: ${newCount}`);
  console.log(`  - Estimated tokens: ${newTokens.toLocaleString()}`);
  console.log(`  - Under limit: ${newTokens <= 120000 ? 'YES' : 'NO'}`);
  console.log(`  - Removed messages: ${originalCount - newCount}`);

  // Verify structure
  const hasSystem = truncatedBody.messages.some(m => m.role === "system");
  const firstUserIdx = truncatedBody.messages.findIndex(m => m.role === "user");
  const lastIsAssistant = truncatedBody.messages[truncatedBody.messages.length - 1]?.role === "assistant";

  console.log(`\nStructure verification:`);
  console.log(`  - System message preserved: ${hasSystem ? 'YES' : 'NO'}`);
  console.log(`  - First user message preserved: ${firstUserIdx >= 0 ? 'YES' : 'NO'}`);
  console.log(`  - Last message is assistant: ${lastIsAssistant ? 'YES' : 'NO'}`);

  return {
    success: newTokens <= 120000 && hasSystem && firstUserIdx >= 0,
    tokenReduction: originalTokens - newTokens,
    messageReduction: originalCount - newCount
  };
}

/**
 * Test sanitize + truncation combo
 */
function testSanitizeAndTruncate() {
  console.log("\n=== Sanitize + Truncate Combo Test ===\n");

  const body = {
    model: "claude-sonnet-4.6",
    messages: createRealisticLargeConversation(),
    stream: true
  };

  // First truncate
  const truncated = executor.truncateMessagesToFitLimit(body, logger);

  // Then sanitize (as execute method does)
  const sanitized = executor.sanitizeMessagesForChatCompletions(truncated);

  const tokens = executor.estimateTotalTokens(sanitized.messages);

  console.log(`After truncation + sanitization:`);
  console.log(`  - Messages: ${sanitized.messages.length}`);
  console.log(`  - Estimated tokens: ${tokens.toLocaleString()}`);
  console.log(`  - Under limit: ${tokens <= 120000 ? 'YES' : 'NO'}`);

  // Check all content types are valid
  let allValid = true;
  for (const msg of sanitized.messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type !== "text" && part.type !== "image_url") {
          allValid = false;
          console.log(`  - Invalid content type found: ${part.type}`);
        }
      }
    }
  }

  console.log(`  - All content types valid: ${allValid ? 'YES' : 'NO'}`);

  return tokens <= 120000 && allValid;
}

/**
 * Test aggressive truncation fallback
 */
function testAggressiveFallback() {
  console.log("\n=== Aggressive Truncation Fallback Test ===\n");

  const body = {
    model: "gpt-4o",
    messages: createRealisticLargeConversation()
  };

  const originalCount = body.messages.length;
  console.log(`Original: ${originalCount} messages`);

  const aggressive = executor.aggressiveTruncate(body, logger);

  const newCount = aggressive.messages.length;
  const tokens = executor.estimateTotalTokens(aggressive.messages);

  console.log(`After aggressive truncation:`);
  console.log(`  - Messages: ${newCount}`);
  console.log(`  - Estimated tokens: ${tokens.toLocaleString()}`);
  console.log(`  - Expected max 12 messages: ${newCount <= 12 ? 'YES' : 'NO'}`);

  // Should be drastically smaller
  const reduction = originalCount - newCount;
  console.log(`  - Messages removed: ${reduction}`);

  return newCount <= 12 && tokens < 50000;
}

/**
 * Run all integration tests
 */
function runIntegrationTests() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   GitHub Token Limit - Integration Tests                ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  try {
    const result1 = testRealisticConversation();
    const result2 = testSanitizeAndTruncate();
    const result3 = testAggressiveFallback();

    console.log("\n=== Integration Test Results ===\n");
    console.log(`${result1.success ? '✅' : '❌'} Realistic Conversation: ${result1.success ? 'PASSED' : 'FAILED'}`);
    console.log(`   - Token reduction: ${(result1.tokenReduction / 1000).toFixed(0)}K tokens`);
    console.log(`   - Message reduction: ${result1.messageReduction} messages`);
    console.log(`${result2 ? '✅' : '❌'} Sanitize + Truncate: ${result2 ? 'PASSED' : 'FAILED'}`);
    console.log(`${result3 ? '✅' : '❌'} Aggressive Fallback: ${result3 ? 'PASSED' : 'FAILED'}`);

    const allPassed = result1.success && result2 && result3;
    console.log(`\n${allPassed ? '🎉 ALL INTEGRATION TESTS PASSED!' : '❌ SOME TESTS FAILED!'}`);

    return allPassed ? 0 : 1;

  } catch (error) {
    console.error("\n❌ Integration Test Error:", error.message);
    console.error(error.stack);
    return 1;
  }
}

runIntegrationTests();
