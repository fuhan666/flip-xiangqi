import { useCallback, useEffect, useMemo, useState } from 'react';
import { createHttpRoomControlApi, type RoomControlApi } from './network/control-api';
import { RoomClient, type RoomConnection } from './network/client';
import { defaultStorage, type StorageLike } from './network/recent-rooms';
import { CreateRoomScreen } from './components/rooms/CreateRoomScreen';
import { JoinRoomScreen } from './components/rooms/JoinRoomScreen';
import { MenuScreen } from './components/rooms/MenuScreen';
import { SettingsScreen } from './components/rooms/SettingsScreen';
import { useAudioUnlock } from './components/useGameAudio';
import './rooms.css';

export const APP_VERSION = 'v0.8.0';
const ROOM_PORT_KEY = 'flip-xiangqi.room-port';

type Screen = 'menu' | 'create' | 'join' | 'settings';

interface RoomAppProps {
  api?: RoomControlApi;
  createClient?: () => RoomConnection;
  storage?: StorageLike;
}

function readSavedRoomPort(storage: StorageLike): number | null {
  try {
    const raw = storage.getItem(ROOM_PORT_KEY);
    if (!raw) {
      return null;
    }
    const port = Number(raw);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/** 入口壳：主菜单 → 创建房间 / 加入房间 / 设置 / 本地双人。 */
export default function RoomApp({ api, createClient, storage }: RoomAppProps) {
  const controlApi = useMemo(() => api ?? createHttpRoomControlApi(), [api]);
  const clientFactory = useMemo(() => createClient ?? (() => new RoomClient()), [createClient]);
  const store = useMemo(() => storage ?? defaultStorage(), [storage]);

  // 菜单/大厅阶段的首个用户手势同样解锁音频，进入对局后立即可听。
  useAudioUnlock();

  const [screen, setScreen] = useState<Screen>('menu');
  const [notice, setNotice] = useState<string | null>(null);
  const [hostAvailable, setHostAvailable] = useState(true);
  const [defaultRoomPort, setDefaultRoomPort] = useState(8080);
  const [guestPage, setGuestPage] = useState(false);
  const [guestAddress, setGuestAddress] = useState('');
  const [savedRoomPort, setSavedRoomPort] = useState<number | null>(() => readSavedRoomPort(store));

  useEffect(() => {
    let cancelled = false;
    void controlApi.status().then((status) => {
      if (cancelled) {
        return;
      }
      if (status) {
        setHostAvailable(status.hostAvailable);
        setDefaultRoomPort(status.defaultRoomPort);
      } else {
        setHostAvailable(false);
      }
    });
    void controlApi.isGuestPage().then((isGuest) => {
      if (cancelled) {
        return;
      }
      if (isGuest) {
        setGuestPage(true);
        setGuestAddress(window.location.host);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [controlApi]);

  const handleExitRoom = useCallback((message?: string | null) => {
    setNotice(message ?? null);
    setScreen('menu');
  }, []);

  const handleSaveRoomPort = useCallback(
    (port: number | null) => {
      setSavedRoomPort(port);
      try {
        if (port === null) {
          store.setItem(ROOM_PORT_KEY, '');
        } else {
          store.setItem(ROOM_PORT_KEY, String(port));
        }
      } catch {
        // 存储不可用时仅本次生效。
      }
    },
    [store],
  );

  return (
    <>
      {screen === 'menu' ? (
        <MenuScreen
          hostAvailable={hostAvailable}
          onCreateRoom={() => {
            setNotice(null);
            setScreen(hostAvailable ? 'create' : 'join');
          }}
          onJoinRoom={() => {
            setNotice(null);
            setScreen('join');
          }}
          onLocalGame={() => {
            window.location.hash = '#/local';
          }}
          onSettings={() => {
            setNotice(null);
            setScreen('settings');
          }}
          version={APP_VERSION}
        />
      ) : null}

      {screen === 'create' ? (
        <CreateRoomScreen
          api={controlApi}
          createClient={clientFactory}
          onExit={handleExitRoom}
          preferredPort={savedRoomPort ?? defaultRoomPort}
        />
      ) : null}

      {screen === 'join' ? (
        <JoinRoomScreen
          createClient={clientFactory}
          guestPage={guestPage}
          initialAddress={guestAddress}
          onExit={handleExitRoom}
          storage={store}
        />
      ) : null}

      {screen === 'settings' ? (
        <SettingsScreen
          defaultRoomPort={defaultRoomPort}
          onBack={() => setScreen('menu')}
          onSaveRoomPort={handleSaveRoomPort}
          savedRoomPort={savedRoomPort}
        />
      ) : null}

      {screen === 'menu' && notice ? (
        <div aria-live="polite" className="menu-toast" data-testid="menu-toast">
          {notice}
        </div>
      ) : null}
    </>
  );
}
