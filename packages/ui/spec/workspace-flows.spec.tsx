import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  AuthenticatedPlatformApp,
  MockAuthClient,
  MockPlatformClient,
  PlatformApp,
  PlatformError,
} from '../src/index.ts';
import type { VoiceEvent } from '../src/index.ts';

const button = (name: string) => screen.getByRole('button', { name });
const dialog = (name: string) => within(screen.getByRole('dialog', { name }));
function route(path: string) {
  window.history.replaceState(null, '', '/' + '#' + path);
}
async function go(path: string) {
  await act(async () => {
    window.location.hash = '#' + path;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

test('sign-in redirects, validates callback once, refreshes and signs out', async () => {
  const auth = new MockAuthClient();
  const client = new MockPlatformClient({ auth });
  const navigate = vi.fn();
  const callback = vi.spyOn(auth, 'callback');
  const refresh = vi.spyOn(auth, 'refresh');
  const signOut = vi.spyOn(auth, 'logout');
  const app = (key: number) => (
    <StrictMode>
      <AuthenticatedPlatformApp key={key} client={client} navigate={navigate} />
    </StrictMode>
  );
  const { rerender } = render(app(0));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Sign in with your identity provider' }),
  );
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/?code=fixture-code&state=fixture-1'));
  window.history.replaceState(null, '', navigate.mock.calls[0][0]);
  rerender(app(1));
  await screen.findByRole('heading', { name: 'Overview' });
  expect(callback).toHaveBeenCalledExactlyOnceWith('fixture-code', 'fixture-1');
  expect(window.location.search).toBe('');
  fireEvent.click(screen.getByLabelText(/User menu/));
  fireEvent.click(button('Refresh session'));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  fireEvent.click(button('Sign out'));
  expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  expect(signOut).toHaveBeenCalledTimes(1);
});

test('requires fresh MFA for a sensitive action and shows the invitation only once', async () => {
  route('/members');
  const auth = new MockAuthClient(true);
  const client = new MockPlatformClient({ auth, requireFreshMfa: true });
  const navigate = vi.fn();
  const app = (key: number) => (
    <AuthenticatedPlatformApp key={key} client={client} navigate={navigate} />
  );
  const { rerender } = render(app(0));
  fireEvent.click(await screen.findByRole('button', { name: 'Invite member' }));
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'mina@rivetquay.example' } });
  fireEvent.click(button('Create invitation'));
  await screen.findByRole('dialog', { name: 'Verify your identity' });
  fireEvent.click(button('Sign in with MFA'));
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  expect(await client.access.setupProgress()).toEqual({
    completed: ['import_records', 'choose_providers'],
  });
  window.history.replaceState(null, '', navigate.mock.calls[0][0]);
  rerender(app(1));
  fireEvent.click(await screen.findByRole('button', { name: 'Invite member' }));
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'mina@rivetquay.example' } });
  fireEvent.click(button('Create invitation'));
  expect(await screen.findByText(/invite\.rivetquay\.example/)).toBeTruthy();
  expect(screen.getByText(/Expires/).querySelector('time')?.dateTime).toBe(
    '2026-11-26T15:00:00.000Z',
  );
  fireEvent.click(button('Done'));
  expect(screen.queryByText(/invite\.rivetquay\.example/)).toBeNull();
  await go('/');
  expect(await screen.findByText('3 of 5 steps complete')).toBeTruthy();
});

test('creates a role from named permissions, assigns it and removes a member', async () => {
  route('/roles');
  render(<PlatformApp client={new MockPlatformClient()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'New custom role' }));
  fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Warehouse reviewer' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Read records' }));
  fireEvent.click(button('Save custom role'));
  expect(await screen.findByText('Warehouse reviewer')).toBeTruthy();
  await go('/members');
  fireEvent.click(await screen.findByRole('button', { name: 'Change role for Tess Okafor' }));
  const rolePicker = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Role' });
  const value = Array.from(rolePicker.options).find(
    (option) => option.textContent === 'Warehouse reviewer',
  )?.value;
  fireEvent.change(rolePicker, { target: { value } });
  fireEvent.click(button('Save role'));
  expect(await screen.findByRole('cell', { name: 'Warehouse reviewer' })).toBeTruthy();
  fireEvent.click(button('Remove Tess Okafor'));
  fireEvent.click(button('Confirm removal'));
  await waitFor(() => expect(screen.queryByText('Tess Okafor')).toBeNull());
});

