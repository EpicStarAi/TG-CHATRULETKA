import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the UI (5173) proxies API and WebSocket calls to the Node server (8080).
const api = process.env.API_PROXY || 'http://127.0.0.1:8080';
const proxy = {
  '/auth': api,
  '/config': api,
  '/health': api,
  '/ws': { target: api, ws: true },
};
export default defineConfig({ plugins: [react()], server: { port: 5173, proxy }, preview: { proxy } });
