// Preloaded into Geode's main process (NODE_OPTIONS=--require) by the remote-threads e2e so
// `app.secretStorage` falls back to localStorage in the throwaway profile instead of touching
// the macOS keychain (which could raise a system dialog during a hidden run).
const electron = require('electron');
if (electron && electron.safeStorage) electron.safeStorage.isEncryptionAvailable = () => false;
