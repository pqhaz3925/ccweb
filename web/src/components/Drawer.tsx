import type { SessionSummary } from '../hooks/useSession';
import { styles, colors } from '../styles/theme';

export function Drawer({ sessions, activeId, onSwitch, onNew, onClose }: {
  sessions: SessionSummary[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  return (
    <div style={styles.drawer}>
      <div style={styles.drawerHeader}>
        <span style={styles.drawerTitle}>CCWeb</span>
        <button style={styles.menuBtn} onClick={onClose}>X</button>
      </div>
      <div style={{ padding: '8px 16px' }}>
        <button
          style={{ ...styles.button('send'), width: '100%', borderRadius: '10px', fontSize: '14px', padding: '8px' }}
          onClick={() => { onNew(); onClose(); }}
        >
          + New Chat
        </button>
      </div>
      <div style={styles.sessionsList}>
        {sessions.map((s) => (
          <div
            key={s.id}
            style={styles.sessionItem(s.id === activeId)}
            onClick={() => { onSwitch(s.id); onClose(); }}
          >
            <div style={styles.sessionLabel}>{s.label}</div>
            {s.lastMessage && <div style={styles.sessionPreview}>{s.lastMessage}</div>}
          </div>
        ))}
        {sessions.length === 0 && (
          <div style={{ padding: '16px', color: colors.textFaint, fontSize: '14px', textAlign: 'center' }}>
            No chats yet
          </div>
        )}
      </div>
    </div>
  );
}
