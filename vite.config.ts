import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
          secure: false,
          ws: false, // Disable WebSocket proxy to avoid connection errors
          timeout: 5000,
          configure: (proxy, _options) => {
            let lastErrorTime = 0;
            const ERROR_SUPPRESS_INTERVAL = 10000; // Only show error once per 10 seconds
            
            proxy.on('error', (err, req, res) => {
              const now = Date.now();
              const isConnectionError = err.code === 'ECONNREFUSED' || 
                                      err.code === 'ECONNRESET' || 
                                      err.code === 'ETIMEDOUT';
              
              // Suppress connection errors completely (backend might not be running)
              if (isConnectionError) {
                // Only log once per interval to avoid spam
                if (now - lastErrorTime > ERROR_SUPPRESS_INTERVAL) {
                  console.warn(`[Vite Proxy] Backend server at http://localhost:3001 is not running. Please start it with: npm run dev:server`);
                  lastErrorTime = now;
                }
                // Return a proper error response to the client
                if (res && !res.headersSent) {
                  res.writeHead(503, {
                    'Content-Type': 'application/json',
                  });
                  res.end(JSON.stringify({ 
                    error: 'Backend server is not running. Please start it with: npm run dev:server' 
                  }));
                }
                return;
              }
              
              // Log other unexpected errors
              console.error('[Vite Proxy] Unexpected error:', err);
            });
          }
        }
      }
    },
    plugins: [react()],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    },
    optimizeDeps: {
      include: ['xlsx'],
      exclude: []
    },
    build: {
      commonjsOptions: {
        include: [/xlsx/, /node_modules/],
        transformMixedEsModules: true
      },
      rollupOptions: {
        output: {
          manualChunks: undefined
        }
      }
    }
  };
});
