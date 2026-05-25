/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lint is still available via `npm run lint`; we don't block builds on it.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
