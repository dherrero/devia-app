import type { McpCatalogEntry } from '../../../types/devia';

/**
 * Embedded MCP catalog (#273). Phase 1 — no remote fetch.
 *
 * Each entry is a Devia-curated recommendation: command + args known
 * to work, optional required env keys the user fills in the modal,
 * and a default agent matrix. Adding a new entry is one PR to this
 * file — no runtime changes needed.
 *
 * Entries deliberately stay agnostic of the user's local environment;
 * the modal renders them as cards with an "Instalar" button. Heavy
 * lifting happens main-side via mcp:install.
 */
export const MCP_CATALOG: ReadonlyArray<McpCatalogEntry> = [
  {
    slug: 'context7',
    name: 'Context7',
    description: 'Live framework / library docs. Lets the agent fetch up-to-date docs by package name.',
    source: 'npm',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@latest'],
    docsUrl: 'https://context7.com',
  },
  {
    slug: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Anthropic\'s planning helper — extended reasoning before complex code changes.',
    source: 'npm',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
  {
    slug: 'filesystem',
    name: 'Filesystem MCP',
    description: 'Sandboxed file access scoped to a path you specify.',
    source: 'npm',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    slug: 'github',
    name: 'GitHub MCP',
    description: 'Read + write GitHub issues, PRs and code search. Requires a PAT with repo scope.',
    source: 'npm',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    requiredEnvKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
  },
  {
    slug: 'playwright',
    name: 'Playwright MCP',
    description: 'Browser automation. Lets the agent open pages, click, fill forms and take screenshots.',
    source: 'npm',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    docsUrl: 'https://playwright.dev/docs/mcp',
  },
  {
    slug: 'memory',
    name: 'Memory MCP',
    description: 'Persistent KV memory the agent can read/write across sessions.',
    source: 'npm',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    slug: 'fetch',
    name: 'Fetch MCP',
    description: 'HTTP fetch utility — pulls arbitrary URLs as markdown for the agent.',
    source: 'uvx',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    slug: 'git',
    name: 'Git MCP',
    description: 'Native git operations (log, blame, branches) scoped to a repo.',
    source: 'uvx',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', '.'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
  },
];
