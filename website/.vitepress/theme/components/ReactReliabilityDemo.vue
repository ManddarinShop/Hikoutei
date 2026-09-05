<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { Root } from "react-dom/client";

const mountPoint = ref<HTMLElement | null>(null);
let reactRoot: Root | null = null;

// Mount the demo client-side so VitePress can keep rendering the docs shell on the server.
onMounted(async () => {
  const [{ createRoot }, { default: React }, { default: ReliabilityDemo }] = await Promise.all([
    import("react-dom/client"),
    import("react"),
    import("../../../demo/frontend/App.jsx"),
  ]);

  if (mountPoint.value === null) {
    return;
  }

  reactRoot = createRoot(mountPoint.value);
  reactRoot.render(React.createElement(ReliabilityDemo));
});

onBeforeUnmount(() => {
  reactRoot?.unmount();
  reactRoot = null;
});
</script>

<template>
  <div ref="mountPoint" class="react-reliability-demo-root" />
</template>
