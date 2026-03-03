import { useState, useEffect } from 'react';
import { colors, fonts } from '../styles/theme';

// ─── Types ───────────────────────────────────────────────────

type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type CatalogPlugin = {
  name: string;
  description: string;
  category?: string;
  marketplace: string;
  homepage?: string;
  tags?: string[];
};

type InstalledPluginInfo = {
  scope: string;
  version: string;
  installedAt: string;
};

type McpData = {
  enabledPlugins: Record<string, boolean>;
  installedPlugins: Record<string, InstalledPluginInfo[]>;
  catalog: CatalogPlugin[];
  globalMcp: Record<string, McpServerConfig>;
  projectMcp: Record<string, McpServerConfig>;
  model: string | null;
} | null;

type SkillInfo = {
  name: string;
  scope: 'project' | 'global';
  description?: string;
  whenToUse?: string;
  argumentHint?: string;
  context?: string;
  content: string;
};

type MemoryData = {
  projectClaudeMd: string | null;
  projectDotClaudeMd: string | null;
  projectLocalMd: string | null;
  globalClaudeMd: string | null;
  memoryMd: string | null;
  rules: { name: string; content: string }[];
};

type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

type Tab = 'plugins' | 'market' | 'skills' | 'memory' | 'mcp' | 'perms';

// ─── Styles ─────────────────────────────────────────────────

