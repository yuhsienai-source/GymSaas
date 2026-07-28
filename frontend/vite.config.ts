import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

const API_TARGET = process.env.VITE_PROXY_API || 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [
    react(),
    basicSsl(), // 本機 HTTPS，手機鏡頭權限較穩
  ],
  server: {
    host: true, // 0.0.0.0，供手機以區網 IP 連入
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/ws': {
        target: API_TARGET,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
