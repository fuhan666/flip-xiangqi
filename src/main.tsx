import { useEffect, useState } from 'react';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import OnlineApp from './OnlineApp';
import RoomApp from './RoomApp';
import './styles.css';

type Route = 'local' | 'menu' | 'online';

function currentRoute(): Route {
  // 在线入口按路径路由（刷新与邀请链接直达）；本地双人仍是 hash 路由。
  if (window.location.pathname === '/online' || window.location.pathname.startsWith('/online/')) {
    return 'online';
  }
  return window.location.hash.startsWith('#/local') ? 'local' : 'menu';
}

function Root() {
  const [route, setRoute] = useState<Route>(currentRoute());

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  if (route === 'online') {
    return <OnlineApp />;
  }
  return route === 'local' ? <App /> : <RoomApp />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