const S = {
  overlay: {
    position: 'fixed' as const, inset: 0, backgroundColor: 'rgba(0,0,0,0.7)',
    zIndex: 200, display: 'flex', alignItems: 'stretch', justifyContent: 'center',
  },
  modal: {
    width: '100%', maxWidth: '600px', height: '100dvh',
    backgroundColor: colors.bg, display: 'flex', flexDirection: 'column' as const,
    fontFamily: fonts.system,
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 20px', borderBottom: `1px solid ${colors.border}`, flexShrink: 0,
  },
  title: {
    fontSize: '18px', fontWeight: 700, color: colors.white,
    letterSpacing: '-0.3px',
  },
  closeBtn: {
    width: 32, height: 32, borderRadius: '8px', border: `1px solid ${colors.border2}`,
    backgroundColor: 'transparent', color: colors.textMuted, fontSize: '16px',
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  tabs: {
    display: 'flex', gap: '2px', padding: '8px 16px',
    borderBottom: `1px solid ${colors.border}`, overflowX: 'auto' as const,
    flexShrink: 0,
  },
  tab: (active: boolean) => ({
    padding: '6px 14px', borderRadius: '8px', border: 'none', cursor: 'pointer',
    fontSize: '13px', fontWeight: 500,
    backgroundColor: active ? colors.accent : 'transparent',
    color: active ? colors.white : colors.textDim,
    whiteSpace: 'nowrap' as const, transition: 'all 0.15s',
  }),
  body: {
    flex: 1, overflowY: 'auto' as const, padding: '0',
  },
  section: {
    padding: '14px 20px 8px', fontSize: '11px', fontWeight: 600,
    color: colors.textMuted, textTransform: 'uppercase' as const,
    letterSpacing: '0.8px',
  },
  card: {
    padding: '12px 20px', borderBottom: `1px solid ${colors.surface2}`,
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12,
  },
  cardTitle: {
    fontSize: '14px', fontWeight: 500, color: colors.text,
  },
  cardDesc: {
    fontSize: '13px', color: colors.textDim, marginTop: '3px',
    lineHeight: '1.45',
  },
  badge: (bg: string, fg: string) => ({
    fontSize: '10px', padding: '2px 7px', borderRadius: '6px',
    backgroundColor: bg, color: fg, fontWeight: 600,
  }),
  pill: (active: boolean, color: string) => ({
    padding: '6px 14px', borderRadius: '14px', border: 'none', cursor: 'pointer',
    fontSize: '12px', fontWeight: 600, flexShrink: 0,
    backgroundColor: active ? color : colors.border2,
    color: colors.white, transition: 'background-color 0.15s',
  }),
  input: {
    width: '100%', padding: '10px 14px', borderRadius: '10px',
    border: `1px solid ${colors.border2}`, backgroundColor: colors.surface2,
    color: colors.text, fontSize: '14px', outline: 'none',
    fontFamily: fonts.system,
  },
  empty: {
    padding: '32px 20px', color: colors.textFaint, fontSize: '14px',
    textAlign: 'center' as const,
  },
  footer: {
    padding: '10px 20px', fontSize: '12px', color: colors.textFaint,
    textAlign: 'center' as const, borderTop: `1px solid ${colors.surface2}`,
    flexShrink: 0,
  },
};

const CATEGORY_COLORS: Record<string, string> = {
  development: '#0a84ff', productivity: '#34c759', security: '#ff9f0a',
  design: '#bf5af2', database: '#ff375f', testing: '#64d2ff',
  monitoring: '#ffd60a', learning: '#30d158', deployment: '#5e5ce6',
};

function pluginId(name: string, marketplace: string) {
  return `${name}@${marketplace}`;
}

// ─── Plugin Card ─────────────────────────────────────────────

function PluginCard({ plugin, installed, enabled, onToggle }: {
  plugin: CatalogPlugin;
  installed: boolean;
  enabled: boolean;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  const id = pluginId(plugin.name, plugin.marketplace);
  const catColor = CATEGORY_COLORS[plugin.category ?? ''] ?? '#555';
  return (
    <div style={S.card}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={S.cardTitle}>{plugin.name}</span>
          {plugin.category && (
            <span style={S.badge(catColor + '22', catColor)}>{plugin.category}</span>
          )}
        </div>
        <div style={{
          ...S.cardDesc, overflow: 'hidden',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any,
        }}>
          {plugin.description}
        </div>
      </div>
      <button
        style={S.pill(
          !installed ? true : enabled,
          !installed ? colors.accent : colors.green,
        )}
        onClick={() => {
          if (!installed) onToggle(id, true);
          else onToggle(id, !enabled);
        }}
      >
        {!installed ? 'Install' : enabled ? 'ON' : 'OFF'}
      </button>
    </div>
  );
}

// ─── MCP Servers ─────────────────────────────────────────────

function McpServersSection({ servers, onRemove }: {
  servers: Record<string, McpServerConfig>;
  onRemove?: (name: string) => void;
}) {
  const entries = Object.entries(servers);
  if (entries.length === 0) return <div style={S.empty}>No MCP servers configured</div>;
  return (
    <>
      {entries.map(([name, config]) => (
        <div key={name} style={S.card}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '14px', color: colors.purple, fontWeight: 600 }}>{name}</div>
            <div style={{ fontSize: '12px', color: colors.textFaint, marginTop: '3px', fontFamily: fonts.mono }}>
              {config.command} {config.args?.join(' ') ?? ''}
            </div>
          </div>
          {onRemove && (
            <button
              style={{
                padding: '5px 12px', borderRadius: '8px', border: `1px solid ${colors.red}33`,
                backgroundColor: colors.red + '11', color: colors.red, fontSize: '12px',
                cursor: 'pointer', fontWeight: 500,
              }}
              onClick={() => onRemove(name)}
            >
              Remove
            </button>
          )}
        </div>
      ))}
    </>
  );
}

