import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "127.0.0.1",
    port: 8080,
    proxy: {
      // The browser client talks to the Hearth API on the same origin; in dev
      // the API runs separately (npm start, default port 8787).
      '/api': { target: process.env.VITE_DEV_API_URL || 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
