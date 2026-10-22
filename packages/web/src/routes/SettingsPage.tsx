import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { IcoPlus, IcoTeam } from '../components/Icons';
import { Avatar, Btn } from '../components/Primitives';
import { Checkbox, Field, TextInput } from '../components/controls';
import { SettingsSectionHeader, SettingsShell } from '../components/SettingsShell';
import { AdminMembersTab, AdminSecurityTab, AdminTeamsTab } from './AdministrationTabs';
import { EmailNotificationsField, LabelsTab, ServerFeaturesTab, ServiceActorForm } from './WorkspaceSettingsTabs';
import { fetchSessionState, type SessionViewer } from '../lib/session';
import { useMutation, useQuery } from '@apollo/client/react';
import { BOARD_PAGE_QUERY, USER_UPDATE_MUTATION, FILE_UPLOAD_MUTATION } from '../board/queries';
import type { BoardPageQueryData, BoardPageQueryVariables, UserSummary, UserUpdateMutationData, UserUpdateMutationVariables, FileUploadMutationData, FileUploadMutationVariables } from '../board/types';
import { readStoredTeamKey } from '../board/utils';
import { ExtensionsTab } from './ExtensionsTab';

type SettingsTab = 'profile' | 'preferences' | 'extensions' | 'members' | 'teams' | 'security' | 'services' | 'labels' | 'features';

/** Settings → Administration (docs/permissions.md §7); the server refuses everyone else. */
const ADMIN_TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: 'members', label: 'Members' },
  { id: 'teams', label: 'Teams' },
  { id: 'security', label: 'Security' },
  { id: 'services', label: 'Service actors' },
  { id: 'labels', label: 'Labels' },
  { id: 'features', label: 'Server features' },
];

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

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void fetchSessionState()
      .then((session) => { if (!cancelled) setIsAdmin(session.viewer?.globalRole === 'ADMIN'); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const requested = searchParams.get('tab');
  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: 'profile', label: 'Profile' },
    { id: 'preferences', label: 'Preferences' },
    { id: 'extensions', label: 'Extensions' },
    ...(isAdmin ? ADMIN_TABS : []),
  ];
  const tab: SettingsTab = tabs.find((candidate) => candidate.id === requested)?.id ?? 'profile';
  const setTab = (next: SettingsTab) => setSearchParams(next === 'profile' ? {} : { tab: next }, { replace: true });

  const personalTabs = tabs.filter((t) => !ADMIN_TABS.some((admin) => admin.id === t.id));
  const adminTabs = tabs.filter((t) => ADMIN_TABS.some((admin) => admin.id === t.id));

  return (
    <SettingsShell
      navLabel="Settings sections"
      title="Settings"
      groups={[
        { items: personalTabs },
        ...(adminTabs.length > 0 ? [{ label: 'Administration', items: adminTabs }] : []),
      ]}
      active={tab}
      onSelect={setTab}
    >
      {tab === 'profile' && <ProfileTab />}
      {tab === 'preferences' && <PreferencesTab />}
      {tab === 'extensions' && <ExtensionsTab />}
      {tab === 'labels' && <LabelsTab />}
      {tab === 'members' && <AdminMembersTab />}
      {tab === 'teams' && <AdminTeamsTab />}
      {tab === 'security' && <AdminSecurityTab />}
      {tab === 'services' && <ServiceActorForm />}
      {tab === 'features' && <ServerFeaturesTab />}
    </SettingsShell>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <SettingsSectionHeader title={children} />;
}

function SectionSub({ children }: { children: React.ReactNode }) {
  return <p className="settings-section__sub">{children}</p>;
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <Field label={label} hint={hint} layout="aside">{children}</Field>;
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
      <SettingRow label="Avatar" hint="Displayed on your issues and comments.">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{
            width: 48, height: 48, borderRadius: '50%',
            background: 'var(--accent)', color: 'var(--accent-fg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 23, fontWeight: 600,
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
      </SettingRow>
      <SettingRow label="Full name">
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleNameBlur}
        />
      </SettingRow>
      <SettingRow label="Email" hint="Used for sign-in and notifications.">
        <TextInput
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={handleEmailBlur}
        />
      </SettingRow>
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
      <SettingRow label="Theme" hint="Light, dark, or follow system.">
        <div style={{ display: 'flex', gap: 8 }}>
          {(['Light', 'Dark', 'System'] as const).map((t) => {
            const isActive = t === 'System' ? useSystemTheme : (!useSystemTheme && theme === t.toLowerCase());
            return (
              <Btn
                key={t}
                variant="subtle"
                size="md"
                active={isActive}
                onClick={() => t === 'System' ? handleSystemTheme() : handleThemeChange(t.toLowerCase() as ThemeMode)}
              >
                {t}
              </Btn>
            );
          })}
        </div>
      </SettingRow>
      <SettingRow label="Density" hint="How tightly rows and cards pack.">
        <div style={{ display: 'flex', gap: 8 }}>
          {(['Compact', 'Cozy', 'Comfortable'] as const).map((t) => {
            const value = t.toLowerCase() as DensityMode;
            return (
              <Btn
                key={t}
                variant="subtle"
                size="md"
                active={density === value}
                onClick={() => handleDensityChange(value)}
              >
                {t}
              </Btn>
            );
          })}
        </div>
      </SettingRow>
      <SettingRow label="Email notifications" hint="Also send inbox notifications to your email address.">
        <EmailNotificationsField />
      </SettingRow>
      <SettingRow label="Keyboard shortcuts" hint="Enable single-key navigation shortcuts.">
        <Checkbox
          label={shortcutsEnabled ? 'Enabled' : 'Disabled'}
          checked={shortcutsEnabled}
          onChange={(e) => handleShortcutsToggle(e.target.checked)}
        />
      </SettingRow>
    </>
  );
}

function roleRank(role: string | undefined): number {
  switch (role) {
    case 'OWNER': return 3;
    case 'EDITOR': return 2;
    case 'VIEWER': return 1;
    default: return 0;
  }
}

function resolveDisplayRole(user: UserSummary, teamRole?: string): string {
  if (user.globalRole === 'ADMIN') {
    return teamRole === 'OWNER' ? 'Admin · Owner' : 'Admin';
  }
  switch (teamRole) {
    case 'OWNER': return 'Owner';
    case 'EDITOR': return 'Editor';
    case 'VIEWER': return 'Viewer';
    default: return 'Member';
  }
}

