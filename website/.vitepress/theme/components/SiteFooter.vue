<script setup>
import { withBase } from "vitepress";
</script>

<template>
  <footer class="site-footer">
    <div class="site-footer__cols">
      <div class="site-footer__col">
        <div class="site-footer__heading">Guide</div>
        <a :href="withBase('/guide/quick-start')">Quick start</a>
        <a :href="withBase('/guide/setup')">Google Sheets setup</a>
        <a :href="withBase('/guide/architecture')">Architecture</a>
        <a :href="withBase('/guide/sync-flow')">Sync flow</a>
      </div>
      <div class="site-footer__col">
        <div class="site-footer__heading">Resources</div>
        <a :href="withBase('/guide/benchmarks')">Benchmarks</a>
        <a :href="withBase('/guide/internal-consistency')">Consistency model</a>
        <a :href="withBase('/guide/limitations')">Limitations</a>
        <a :href="withBase('/guide/status')">Project status</a>
      </div>
      <div class="site-footer__col">
        <div class="site-footer__heading">Community</div>
        <a href="https://github.com/ManddarinShop/Hikoutei">GitHub</a>
        <a href="https://www.npmjs.com/package/hikoutei">npm</a>
        <a :href="withBase('/guide/contributing')">Contributing</a>
        <a :href="withBase('/guide/release-process')">Release process</a>
      </div>
    </div>
    <div class="site-footer__bottom">© 2026 Hikoutei · MIT Licensed</div>
  </footer>
</template>
