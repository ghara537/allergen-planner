import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon-180.png", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "Allergen Planner",
        short_name: "Allergens",
        description: "Week-by-week solids and allergen schedule",
        // standalone = launches without Safari chrome, like an app
        display: "standalone",
        orientation: "portrait",
        background_color: "#0F1317",
        theme_color: "#0F1317",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,json}"],
        // The app shell works offline. API calls fall back to the local
        // IndexedDB copy, which is the source of truth on-device anyway.
        navigateFallback: "/index.html",
        runtimeCaching: [
          {
            urlPattern: /\/api\/.*/,
            handler: "NetworkOnly"
          }
        ]
      }
    })
  ]
});
