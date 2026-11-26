import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

function singleFileInline(): Plugin {
  return {
    name: 'single-file-inline',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      if (process.env.SINGLE_FILE !== '1') return;
      const htmlKey = Object.keys(bundle).find((k) => k.endsWith('.html'));
      if (!htmlKey) return;
      const htmlAsset = bundle[htmlKey];
      if (htmlAsset.type !== 'asset') return;
      let html = String(htmlAsset.source);
      for (const [key, item] of Object.entries(bundle)) {
        if (key === htmlKey) continue;
        if (item.type === 'chunk' && item.isEntry) {
          const escaped = item.code
            .replace(/<\/script/gi, '<\\/script')
            .replace(/<!--/g, '<\\!--');
          html = html.replace(
            new RegExp(`<script[^>]*src=["'][^"']*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>\\s*</script>`, 'i'),
            () => `<script type="module">\n${escaped}\n</script>`
          );
          delete bundle[key];
        } else if (item.type === 'asset' && key.endsWith('.css')) {
          html = html.replace(
            new RegExp(`<link[^>]*href=["'][^"']*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i'),
            () => `<style>\n${String(item.source)}\n</style>`
          );
          delete bundle[key];
        }
      }
      htmlAsset.source = html;
    }
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), singleFileInline()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
    }
  }
});