test('provisions, suspends and resumes a tenant using platform operator permissions', async () => {
  route('/tenants');
  const client = new MockPlatformClient({ role: 'operator', platformOperator: true });
  render(<PlatformApp client={client} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Provision tenant' }));
  fireEvent.change(await screen.findByLabelText('Tenant name'), {
    target: { value: 'Spoolyard Supply' },
  });
  fireEvent.change(screen.getByLabelText('Plan'), { target: { value: 'operations' } });
  fireEvent.click(button('Continue'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Workflows' }));
  fireEvent.change(screen.getByLabelText('speech-to-text'), {
    target: { value: 'fixture-speech' },
  });
  fireEvent.click(button('Continue'));
  expect(screen.getByText('llm / fixture-native, speech-to-text / fixture-speech')).toBeTruthy();
  fireEvent.click(button('Create tenant'));
  expect(await screen.findByRole('cell', { name: 'Spoolyard Supply' })).toBeTruthy();
  fireEvent.click(button('Suspend Spoolyard Supply'));
  fireEvent.click(button('Confirm suspend'));
  fireEvent.click(await screen.findByRole('button', { name: 'Resume Spoolyard Supply' }));
  fireEvent.click(button('Confirm resume'));
  await screen.findByRole('button', { name: 'Suspend Spoolyard Supply' });
  expect((await client.access.listTenants()).at(-1)).toMatchObject({
    status: 'active',
    region: 'ca-central-1',
    plan: 'operations',
    modules: ['records', 'ai', 'workflows'],
  });
});

test('hides admin actions from a reader and reports a server-side denial inside a dialog', async () => {
  route('/roles');
  const { rerender } = render(<PlatformApp client={new MockPlatformClient({ role: 'reader' })} />);
  expect(await screen.findByText('Workspace administrator access is required.')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Roles' })).toBeNull();
  await go('/tenants');
  expect(await screen.findByText('Platform operator access is required.')).toBeTruthy();
  await go('/members');
  await screen.findByRole('table', { name: 'Workspace members' });
  expect(screen.queryByRole('button', { name: 'Invite member' })).toBeNull();
  const client = new MockPlatformClient();
  vi.spyOn(client.access, 'invite').mockRejectedValue(new PlatformError('forbidden'));
  rerender(<PlatformApp client={client} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Invite member' }));
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'mina@rivetquay.example' } });
  fireEvent.click(button('Create invitation'));
  expect((await dialog('Invite member').findByRole('alert')).textContent).toContain('permission');
});

test('streams a bot reply, shows an approval interruption and hands the chat to staff and back', async () => {
  route('/conversations');
  const client = new MockPlatformClient();
  render(<PlatformApp client={client} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Marlspoke Fabrication' }));
  const composer = await screen.findByLabelText('Customer message');
  fireEvent.change(composer, { target: { value: 'Check order ord-001' } });
  fireEvent.click(button('Send to bot'));
  expect(await screen.findByText('Rivetquay fixture run completed.')).toBeTruthy();
  fireEvent.change(composer, { target: { value: 'Draft PO for pr-001' } });
  fireEvent.click(button('Send to bot'));
  expect(await screen.findByRole('heading', { name: 'Approval required' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve and resume' })).toBeNull();
  fireEvent.click(button('Take over'));
  fireEvent.change(await screen.findByLabelText('Staff reply'), {
    target: { value: 'I can review that for you.' },
  });
  fireEvent.click(button('Send staff reply'));
  expect(await screen.findByText('I can review that for you.')).toBeTruthy();
  fireEvent.click(button('Hand back to bot'));
  expect(await screen.findByLabelText('Customer message')).toBeTruthy();
  const saved = await client.conversations.get('conversation-chat-001');
  expect(saved.session.handoff).toBe('bot');
  expect(saved.activeRunId).toBeUndefined();
  expect(saved.transcript.map((line) => line.speaker)).toEqual([
    'customer',
    'customer',
    'bot',
    'customer',
    'staff',
  ]);
});

test('records a voice turn, displays streamed transcript partials and interrupts playback', async () => {
  route('/conversations');
  const client = new MockPlatformClient();
  const stopTrack = vi.fn();
  const pause = vi.fn();
  const play = vi.fn(async () => {});
  const removeAttribute = vi.fn();
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) },
  });
  vi.stubGlobal(
    'Audio',
    class {
      play = play;
      pause = pause;
      removeAttribute = removeAttribute;
    },
  );
  vi.stubGlobal(
    'MediaRecorder',
    class {
      state = 'inactive';
      mimeType = 'audio/webm';
      ondataavailable?: (event: { data: Blob }) => void;
      onstop?: () => void;
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['fixture'], { type: this.mimeType }) });
        this.onstop?.();
      }
    },
  );
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const voice = vi
    .spyOn(client.conversations, 'voiceTurn')
    .mockImplementation(async function* (): AsyncIterable<VoiceEvent> {
      yield { kind: 'partial', text: 'Check order…' };
      await gate;
      yield {
        kind: 'transcript',
        line: { id: 'voice-line', speaker: 'customer', text: 'Check order ord-001.' },
      };
      yield { kind: 'audio', mimeType: 'audio/wav', base64: 'UklGRg==' };
      yield { kind: 'settled' };
    });
  try {
    render(<PlatformApp client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Quayline Machine Works' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Take over' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Hand back to bot' }));
    const talk = await screen.findByRole('button', { name: 'Push to talk' });
    fireEvent.click(talk, { detail: 0 });
    await screen.findByText('Recording…');
    fireEvent.click(talk, { detail: 0 });
    expect(await screen.findByText(/Check order…/)).toBeTruthy();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(voice.mock.calls[0][1].type).toBe('audio/webm');
    await act(async () => finish());
    expect(await screen.findByText('Check order ord-001.')).toBeTruthy();
    expect(play).toHaveBeenCalledOnce();
    fireEvent.click(button('Interrupt voice reply'));
    expect(pause).toHaveBeenCalledOnce();
    expect(removeAttribute).toHaveBeenCalledWith('src');
  } finally {
    cleanup();
    if (descriptor) Object.defineProperty(navigator, 'mediaDevices', descriptor);
    else Reflect.deleteProperty(navigator, 'mediaDevices');
  }
});

