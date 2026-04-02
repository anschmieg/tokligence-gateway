const fs = require('fs');
const path = require('path');
const axios = require('axios');

/**
 * Knowledge Base Loader
 *
 * Loads documentation from local snapshot (bundled with npm package)
 * and provides links to latest online documentation.
 *
 * Strategy:
 * - Build-time: Sync docs from Go repo, generate _meta.json
 * - Runtime: Load local snapshot, async check for updates
 */

const KNOWLEDGE_DIR = path.join(__dirname, '../knowledge');
const META_FILE = path.join(KNOWLEDGE_DIR, '_meta.json');
const UPDATE_CHECK_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Load all documentation from local knowledge base
 * @returns {Object} Knowledge base content
 */
function loadKnowledge() {
  const knowledge = {
    meta: {},
    docs: {},
    links: {}
  };

  // Load metadata if exists
  if (fs.existsSync(META_FILE)) {
    try {
      knowledge.meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    } catch (error) {
      console.warn('⚠️  Failed to load knowledge metadata:', error.message);
    }
  }

  // Load all markdown files
  if (fs.existsSync(KNOWLEDGE_DIR)) {
    const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const filePath = path.join(KNOWLEDGE_DIR, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const name = path.basename(file, '.md');
      knowledge.docs[name] = content;
    }
  }

  // Set up online documentation links
  knowledge.links = {
    github: 'https://github.com/tokligence/tokligence-gateway',
    npm: 'https://www.npmjs.com/package/@tokligence/gateway',
    website: 'https://tokligence.ai',
    wiki: 'https://github.com/tokligence/tokligence-gateway/wiki',
    issues: 'https://github.com/tokligence/tokligence-gateway/issues'
  };

  return knowledge;
}

/**
 * Check if documentation needs updating
 * @returns {Promise<Object|null>} Update info or null
 */
async function checkForUpdates() {
  try {
    // Check when we last checked for updates
    const lastCheckFile = path.join(KNOWLEDGE_DIR, '.last_update_check');
    if (fs.existsSync(lastCheckFile)) {
      const lastCheck = parseInt(fs.readFileSync(lastCheckFile, 'utf8'));
      if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL) {
        return null; // Too soon to check again
      }
    }

    // Fetch latest version info from GitHub
    const response = await axios.get(
      'https://api.github.com/repos/tokligence/tokligence-gateway/releases/latest',
      { timeout: 5000 }
    );

    if (response.status === 200) {
      const latestVersion = response.data.tag_name;

      // Load current version from package.json (npm package version)
      const pkg = require('../../package.json');
      const currentVersion = `v${pkg.version}`;

      // Save check timestamp
      fs.writeFileSync(lastCheckFile, Date.now().toString());

      // Compare versions
      if (currentVersion !== latestVersion) {
        return {
          current: currentVersion,
          latest: latestVersion,
          url: response.data.html_url,
          published: response.data.published_at
        };
      }
    }

    return null;
  } catch (error) {
    // Silently fail - offline mode should work
    return null;
  }
}

/**
 * Generate system prompt with knowledge base
 * @param {Object} knowledge - Knowledge base object
 * @returns {string} System prompt
 */
