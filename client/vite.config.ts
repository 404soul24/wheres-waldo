import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The server owns the round, so development talks to it exactly as the
  // deployed build does. See ADR-0001.
  server: { proxy: { "/api": "http://localhost:3000" } },
});