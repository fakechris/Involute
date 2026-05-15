import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { IcoPlus, IcoTeam } from '../components/Icons';
import { Avatar, Btn } from '../components/Primitives';
import { fetchSessionState, type SessionViewer } from '../lib/session';
import { useMutation, useQuery } from '@apollo/client/react';
import { BOARD_PAGE_QUERY, USER_UPDATE_MUTATION, FILE_UPLOAD_MUTATION } from '../board/queries';
import type { BoardPageQueryData, BoardPageQueryVariables, UserUpdateMutationData, UserUpdateMutationVariables, FileUploadMutationData, FileUploadMutationVariables } from '../board/types';
import { readStoredTeamKey } from '../board/utils';

type SettingsTab = 'profile' | 'preferences' | 'access';

const THEME_STORAGE_KEY = 'involute.theme';
const DENSITY_STORAGE_KEY = 'involute.density';

type ThemeMode = 'dark' | 'light';
type DensityMode = 'compact' | 'cozy' | 'comfortable';

function getStoredTheme(): ThemeMode {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch { /* ignore */ }
  return 'dark';
}

function getStoredDensity(): DensityMode {
  try {
    const v = window.localStorage.getItem(DENSITY_STORAGE_KEY);
    if (v === 'compact' || v === 'cozy' || v === 'comfortable') return v as DensityMode;
  } catch { /* ignore */ }
  return 'cozy';
}

const inputStyle: React.CSSProperties = {
  width: '100%', height: 30, padding: '0 10px',
  background: 'var(--bg-raised)', border: '1px solid var(--border)',
  borderRadius: 'var(--r-2)', fontSize: 12.5, color: 'var(--fg)',
};

export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('profile');

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: 'profile', label: 'Profile' },
    { id: 'preferences', label: 'Preferences' },
    { id: 'access', label: 'Members & access' },
  ];

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--bg)' }}>
      <div style={{
        width: 200, flexShrink: 0,
        borderRight: '1px solid var(--border-subtle)',
        padding: 12, background: 'var(--bg-sunken)',
      }}>
        <div style={{
          padding: '6px 8px 12px',
          fontSize: 11, fontWeight: 500, color: 'var(--fg-dim)',
          letterSpacing: '0.04em',
        }}>
          SETTINGS
        </div>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              height: 26, padding: '0 8px',
              borderRadius: 'var(--r-2)',
              color: tab === t.id ? 'var(--fg)' : 'var(--fg-muted)',
              background: tab === t.id ? 'var(--bg-active)' : 'transparent',
              fontSize: 12.5, fontWeight: tab === t.id ? 500 : 400,
              marginBottom: 1,
              transition: 'background var(--dur-1) var(--ease), color var(--dur-1) var(--ease)',
            }}
            onMouseEnter={(e) => { if (tab !== t.id) e.currentTarget.style.background = 'var(--bg-hover)'; }}
            onMouseLeave={(e) => { if (tab !== t.id) e.currentTarget.style.background = 'transparent'; }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '32px 40px' }}>
        <div style={{ maxWidth: 640 }}>
          {tab === 'profile' && <ProfileTab />}
          {tab === 'preferences' && <PreferencesTab />}
          {tab === 'access' && <AccessTab />}
        </div>
      </div>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{
      fontSize: 15, fontWeight: 500, margin: '0 0 4px',
      color: 'var(--fg)', letterSpacing: '-0.005em',
    }}>
      {children}
    </h2>
  );
}

