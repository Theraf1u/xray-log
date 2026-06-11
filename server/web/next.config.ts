import type { NextConfig } from "next";
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  output: "standalone",

  // Don't advertise the framework via the x-powered-by header.
  poweredByHeader: false,

  // Never ship browser source maps to production clients.
  productionBrowserSourceMaps: false,

  // Baseline security headers for the dashboard UI. (A strict CSP is left to
  // the reverse proxy / a follow-up because Mapbox + Next inline styles need
  // tailored directives.)
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },

  // Proxy API calls to Go backend
  // Note: WebSocket connections are handled directly in websocket-context.tsx
  // because Next.js rewrites don't support WebSocket properly
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:8237/api/:path*",
      },
      {
        source: "/health",
        destination: "http://localhost:8237/health",
      },
    ];
  },
};

export default withNextIntl(nextConfig);
