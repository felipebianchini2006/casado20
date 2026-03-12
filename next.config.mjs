/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  outputFileTracingIncludes: {
    '/api/admin/extract-catalog': ['./vendor/poppler/**/*'],
    '/api/admin/upload': ['./vendor/poppler/**/*'],
  },
}

export default nextConfig
