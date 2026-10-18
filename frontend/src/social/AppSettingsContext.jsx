import { createContext, useContext, useState, useEffect } from 'react';
import { api } from './api.js';

const AppSettingsContext = createContext({});

export function useAppSettings() {
  return useContext(AppSettingsContext);
}

export function AppSettingsProvider({ children }) {
  const [settings, setSettings] = useState({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.getSettings()
      .then(data => setSettings(data))
      .catch(() => setSettings({}))
      .finally(() => setLoaded(true));
  }, []);

  return (
    <AppSettingsContext.Provider value={{ ...settings, loaded }}>
      {children}
    </AppSettingsContext.Provider>
  );
}