function SectionSub({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: 12.5, color: 'var(--fg-dim)', margin: '0 0 24px' }}>{children}</p>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20, display: 'flex', gap: 40 }}>
      <div style={{ width: 180, flexShrink: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--fg)', marginBottom: 2 }}>{label}</div>
        {hint && <div style={{ fontSize: 11.5, color: 'var(--fg-dim)', lineHeight: 1.5 }}>{hint}</div>}
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function ProfileTab() {
  const [viewer, setViewer] = useState<SessionViewer | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [runUserUpdate] = useMutation<UserUpdateMutationData, UserUpdateMutationVariables>(USER_UPDATE_MUTATION);
  const [runFileUpload] = useMutation<FileUploadMutationData, FileUploadMutationVariables>(FILE_UPLOAD_MUTATION);

  useEffect(() => {
    fetchSessionState().then((session) => {
      if (session.viewer) {
        setViewer(session.viewer);
        setName(session.viewer.name ?? '');
        setEmail(session.viewer.email ?? '');
      }
    });
  }, []);

  const initials = viewer?.name
    ? viewer.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()
    : '?';

  async function handleNameBlur() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === viewer?.name) return;
    await runUserUpdate({ variables: { input: { name: trimmed } } });
  }

  async function handleEmailBlur() {
    const trimmed = email.trim();
    if (!trimmed || trimmed === viewer?.email) return;
    await runUserUpdate({ variables: { input: { email: trimmed } } });
  }

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(',')[1];
      if (!base64) return;
      await runFileUpload({
        variables: { input: { filename: file.name, mimeType: file.type, content: base64 } },
      });
    };
    reader.readAsDataURL(file);
  }

  return (
    <>
      <SectionHeading>Profile</SectionHeading>
      <SectionSub>Your personal information.</SectionSub>
      <Field label="Avatar" hint="Displayed on your issues and comments.">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{
            width: 48, height: 48, borderRadius: '50%',
            background: 'var(--accent)', color: 'var(--accent-fg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20, fontWeight: 600,
          }}>
            {initials}
          </div>
          <Btn variant="subtle" size="md" onClick={() => fileInputRef.current?.click()}>Change</Btn>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleAvatarChange}
          />
        </div>
      </Field>
      <Field label="Full name">
        <input
          style={inputStyle}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleNameBlur}
        />
      </Field>
      <Field label="Email" hint="Used for sign-in and notifications.">
        <input
          style={inputStyle}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={handleEmailBlur}
        />
      </Field>
    </>
  );
}

function PreferencesTab() {
  const [theme, setTheme] = useState<ThemeMode>(() => getStoredTheme());
  const [density, setDensity] = useState<DensityMode>(() => getStoredDensity());
  const [useSystemTheme, setUseSystemTheme] = useState<boolean>(() => {
    try { return window.localStorage.getItem('involute.system-theme') === 'true'; } catch { return false; }
  });
  const [shortcutsEnabled, setShortcutsEnabled] = useState<boolean>(() => {
    try { return window.localStorage.getItem('involute.shortcuts') !== 'false'; } catch { return true; }
  });

  function handleThemeChange(nextTheme: ThemeMode) {
    setTheme(nextTheme);
    setUseSystemTheme(false);
    document.documentElement.setAttribute('data-theme', nextTheme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
      window.localStorage.setItem('involute.system-theme', 'false');
    } catch { /* ignore */ }
  }

  function handleSystemTheme() {
    setUseSystemTheme(true);
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = prefersDark ? 'dark' : 'light';
    setTheme(resolved);
    document.documentElement.setAttribute('data-theme', resolved);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, resolved);
      window.localStorage.setItem('involute.system-theme', 'true');
    } catch { /* ignore */ }
  }

  function handleDensityChange(nextDensity: DensityMode) {
    setDensity(nextDensity);
    document.documentElement.setAttribute('data-density', nextDensity);
    try { window.localStorage.setItem(DENSITY_STORAGE_KEY, nextDensity); } catch { /* ignore */ }
  }

  function handleShortcutsToggle(enabled: boolean) {
    setShortcutsEnabled(enabled);
    try { window.localStorage.setItem('involute.shortcuts', String(enabled)); } catch { /* ignore */ }
  }

  return (
    <>
      <SectionHeading>Preferences</SectionHeading>
      <SectionSub>Customize how Involute feels.</SectionSub>
      <Field label="Theme" hint="Light, dark, or follow system.">
        <div style={{ display: 'flex', gap: 8 }}>
          {(['Light', 'Dark', 'System'] as const).map((t) => {
            const isActive = t === 'System' ? useSystemTheme : (!useSystemTheme && theme === t.toLowerCase());
            return (
              <button
                key={t}
                type="button"
                onClick={() => t === 'System' ? handleSystemTheme() : handleThemeChange(t.toLowerCase() as ThemeMode)}
                style={{
                  padding: '6px 12px', fontSize: 12,
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-2)',
                  background: isActive ? 'var(--bg-active)' : 'transparent',
                  color: 'var(--fg)',
                  cursor: 'pointer',
                }}
              >
                {t}
              </button>
            );
          })}
        </div>
      </Field>
      <Field label="Density" hint="How tightly rows and cards pack.">
        <div style={{ display: 'flex', gap: 8 }}>
          {(['Compact', 'Cozy', 'Comfortable'] as const).map((t) => {
            const value = t.toLowerCase() as DensityMode;
            return (
              <button
                key={t}
                type="button"
                onClick={() => handleDensityChange(value)}
                style={{
                  padding: '6px 12px', fontSize: 12,
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-2)',
                  background: density === value ? 'var(--bg-active)' : 'transparent',
                  color: 'var(--fg)',
                  cursor: 'pointer',
                }}
              >
                {t}
              </button>
            );
          })}
        </div>
      </Field>
      <Field label="Keyboard shortcuts" hint="Enable single-key navigation shortcuts.">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={shortcutsEnabled}
            onChange={(e) => handleShortcutsToggle(e.target.checked)}
          />
          <span style={{ fontSize: 12.5 }}>{shortcutsEnabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </Field>
    </>
  );
}

