import { useEffect, useState } from 'react';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import RoomApp from './RoomApp';
import './styles.css';

function currentRoute(): 'local' | 'menu' {
  return window.location.hash.startsWith('#/local') ? 'local' : 'menu';
}

function Root() {
  const [route, setRoute] = useState<'local' | 'menu'>(currentRoute());

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return route === 'local' ? <App /> : <RoomApp />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