test('streams tool arguments and JSON-schema output with routing and token metadata', async () => {
  route('/llm');
  const client = new MockPlatformClient();
  render(<PlatformApp client={client} />);
  fireEvent.change(await screen.findByLabelText('Response mode'), { target: { value: 'tool' } });
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Look up ord-001' } });
  fireEvent.click(button('Run completion'));
  expect(await screen.findByText('{"order_id":"ord-001"}')).toBeTruthy();
  expect(screen.getByText('fixture-native')).toBeTruthy();
  expect(screen.getByText('Binding version').nextElementSibling?.textContent).toBe('1');
  expect(screen.getByText('Total tokens').nextElementSibling?.textContent).toBe('20');
  fireEvent.change(screen.getByLabelText('Response mode'), { target: { value: 'schema' } });
  fireEvent.click(button('Run completion'));
  expect(await screen.findByText('{"status":"confirmed"}')).toBeTruthy();
});

test('creates and revokes a Connections LLM key and clears the full secret when closed', async () => {
  route('/connections');
  render(<PlatformApp client={new MockPlatformClient()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'New LLM API key' }));
  fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'Fixture notebook' } });
  fireEvent.click(button('Create LLM key'));
  expect(await screen.findByText('rq-fixture-1-display-once')).toBeTruthy();
  fireEvent.click(button('Done'));
  expect(screen.queryByText('rq-fixture-1-display-once')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke LLM key Fixture notebook' }));
  fireEvent.click(button('Confirm key revocation'));
  expect(await screen.findByText('No LLM API keys have been created.')).toBeTruthy();
});