function AddMcpServerForm({ onAdd }: { onAdd: (name: string, config: McpServerConfig) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');

  if (!open) {
    return (
      <div style={{ padding: '12px 20px' }}>
        <button
          style={{
            width: '100%', padding: '10px', borderRadius: '10px',
            border: `1px dashed ${colors.border2}`, backgroundColor: 'transparent',
            color: colors.textMuted, fontSize: '14px', cursor: 'pointer',
          }}
          onClick={() => setOpen(true)}
        >
          + Add MCP Server
        </button>
      </div>
    );
  }

  const handleSubmit = () => {
    if (!name.trim() || !command.trim()) return;
    const cfg: McpServerConfig = { command: command.trim() };
    if (args.trim()) cfg.args = args.trim().split(/\s+/);
    onAdd(name.trim(), cfg);
    setName(''); setCommand(''); setArgs(''); setOpen(false);
  };

  return (
    <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <input style={S.input} placeholder="Server name" value={name} onChange={(e) => setName(e.target.value)} />
      <input style={S.input} placeholder="Command (e.g. npx)" value={command} onChange={(e) => setCommand(e.target.value)} />
      <input style={S.input} placeholder="Args (space separated)" value={args} onChange={(e) => setArgs(e.target.value)} />
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          style={{
            flex: 1, padding: '10px', borderRadius: '10px', border: 'none',
            backgroundColor: colors.accent, color: colors.white,
            fontSize: '14px', fontWeight: 600, cursor: 'pointer',
          }}
          onClick={handleSubmit}
        >Add</button>
        <button
          style={{
            padding: '10px 20px', borderRadius: '10px', border: `1px solid ${colors.border2}`,
            backgroundColor: 'transparent', color: colors.textMuted,
            fontSize: '14px', cursor: 'pointer',
          }}
          onClick={() => setOpen(false)}
        >Cancel</button>
      </div>
    </div>
  );
}

// ─── Skills Tab ──────────────────────────────────────────────

function SkillsTab({ skills }: { skills: SkillInfo[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (skills.length === 0) return <div style={S.empty}>No skills found</div>;

  return (
    <>
      {skills.map((skill) => {
        const key = `${skill.scope}:${skill.name}`;
        const isOpen = expanded === key;
        return (
          <div key={key} style={{ borderBottom: `1px solid ${colors.surface2}` }}>
            <div
              style={{ ...S.card, cursor: 'pointer' }}
              onClick={() => setExpanded(isOpen ? null : key)}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '15px', color: colors.accent, fontWeight: 600 }}>
                    /{skill.name}
                  </span>
                  <span style={S.badge(
                    skill.scope === 'project' ? colors.accent + '22' : colors.purple + '22',
                    skill.scope === 'project' ? colors.accent : colors.purple,
                  )}>
                    {skill.scope}
                  </span>
                  {skill.context === 'fork' && (
                    <span style={S.badge(colors.orange + '22', colors.orange)}>fork</span>
                  )}
                </div>
                {skill.description && (
                  <div style={{
                    ...S.cardDesc,
                    overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: isOpen ? 'normal' : 'nowrap' as const,
                  }}>
                    {skill.description}
                  </div>
                )}
              </div>
              <span style={{ color: colors.textFaint, fontSize: '14px', flexShrink: 0 }}>
                {isOpen ? '\u25BC' : '\u25B6'}
              </span>
            </div>
            {isOpen && (
              <div style={{ padding: '0 20px 16px' }}>
                {skill.whenToUse && (
                  <div style={{ fontSize: '13px', color: colors.textMuted, marginBottom: 8 }}>
                    <b>When:</b> {skill.whenToUse}
                  </div>
                )}
                {skill.argumentHint && (
                  <div style={{ fontSize: '13px', color: colors.textMuted, marginBottom: 8 }}>
                    <b>Args:</b> <code style={{ color: colors.accent, fontFamily: fonts.mono }}>{skill.argumentHint}</code>
                  </div>
                )}
                <pre style={{
                  fontSize: '12px', color: colors.text, backgroundColor: colors.surface2,
                  padding: '12px 14px', borderRadius: '8px', overflow: 'auto',
                  maxHeight: '240px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  margin: 0, fontFamily: fonts.mono, lineHeight: '1.5',
                }}>
                  {skill.content.slice(0, 1500)}{skill.content.length > 1500 ? '\n...' : ''}
                </pre>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

// ─── Memory Tab ──────────────────────────────────────────────

function MemoryTab({ memory, onSave }: {
  memory: MemoryData;
  onSave: (fileKey: string, content: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  const files: { key: string; label: string; content: string | null }[] = [
    { key: 'projectClaudeMd', label: 'CLAUDE.md (project root)', content: memory.projectClaudeMd },
    { key: 'projectDotClaudeMd', label: '.claude/CLAUDE.md', content: memory.projectDotClaudeMd },
    { key: 'projectLocalMd', label: 'CLAUDE.local.md', content: memory.projectLocalMd },
    { key: 'globalClaudeMd', label: '~/.claude/CLAUDE.md', content: memory.globalClaudeMd },
    { key: 'memoryMd', label: '~/.claude/memory/MEMORY.md', content: memory.memoryMd },
  ];

  const startEdit = (key: string, content: string | null) => {
    setEditing(key);
    setEditContent(content ?? '');
  };

  const saveEdit = (key: string) => {
    onSave(key, editContent);
    setEditing(null);
  };

  return (
    <>
      {files.map(({ key, label, content }) => (
        <div key={key} style={{ borderBottom: `1px solid ${colors.surface2}` }}>
          <div style={{
            padding: '12px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div>
              <span style={{ fontSize: '14px', fontWeight: 500, color: content !== null ? colors.text : colors.textFaint }}>
                {label}
              </span>
              {content !== null && (
                <span style={{ fontSize: '11px', color: colors.green, marginLeft: 10 }}>
                  {content.split('\n').length} lines
                </span>
              )}
            </div>
            {editing !== key && (
              <button
                style={{
                  padding: '4px 12px', borderRadius: '8px', border: `1px solid ${colors.border2}`,
                  backgroundColor: 'transparent', color: colors.accent,
                  fontSize: '12px', cursor: 'pointer', fontWeight: 500,
                }}
                onClick={() => startEdit(key, content)}
              >
                {content !== null ? 'Edit' : 'Create'}
              </button>
            )}
          </div>
          {editing === key && (
            <div style={{ padding: '0 20px 14px' }}>
              <textarea
                style={{
                  width: '100%', minHeight: '160px', padding: '12px 14px', borderRadius: '8px',
                  border: `1px solid ${colors.border2}`, backgroundColor: colors.surface2,
                  color: colors.text, fontSize: '13px', fontFamily: fonts.mono,
                  outline: 'none', resize: 'vertical', lineHeight: '1.5',
                }}
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  style={{
                    padding: '8px 20px', borderRadius: '8px', border: 'none',
                    backgroundColor: colors.green, color: colors.white,
                    fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                  }}
                  onClick={() => saveEdit(key)}
                >Save</button>
                <button
                  style={{
                    padding: '8px 20px', borderRadius: '8px', border: `1px solid ${colors.border2}`,
                    backgroundColor: 'transparent', color: colors.textMuted,
                    fontSize: '13px', cursor: 'pointer',
                  }}
                  onClick={() => setEditing(null)}
                >Cancel</button>
              </div>
            </div>
          )}
          {editing !== key && content !== null && (
            <pre style={{
              margin: '0 20px 12px', padding: '10px 14px', borderRadius: '8px',
              backgroundColor: colors.surface2, fontSize: '12px', color: colors.textDim,
              maxHeight: '100px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              fontFamily: fonts.mono, lineHeight: '1.5',
            }}>
              {content.slice(0, 600)}{content.length > 600 ? '\n...' : ''}
            </pre>
          )}
        </div>
      ))}
      {memory.rules.length > 0 && (
        <>
          <div style={S.section}>.claude/rules/</div>
          {memory.rules.map((r) => (
            <div key={r.name} style={{ padding: '8px 20px', borderBottom: `1px solid ${colors.surface2}` }}>
              <div style={{ fontSize: '14px', color: colors.purple, fontWeight: 600 }}>{r.name}</div>
              <pre style={{
                margin: '6px 0 0', padding: '8px 12px', borderRadius: '6px',
                backgroundColor: colors.surface2, fontSize: '12px', color: colors.textDim,
                maxHeight: '80px', overflow: 'auto', whiteSpace: 'pre-wrap',
                fontFamily: fonts.mono, lineHeight: '1.5',
              }}>
                {r.content.slice(0, 400)}{r.content.length > 400 ? '...' : ''}
              </pre>
            </div>
          ))}
        </>
      )}
    </>
  );
}

// ─── Permissions Tab ─────────────────────────────────────────

function PermissionsTab({ mode, onSetMode }: {
  mode: PermissionMode;
  onSetMode: (mode: PermissionMode) => void;
}) {
  const modes: { value: PermissionMode; label: string; desc: string; color: string }[] = [
    { value: 'default', label: 'Default', desc: 'Ask for approval on each tool use', color: colors.accent },
    { value: 'acceptEdits', label: 'Accept Edits', desc: 'Auto-approve file edits, ask for other tools', color: colors.orange },
    { value: 'bypassPermissions', label: 'YOLO', desc: 'Skip all permission checks', color: colors.red },
  ];

  return (
    <div>
      <div style={S.section}>Permission Mode</div>
      <div style={{ padding: '4px 20px 16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {modes.map((m) => (
          <div
            key={m.value}
            style={{
              padding: '14px 16px', cursor: 'pointer', borderRadius: '12px',
              backgroundColor: mode === m.value ? m.color + '15' : colors.surface2,
              border: `1.5px solid ${mode === m.value ? m.color + '55' : 'transparent'}`,
              display: 'flex', alignItems: 'center', gap: 14,
              transition: 'all 0.15s',
            }}
            onClick={() => onSetMode(m.value)}
          >
            <div style={{
              width: 20, height: 20, borderRadius: '50%',
              border: `2px solid ${mode === m.value ? m.color : colors.border2}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              {mode === m.value && (
                <div style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: m.color }} />
              )}
            </div>
            <div>
              <div style={{ fontSize: '15px', color: colors.text, fontWeight: 600 }}>{m.label}</div>
              <div style={{ fontSize: '13px', color: colors.textDim, marginTop: 2 }}>{m.desc}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={S.section}>Subagent Model</div>
      <div style={{ padding: '4px 20px 16px', fontSize: '13px', color: colors.textDim, lineHeight: '1.6' }}>
        Override model for subagents via{' '}
        <code style={{ color: colors.accent, fontFamily: fonts.mono, fontSize: '12px' }}>
          CLAUDE_CODE_SUBAGENT_MODEL
        </code>
        <br />
        Options: <b style={{ color: colors.text }}>sonnet</b> (default),{' '}
        <b style={{ color: colors.text }}>opus</b>,{' '}
        <b style={{ color: colors.text }}>haiku</b>,{' '}
        <b style={{ color: colors.text }}>inherit</b>
      </div>
    </div>
  );
}

// ─── Main Panel (fullscreen modal) ──────────────────────────

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [mcp, setMcp] = useState<McpData>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [memory, setMemory] = useState<MemoryData | null>(null);
  const [permMode, setPermMode] = useState<PermissionMode>('default');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('plugins');
  const [search, setSearch] = useState('');

  useEffect(() => {
    Promise.all([
      fetch('/api/mcp').then((r) => r.json()),
      fetch('/api/skills').then((r) => r.json()),
      fetch('/api/memory').then((r) => r.json()),
      fetch('/api/permissions').then((r) => r.json()),
    ])
      .then(([mcpData, skillsData, memoryData, permsData]) => {
        setMcp(mcpData);
        setSkills(skillsData);
        setMemory(memoryData);
        setPermMode(permsData.mode);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const togglePlugin = async (id: string, enabled: boolean) => {
    await fetch('/api/mcp/toggle-plugin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pluginId: id, enabled }),
    });
    setMcp((prev) => prev ? { ...prev, enabledPlugins: { ...prev.enabledPlugins, [id]: enabled } } : prev);
  };

  const addMcpServer = async (name: string, config: McpServerConfig) => {
    await fetch('/api/mcp/server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, config }),
    });
    setMcp((prev) => prev ? { ...prev, globalMcp: { ...prev.globalMcp, [name]: config } } : prev);
  };

  const removeMcpServer = async (name: string) => {
    await fetch('/api/mcp/server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, config: null }),
    });
    setMcp((prev) => {
      if (!prev) return prev;
      const updated = { ...prev.globalMcp };
      delete updated[name];
      return { ...prev, globalMcp: updated };
    });
  };

  const saveMemory = async (fileKey: string, content: string) => {
    await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileKey, content }),
    });
    const data = await fetch('/api/memory').then((r) => r.json());
    setMemory(data);
  };

  const changePermMode = async (mode: PermissionMode) => {
    await fetch('/api/permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    setPermMode(mode);
  };

  if (loading) return (
    <div style={S.overlay} onClick={onClose}>
      <div style={{ ...S.modal, alignItems: 'center', justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ color: colors.textMuted, fontSize: '15px' }}>Loading...</div>
      </div>
    </div>
  );

  const installedIds = mcp ? new Set(Object.keys(mcp.installedPlugins)) : new Set<string>();
  const installedCatalog = mcp?.catalog.filter(p => installedIds.has(pluginId(p.name, p.marketplace))) ?? [];
  const allCatalog = mcp?.catalog.filter(p => {
    if (!search) return true;
    const s = search.toLowerCase();
    return p.name.toLowerCase().includes(s) || p.description.toLowerCase().includes(s) || (p.category ?? '').toLowerCase().includes(s);
  }) ?? [];

  const tabs: { key: Tab; label: string }[] = [
    { key: 'plugins', label: `Plugins (${installedIds.size})` },
    { key: 'market', label: 'Market' },
    { key: 'skills', label: `Skills (${skills.length})` },
    { key: 'memory', label: 'Memory' },
    { key: 'mcp', label: 'MCP' },
    { key: 'perms', label: 'Perms' },
  ];

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={S.header}>
          <div>
            <div style={S.title}>Settings</div>
            {mcp?.model && (
              <div style={{ fontSize: '12px', color: colors.textDim, marginTop: 2 }}>
                Model: <span style={{ color: colors.accent, fontWeight: 500 }}>{mcp.model}</span>
              </div>
            )}
          </div>
          <button style={S.closeBtn} onClick={onClose}>{'\u2715'}</button>
        </div>

        {/* Tabs */}
        <div style={S.tabs}>
          {tabs.map(t => (
            <button key={t.key} style={S.tab(tab === t.key)} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={S.body}>
          {tab === 'plugins' && mcp && (
            <>
              {installedCatalog.length === 0 && <div style={S.empty}>No plugins installed</div>}
              {installedCatalog.map((p) => {
                const id = pluginId(p.name, p.marketplace);
                return (
                  <PluginCard key={id} plugin={p} installed enabled={mcp.enabledPlugins[id] === true} onToggle={togglePlugin} />
                );
              })}
              {Object.keys(mcp.installedPlugins)
                .filter(id => !installedCatalog.some(p => pluginId(p.name, p.marketplace) === id))
                .map(id => (
                  <div key={id} style={S.card}>
                    <div>
                      <div style={S.cardTitle}>{id}</div>
                      <div style={{ fontSize: '12px', color: colors.textDim }}>v{mcp.installedPlugins[id]?.[0]?.version}</div>
                    </div>
                    <button
                      style={S.pill(mcp.enabledPlugins[id] === true, colors.green)}
                      onClick={() => togglePlugin(id, mcp.enabledPlugins[id] !== true)}
                    >
                      {mcp.enabledPlugins[id] === true ? 'ON' : 'OFF'}
                    </button>
                  </div>
                ))
              }
            </>
          )}

          {tab === 'market' && mcp && (
            <>
              <div style={{ padding: '12px 20px' }}>
                <input
                  style={S.input}
                  placeholder="Search plugins..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {allCatalog.map((p) => {
                const id = pluginId(p.name, p.marketplace);
                return (
                  <PluginCard key={id} plugin={p} installed={installedIds.has(id)} enabled={mcp.enabledPlugins[id] === true} onToggle={togglePlugin} />
                );
              })}
              {allCatalog.length === 0 && <div style={S.empty}>No plugins match "{search}"</div>}
            </>
          )}

          {tab === 'skills' && <SkillsTab skills={skills} />}

          {tab === 'memory' && memory && <MemoryTab memory={memory} onSave={saveMemory} />}

          {tab === 'mcp' && mcp && (
            <>
              <div style={S.section}>Global MCP Servers</div>
              <McpServersSection servers={mcp.globalMcp} onRemove={removeMcpServer} />
              <AddMcpServerForm onAdd={addMcpServer} />
              {Object.keys(mcp.projectMcp).length > 0 && (
                <>
                  <div style={S.section}>Project MCP Servers</div>
                  <McpServersSection servers={mcp.projectMcp} />
                </>
              )}
            </>
          )}

          {tab === 'perms' && <PermissionsTab mode={permMode} onSetMode={changePermMode} />}
        </div>

        <div style={S.footer}>Changes apply on next session</div>
      </div>
    </div>
  );
}
