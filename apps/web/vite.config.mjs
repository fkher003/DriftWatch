export default {
  server: {
    proxy: {
      "/sandbox": "http://localhost:3000",
      "/api": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ["recharts"],
          react: ["react", "react-dom", "react-dom/client"],
          validation: ["zod"],
        },
      },
    },
  },
};
