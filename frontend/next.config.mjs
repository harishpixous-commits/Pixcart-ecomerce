/** @type {import('next').NextConfig} */
const API = process.env.API_ORIGIN || "http://localhost:8000";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Microphone only for this site's own pages (the admin assistant's dictation and voice mode).
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
];

const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // The browser talks to one origin; /api and /media are proxied to the FastAPI service.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API}/api/:path*` },
      { source: "/media/:path*", destination: `${API}/media/:path*` },
    ];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
