/*
 * Turf Cricket Pro — device storage (localStorage by default).
 * Each match lives under its own key so saving a ball only rewrites that match,
 * plus a small index used by the home, history and stats screens.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TCPStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const K = {
    teams: 'tcp.teams.v1',
    index: 'tcp.matchIndex.v1',
    match: 'tcp.match.v1.',
    current: 'tcp.current.v1',
    settings: 'tcp.settings.v1',
    photos: 'tcp.photos.v1',
  };
  const DEFAULT_SETTINGS = { sound: true, vibrate: true, wakeLock: true, lastBackup: null };

  function create(backend) {
    function read(key, fallback) {
      try {
        const raw = backend.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    }
    function write(key, value) {
      try {
        backend.setItem(key, JSON.stringify(value));
      } catch (e) {
        const full = e && (e.name === 'QuotaExceededError' || e.code === 22);
        throw new Error(full
          ? 'Phone storage is full. Export a backup, then delete old matches.'
          : 'Could not save on this device. Private/incognito mode may block storage.');
      }
    }
    function indexEntry(m) {
      return {
        id: m.id,
        name: m.config.name,
        date: m.config.date,
        venue: m.config.venue,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        summary: m.summary || null,
      };
    }

    const api = {
      // ----- teams -----
      getTeams() { return read(K.teams, []); },
      getTeam(id) { return api.getTeams().find(t => t.id === id) || null; },
      saveTeam(team) {
        const list = api.getTeams();
        const i = list.findIndex(t => t.id === team.id);
        team.updatedAt = Date.now();
        if (i >= 0) list[i] = team; else list.push(team);
        write(K.teams, list);
        return team;
      },
      deleteTeam(id) { write(K.teams, api.getTeams().filter(t => t.id !== id)); },

      // ----- matches -----
      getMatchIndex() { return read(K.index, []); },
      getMatch(id) { return id ? read(K.match + id, null) : null; },
      saveMatch(m) {
        write(K.match + m.id, m);
        const idx = api.getMatchIndex();
        const i = idx.findIndex(x => x.id === m.id);
        if (i >= 0) idx[i] = indexEntry(m); else idx.push(indexEntry(m));
        write(K.index, idx);
      },
      deleteMatch(id) {
        backend.removeItem(K.match + id);
        write(K.index, api.getMatchIndex().filter(x => x.id !== id));
        if (api.getCurrentId() === id) api.setCurrentId(null);
      },
      getAllMatches() { return api.getMatchIndex().map(x => api.getMatch(x.id)).filter(Boolean); },
      getCurrentId() { return read(K.current, null); },
      setCurrentId(id) { if (id) write(K.current, id); else backend.removeItem(K.current); },

      // ----- settings -----
      getSettings() { return Object.assign({}, DEFAULT_SETTINGS, read(K.settings, {})); },
      saveSettings(s) { write(K.settings, s); },

      // ----- photos: small JPEG data URLs keyed by player id, or 't:<teamId>' for team logos -----
      getPhotos() { return read(K.photos, {}); },
      setPhoto(key, dataUrl) {
        const all = api.getPhotos();
        if (dataUrl) all[key] = dataUrl; else delete all[key];
        write(K.photos, all);
        return all;
      },

      // ----- backup -----
      exportAll() {
        return {
          app: 'turf-cricket-pro',
          version: 1,
          exportedAt: new Date().toISOString(),
          teams: api.getTeams(),
          matches: api.getAllMatches(),
          photos: api.getPhotos(),
        };
      },
      // Merges by id: imported records replace local ones with the same id.
      importAll(data) {
        if (!data || data.app !== 'turf-cricket-pro' || !Array.isArray(data.teams) || !Array.isArray(data.matches)) {
          throw new Error('This file is not a Turf Cricket Pro backup.');
        }
        data.matches.forEach(m => {
          if (!m || !m.id || !m.config || !Array.isArray(m.events)) throw new Error('The backup contains an invalid match.');
        });
        data.teams.forEach(t => { if (t && t.id && t.name) api.saveTeam(t); });
        data.matches.forEach(m => api.saveMatch(m));
        if (data.photos && typeof data.photos === 'object') write(K.photos, Object.assign(api.getPhotos(), data.photos));
        return { teams: data.teams.length, matches: data.matches.length };
      },
      clearAll() {
        api.getMatchIndex().forEach(x => backend.removeItem(K.match + x.id));
        [K.teams, K.index, K.current, K.photos].forEach(k => backend.removeItem(k));
      },
    };
    return api;
  }

  return { create, KEYS: K };
});
