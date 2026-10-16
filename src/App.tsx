import { useCallback, useEffect, useState } from 'react';
import { Camera, Layers, Users, Settings as Cog } from 'lucide-react';
import { ApiError, getInfo, setAccessHandler, type Info } from './api';
import { ScanHome } from './screens/ScanHome';
import { BatchesScreen, BatchScreen } from './screens/Batch';
import { ReviewScreen } from './screens/Review';
import { ContactsScreen } from './screens/Contacts';
import { SettingsScreen } from './screens/Settings';
import { AccessScreen } from './screens/Access';
import { FirstRun } from './screens/FirstRun';
import { storageGet } from './util';

export type Route =
  | { name: 'scan' }
  | { name: 'batches' }
  | { name: 'batch'; id: string }
  | { name: 'contact'; id: string; from?: string }
  | { name: 'contacts' }
  | { name: 'settings' };

function parse(hash: string): Route {
  const [, a, b] = hash.replace(/^#/, '').split('/');
  if (a === 'batches') return { name: 'batches' };
  if (a === 'batch' && b) return { name: 'batch', id: b };
  if (a === 'contact' && b) {
    const [id, from] = b.split('?from=');
    return { name: 'contact', id, from };
  }
  if (a === 'contacts') return { name: 'contacts' };
  if (a === 'settings') return { name: 'settings' };
  return { name: 'scan' };
}

export function go(path: string) {
  window.location.hash = path;
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));
  const [info, setInfo] = useState<Info | null>(null);
  const [needAccess, setNeedAccess] = useState(false);
  const [offline, setOffline] = useState<string | null>(null);
  const [firstRun, setFirstRun] = useState(() => !storageGet('buz-first-run-done'));

  useEffect(() => {
    const on = () => {
      setRoute(parse(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const refreshInfo = useCallback(async () => {
    try {
      setInfo(await getInfo());
      setOffline(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'access_code_required') setNeedAccess(true);
      else setOffline((e as Error).message);
    }
  }, []);

  useEffect(() => {
    setAccessHandler(() => setNeedAccess(true));
    void refreshInfo();
    const t = setInterval(refreshInfo, 15000);
    return () => clearInterval(t);
  }, [refreshInfo]);

  if (needAccess)
    return (
      <AccessScreen
        onDone={() => {
          setNeedAccess(false);
          void refreshInfo();
        }}
      />
    );

  const drafts = info?.counts.drafts ?? 0;
  const tab =
    route.name === 'batch' || route.name === 'batches' ? 'batches' : route.name === 'contact' ? (route.from === 'batch' ? 'batches' : 'contacts') : route.name;
  return (
    <div className="app">
      <div className="brand-side">Buz Cards</div>
      {offline && (
        <div className="notice error" role="alert" style={{ borderRadius: 0 }}>
          {offline}{' '}
          <button className="btn small" onClick={refreshInfo}>
            Try again
          </button>
        </div>
      )}
      {info?.modelStatus === 'error' && <div className="notice error">Card recognition could not start on the computer: {info.modelError}</div>}
      {route.name === 'scan' && <ScanHome info={info} />}
      {route.name === 'batches' && <BatchesScreen />}
      {route.name === 'batch' && <BatchScreen id={route.id} info={info} />}
      {route.name === 'contact' && <ReviewScreen id={route.id} from={route.from} onChanged={refreshInfo} />}
      {route.name === 'contacts' && <ContactsScreen info={info} />}
      {route.name === 'settings' && <SettingsScreen info={info} onShowIntro={() => setFirstRun(true)} />}
      <nav className="tabbar" aria-label="Main">
        <a href="#/" aria-current={tab === 'scan' ? 'page' : undefined}>
          <Camera size={22} aria-hidden /> Scan
        </a>
        <a href="#/batches" aria-current={tab === 'batches' ? 'page' : undefined}>
          <Layers size={22} aria-hidden /> Review
          {drafts > 0 && <span className="badge">{drafts}</span>}
        </a>
        <a href="#/contacts" aria-current={tab === 'contacts' ? 'page' : undefined}>
          <Users size={22} aria-hidden /> Contacts
        </a>
        <a href="#/settings" aria-current={tab === 'settings' ? 'page' : undefined}>
          <Cog size={22} aria-hidden /> Settings
        </a>
      </nav>
      {firstRun && info && <FirstRun info={info} onClose={() => setFirstRun(false)} />}
    </div>
  );
}
