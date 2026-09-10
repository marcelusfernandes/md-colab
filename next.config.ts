import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Vinext emits its self-contained Node server only for this output mode. The
  // Workers build remains unchanged and continues to produce dist/server.
  output:
    process.env.MD_COLAB_RUNTIME === 'node' ? 'standalone' : undefined,
};

export default nextConfig;