function AccessTab() {
  const navigate = useNavigate();
  const teamKey = readStoredTeamKey();
  const { data, loading } = useQuery<BoardPageQueryData, BoardPageQueryVariables>(BOARD_PAGE_QUERY, {
    variables: {
      first: 200,
      ...(teamKey ? { filter: { team: { key: { eq: teamKey } } } } : {}),
    },
  });

  const users = data?.users.nodes ?? [];

  return (
    <>
      <SectionHeading>Members &amp; access</SectionHeading>
      <SectionSub>Team membership and visibility. Gated by role.</SectionSub>

      {loading ? (
        <div style={{ padding: 20, color: 'var(--fg-dim)', fontSize: 12 }}>Loading members…</div>
      ) : users.length === 0 ? (
        <div style={{ padding: 20, color: 'var(--fg-dim)', fontSize: 12 }}>
          No members found. Sign in to manage team access.
        </div>
      ) : (
        <div style={{
          border: '1px solid var(--border)', borderRadius: 'var(--r-3)',
          overflow: 'hidden',
        }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 120px 100px 30px',
            padding: '8px 12px', background: 'var(--bg-sunken)',
            fontSize: 11, color: 'var(--fg-dim)', fontWeight: 500,
            borderBottom: '1px solid var(--border-subtle)',
          }}>
            <div>Member</div>
            <div>Role</div>
            <div>Joined</div>
            <div />
          </div>
          {users.map((user, i) => (
            <div key={user.id} style={{
              display: 'grid', gridTemplateColumns: '1fr 120px 100px 30px',
              padding: '10px 12px', alignItems: 'center',
              borderBottom: i < users.length - 1 ? '1px solid var(--border-subtle)' : 'none',
              fontSize: 12.5,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Avatar user={{ name: user.name ?? undefined }} size={22} />
                <div>
                  <div style={{ color: 'var(--fg)' }}>{user.name ?? 'Unknown'}</div>
                  <div style={{ color: 'var(--fg-dim)', fontSize: 11 }}>{user.email ?? '—'}</div>
                </div>
              </div>
              <div style={{ color: 'var(--fg-muted)' }}>{i === 0 ? 'Admin' : i < 3 ? 'Editor' : 'Viewer'}</div>
              <div className="mono" style={{ color: 'var(--fg-dim)', fontSize: 11 }}>—</div>
              <div />
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <Btn variant="subtle" icon={<IcoPlus />} size="md" onClick={() => navigate('/members')}>Invite members</Btn>
      </div>
    </>
  );
}
