import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const CLAUDE_DIR = join(homedir(), '.claude');
const SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json');
const PLUGINS_DIR = join(CLAUDE_DIR, 'plugins');
const MARKETPLACES_DIR = join(PLUGINS_DIR, 'marketplaces');
const INSTALLED_PLUGINS_FILE = join(PLUGINS_DIR, 'installed_plugins.json');
const CACHE_DIR = join(PLUGINS_DIR, 'cache');

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ClaudeSettings {
  model?: string;
  enabledPlugins?: Record<string, boolean>;
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

export interface ProjectMcpConfig {
  mcpServers?: Record<string, McpServerConfig>;
}

export interface MarketplacePlugin {
  name: string;
  description: string;
  category?: string;
  version?: string;
  author?: { name: string; email?: string };
  homepage?: string;
  source: string | { source: string; url?: string; repo?: string };
  tags?: string[];
  marketplace: string; // which marketplace it belongs to
}

export interface InstalledPluginInfo {
  scope: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
}

/** Read ~/.claude/settings.json */
export function getClaudeSettings(): ClaudeSettings {
  if (!existsSync(SETTINGS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

/** Write ~/.claude/settings.json */
export function saveClaudeSettings(settings: ClaudeSettings): void {
  mkdirSync(CLAUDE_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
}

/** Read project .mcp.json */
export function getProjectMcp(projectPath: string): ProjectMcpConfig {
  const file = resolve(projectPath, '.mcp.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

/** Write project .mcp.json */
export function saveProjectMcp(projectPath: string, config: ProjectMcpConfig): void {
  const file = resolve(projectPath, '.mcp.json');
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

/** Read installed_plugins.json */
function getInstalledPlugins(): Record<string, InstalledPluginInfo[]> {
  if (!existsSync(INSTALLED_PLUGINS_FILE)) return {};
  try {
    const data = JSON.parse(readFileSync(INSTALLED_PLUGINS_FILE, 'utf-8'));
    return data.plugins ?? {};
  } catch {
    return {};
  }
}

/** Read all marketplace catalogs dynamically from ~/.claude/plugins/marketplaces/ */
function loadMarketplacePlugins(): MarketplacePlugin[] {
  const plugins: MarketplacePlugin[] = [];
  if (!existsSync(MARKETPLACES_DIR)) return plugins;

  try {
    const marketplaces = readdirSync(MARKETPLACES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const mkt of marketplaces) {
      const manifestPath = join(MARKETPLACES_DIR, mkt, '.claude-plugin', 'marketplace.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        if (Array.isArray(manifest.plugins)) {
          for (const p of manifest.plugins) {
            plugins.push({ ...p, marketplace: mkt });
          }
        }
      } catch { /* skip broken manifests */ }
    }
  } catch { /* skip if dir unreadable */ }

  return plugins;
}

/** Get combined view of all plugins, MCP servers, and marketplace catalog */
export function getMcpStatus(projectPath: string) {
  const settings = getClaudeSettings();
  const projectMcp = getProjectMcp(projectPath);
  const installed = getInstalledPlugins();
  const catalog = loadMarketplacePlugins();

  return {
    enabledPlugins: settings.enabledPlugins ?? {},
    installedPlugins: installed,
    catalog,
    globalMcp: settings.mcpServers ?? {},
    projectMcp: projectMcp.mcpServers ?? {},
    model: settings.model ?? null,
  };
}

/** Toggle a plugin on/off in settings */
export function togglePlugin(pluginId: string, enabled: boolean): void {
  const settings = getClaudeSettings();
  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  settings.enabledPlugins[pluginId] = enabled;
  saveClaudeSettings(settings);
}

/** Add/remove a global MCP server */
export function setGlobalMcpServer(name: string, config: McpServerConfig | null): void {
  const settings = getClaudeSettings();
  if (!settings.mcpServers) settings.mcpServers = {};
  if (config === null) {
    delete settings.mcpServers[name];
  } else {
    settings.mcpServers[name] = config;
  }
  saveClaudeSettings(settings);
}

/** Add/remove a project MCP server */
export function setProjectMcpServer(projectPath: string, name: string, config: McpServerConfig | null): void {
  const mcp = getProjectMcp(projectPath);
  if (!mcp.mcpServers) mcp.mcpServers = {};
  if (config === null) {
    delete mcp.mcpServers[name];
  } else {
    mcp.mcpServers[name] = config;
  }
  saveProjectMcp(projectPath, mcp);
}

// ─── Plugin Installation ─────────────────────────────────────

function saveInstalledPlugins(data: { version: number; plugins: Record<string, InstalledPluginInfo[]> }): void {
  mkdirSync(PLUGINS_DIR, { recursive: true });
  writeFileSync(INSTALLED_PLUGINS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function getInstalledPluginsRaw(): { version: number; plugins: Record<string, InstalledPluginInfo[]> } {
  if (!existsSync(INSTALLED_PLUGINS_FILE)) return { version: 2, plugins: {} };
  try {
    return JSON.parse(readFileSync(INSTALLED_PLUGINS_FILE, 'utf-8'));
  } catch {
    return { version: 2, plugins: {} };
  }
}

/** Find a plugin in any marketplace by name */
function findPluginInMarketplace(pluginName: string): { plugin: MarketplacePlugin; marketplaceDir: string } | null {
  if (!existsSync(MARKETPLACES_DIR)) return null;
  const marketplaces = readdirSync(MARKETPLACES_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
  for (const mkt of marketplaces) {
    const manifestPath = join(MARKETPLACES_DIR, mkt.name, '.claude-plugin', 'marketplace.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (Array.isArray(manifest.plugins)) {
        const found = manifest.plugins.find((p: MarketplacePlugin) => p.name === pluginName);
        if (found) return { plugin: { ...found, marketplace: mkt.name }, marketplaceDir: join(MARKETPLACES_DIR, mkt.name) };
      }
    } catch { /* skip */ }
  }
  return null;
}

/** Install a plugin from marketplace */
export function installPlugin(pluginName: string, _marketplace?: string): { success: boolean; error?: string; pluginId?: string } {
  const found = findPluginInMarketplace(pluginName);
  if (!found) return { success: false, error: `Plugin "${pluginName}" not found in any marketplace` };

  const { plugin, marketplaceDir } = found;
  const mktName = plugin.marketplace;
  const pluginId = `${pluginName}@${mktName}`;
  const version = plugin.version ?? 'latest';
  const installPath = join(CACHE_DIR, mktName, pluginName, version);

  // Already installed?
  const data = getInstalledPluginsRaw();
  if (data.plugins[pluginId]?.length) {
    return { success: true, pluginId }; // already installed
  }

  mkdirSync(installPath, { recursive: true });

  try {
    const source = plugin.source;

    if (typeof source === 'string' && source.startsWith('./')) {
      // Local marketplace plugin — copy from marketplace dir
      const srcDir = resolve(marketplaceDir, source);
      if (!existsSync(srcDir)) return { success: false, error: `Source dir not found: ${srcDir}` };
      cpSync(srcDir, installPath, { recursive: true });
    } else if (typeof source === 'object' && source.source === 'url' && source.url) {
      // Git clone
      const url = source.url;
      execSync(`git clone --depth 1 "${url}" "${installPath}"`, { timeout: 60000, stdio: 'pipe' });
    } else if (typeof source === 'object' && source.source === 'github' && source.repo) {
      // GitHub repo
      const url = `https://github.com/${source.repo}.git`;
      execSync(`git clone --depth 1 "${url}" "${installPath}"`, { timeout: 60000, stdio: 'pipe' });
    } else {
      return { success: false, error: `Unknown source type for plugin "${pluginName}"` };
    }

    // Write plugin.json if missing
    const pluginJsonDir = join(installPath, '.claude-plugin');
    const pluginJsonPath = join(pluginJsonDir, 'plugin.json');
    if (!existsSync(pluginJsonPath)) {
      mkdirSync(pluginJsonDir, { recursive: true });
      writeFileSync(pluginJsonPath, JSON.stringify({
        name: plugin.name,
        description: plugin.description,
        version,
        author: plugin.author,
      }, null, 2) + '\n');
    }

    // Update installed_plugins.json
    data.plugins[pluginId] = [{
      scope: 'user',
      installPath,
      version,
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    }];
    saveInstalledPlugins(data);

    return { success: true, pluginId };
  } catch (err) {
    // Cleanup on failure
    try { rmSync(installPath, { recursive: true, force: true }); } catch {}
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Uninstall a plugin */
export function uninstallPlugin(pluginId: string): { success: boolean; error?: string } {
  const data = getInstalledPluginsRaw();
  const entries = data.plugins[pluginId];
  if (!entries?.length) return { success: false, error: `Plugin "${pluginId}" not installed` };

  // Remove from disk
  for (const entry of entries) {
    try { rmSync(entry.installPath, { recursive: true, force: true }); } catch {}
  }

  // Remove from installed_plugins.json
  delete data.plugins[pluginId];
  saveInstalledPlugins(data);

  // Remove from enabled plugins in settings
  const settings = getClaudeSettings();
  if (settings.enabledPlugins?.[pluginId] !== undefined) {
    delete settings.enabledPlugins[pluginId];
    saveClaudeSettings(settings);
  }

  return { success: true };
}

// ─── Skills ───────────────────────────────────────────────────

export interface SkillInfo {
  name: string;
  scope: 'project' | 'global';
  description?: string;
  allowedTools?: string[];
  whenToUse?: string;
  argumentHint?: string;
  context?: string;
  content: string;
}

function parseSkillMd(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };
  const fm: Record<string, unknown> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      fm[key] = val;
    }
  }
  return { frontmatter: fm, body: match[2] };
}

function loadSkillsFromDir(dir: string, scope: 'project' | 'global'): SkillInfo[] {
  if (!existsSync(dir)) return [];
  const skills: SkillInfo[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const entry of entries) {
      const skillFile = join(dir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      try {
        const raw = readFileSync(skillFile, 'utf-8');
        const { frontmatter, body } = parseSkillMd(raw);
        skills.push({
          name: (frontmatter.name as string) ?? entry.name,
          scope,
          description: frontmatter.description as string | undefined,
          allowedTools: frontmatter['allowed-tools'] as string[] | undefined,
          whenToUse: frontmatter.when_to_use as string | undefined,
          argumentHint: frontmatter['argument-hint'] as string | undefined,
          context: frontmatter.context as string | undefined,
          content: body.trim(),
        });
      } catch { /* skip broken skill */ }
    }
  } catch { /* skip unreadable dir */ }
  return skills;
}

/** List all skills (project + global) */
export function getSkills(projectPath: string): SkillInfo[] {
  const projectSkills = loadSkillsFromDir(join(projectPath, '.claude', 'skills'), 'project');
  const globalSkills = loadSkillsFromDir(join(CLAUDE_DIR, 'skills'), 'global');
  return [...projectSkills, ...globalSkills];
}

// ─── Memory / CLAUDE.md ──────────────────────────────────────

export interface MemoryData {
  projectClaudeMd: string | null;
  projectDotClaudeMd: string | null;
  projectLocalMd: string | null;
  globalClaudeMd: string | null;
  memoryMd: string | null;
  rules: { name: string; content: string }[];
}

/** Read all memory/context files for a project */
export function getMemory(projectPath: string): MemoryData {
  const read = (p: string) => {
    if (!existsSync(p)) return null;
    try { return readFileSync(p, 'utf-8'); } catch { return null; }
  };

  const rules: { name: string; content: string }[] = [];
  const rulesDir = join(projectPath, '.claude', 'rules');
  if (existsSync(rulesDir)) {
    try {
      for (const f of readdirSync(rulesDir).filter(f => f.endsWith('.md'))) {
        const content = read(join(rulesDir, f));
        if (content !== null) rules.push({ name: f, content });
      }
    } catch { /* skip */ }
  }

  return {
    projectClaudeMd: read(join(projectPath, 'CLAUDE.md')),
    projectDotClaudeMd: read(join(projectPath, '.claude', 'CLAUDE.md')),
    projectLocalMd: read(join(projectPath, 'CLAUDE.local.md')),
    globalClaudeMd: read(join(CLAUDE_DIR, 'CLAUDE.md')),
    memoryMd: read(join(CLAUDE_DIR, 'memory', 'MEMORY.md')),
    rules,
  };
}

/** Write to a specific memory file */
export function saveMemoryFile(projectPath: string, fileKey: string, content: string): void {
  const paths: Record<string, string> = {
    projectClaudeMd: join(projectPath, 'CLAUDE.md'),
    projectDotClaudeMd: join(projectPath, '.claude', 'CLAUDE.md'),
    projectLocalMd: join(projectPath, 'CLAUDE.local.md'),
    globalClaudeMd: join(CLAUDE_DIR, 'CLAUDE.md'),
    memoryMd: join(CLAUDE_DIR, 'memory', 'MEMORY.md'),
  };
  const filePath = paths[fileKey];
  if (!filePath) throw new Error(`Unknown memory file: ${fileKey}`);
  mkdirSync(resolve(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content);
}

// ─── Permissions ─────────────────────────────────────────────

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

export function getPermissionMode(): PermissionMode {
  const settings = getClaudeSettings();
  const perms = settings.permissions as Record<string, unknown> | undefined;
  return (perms?.defaultMode as PermissionMode) ?? 'default';
}

export function setPermissionMode(mode: PermissionMode): void {
  const settings = getClaudeSettings();
  if (!settings.permissions) settings.permissions = {};
  (settings.permissions as Record<string, unknown>).defaultMode = mode;
  saveClaudeSettings(settings);
}