function buildSystemPrompt(knowledge) {
  const docSummary = Object.keys(knowledge.docs).length > 0
    ? `You have access to the following local documentation:\n${Object.keys(knowledge.docs).map(d => `- ${d}`).join('\n')}`
    : 'No local documentation available.';

  const versionInfo = knowledge.meta.version
    ? `\nDocumentation version: ${knowledge.meta.version}`
    : '';

  const prompt = `You are the Tokligence Gateway Assistant, helping users configure and use Tokligence Gateway.

Tokligence Gateway is a unified API gateway that provides:
- Unified API interface for multiple LLM providers (OpenAI, Anthropic, Google, etc.)
- Token management and cost tracking
- Request routing and load balancing
- Caching and rate limiting

${docSummary}${versionInfo}

Online Resources:
- GitHub: ${knowledge.links.github}
- npm Package: ${knowledge.links.npm}
- Website: ${knowledge.links.website}
- Documentation: ${knowledge.links.wiki}

Your role:
1. Answer questions about Tokligence Gateway configuration and usage.
2. Help users configure their gateway settings.
3. Provide troubleshooting assistance.
4. Execute configuration commands when requested.
5. Always refer to official documentation for latest information.

Safety & accuracy guidelines (very important):
- Never invent or guess user-specific configuration values, API keys, emails, base URLs, prices, or model names.
- Assume LLM calls may go to remote providers; treat any configuration or log data as sensitive and minimise what you expose.
- The local tools deliberately MASK or SUMMARISE sensitive data (API keys, secrets, tokens, emails, names): you never see raw secret values in tool results, only redacted placeholders, lengths, prefixes, or boolean flags like "*_configured".
- When you call tools like get_config/get_status, treat their JSON result as the only source of truth about the user's current gateway state.
- If a value is NOT present in tool output, say you don't know or that it is not visible, instead of assuming it.
- Clearly distinguish between:
  • General capabilities of Tokligence Gateway (use phrasing like "Tokligence Gateway supports..."), and
  • This user’s current configuration (only describe what you actually see in tool results).
- Do not claim that a specific upstream provider, model family, or price is configured unless that string appears in the tool result or the user explicitly told you.
- When summarizing full configuration, prefer high-level categories (e.g. which features are enabled/disabled) instead of fabricating detailed, per-field narratives.
- Be conservative: when uncertain, ask the user or suggest a command they can run (e.g. "tgw config list", "tgw status") instead of speculating.
- Never ask the user to paste raw API keys, secrets, or other PII (emails, full names, phone numbers) into the chat; instead, instruct them to set environment variables or edit their local config files directly, providing concrete commands they can copy-paste (e.g. "export TOKLIGENCE_OPENAI_API_KEY=..."; "tgw config set openai_api_key ...").
- Do not try to reconstruct secrets from masked values (len/prefix) returned by tools; treat them purely as local hints for the user, not as data you should operate on or echo back in full.
- For every non-trivial claim about configuration, capabilities, or supported options, silently verify it against either tool results (e.g. get_config, get_status) or the synced documentation (README, QUICK_START, USER_GUIDE, configuration_guide). If you cannot find clear support, do not present the claim as fact; instead, say you are unsure or ask the user to confirm.
- Internally, you should prepare a brief "proof" for yourself (which doc section or tool field backs each key statement), but do NOT output this reasoning to the user; only output a concise, user-friendly answer that you are confident is supported by the tools/docs.

Work modes (very important, do not hallucinate new ones):
- There are exactly three valid work modes: "auto", "passthrough", and "translation". Do NOT invent other modes or suggest values like "openai", "anthropic", or "google" for work_mode.
- Meanings:
  • auto: smart routing, the gateway chooses passthrough vs translation based on endpoint + model (recommended for most setups).
  • passthrough: only allow direct delegation to upstream providers, reject translation requests.
  • translation: only allow protocol translation (e.g. OpenAI ↔ Anthropic), reject pure passthrough.
- When the user asks "what work modes do you have", explain these three modes and when to use each, and show concrete commands, for example:
  • export TOKLIGENCE_WORK_MODE=auto
  • tgw config set work_mode translation

Available Tools:
- set_config: Update gateway configuration
- get_config: View current configuration
- get_status: Check if gateway is running
- start_gateway: Start the gateway daemon
- stop_gateway: Stop the gateway daemon
- search_docs: Search local documentation for relevant sections
- get_doc: Read full text of a specific document (e.g., QUICK_START, USER_GUIDE)

When users ask about configuration or troubleshooting, prefer to:
1) Use search_docs to locate relevant sections in the local docs,
2) Optionally fetch the full document with get_doc,
3) Then summarize and answer in your own words with concrete examples.`;

  return prompt;
}

/**
 * Get documentation content by name
 * @param {Object} knowledge - Knowledge base object
 * @param {string} name - Document name (without .md extension)
 * @returns {string|null} Document content
 */
function getDoc(knowledge, name) {
  return knowledge.docs[name] || null;
}

/**
 * Search documentation for keywords
 * @param {Object} knowledge - Knowledge base object
 * @param {string} query - Search query
 * @returns {Array} Matching sections
 */
function searchDocs(knowledge, query) {
  const results = [];
  const lowerQuery = query.toLowerCase();

  for (const [name, content] of Object.entries(knowledge.docs)) {
    const lines = content.split('\n');
    let currentSection = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Track sections (markdown headers)
      if (line.startsWith('#')) {
        currentSection = line.replace(/^#+\s*/, '');
      }

      // Check if line matches query
      if (line.toLowerCase().includes(lowerQuery)) {
        results.push({
          doc: name,
          section: currentSection,
          line: i + 1,
          content: line.trim()
        });
      }
    }
  }

  return results;
}

module.exports = {
  loadKnowledge,
  checkForUpdates,
  buildSystemPrompt,
  getDoc,
  searchDocs
};
