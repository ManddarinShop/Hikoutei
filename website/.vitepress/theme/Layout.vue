<script setup>
import DefaultTheme from "vitepress/theme";
import { withBase } from "vitepress";
import { onBeforeUnmount, onMounted, onUpdated } from "vue";
import SiteFooter from "./components/SiteFooter.vue";

const { Layout } = DefaultTheme;

const demoScrollClass = "is-demo-scrolled";
const headerHiddenClass = "is-header-hidden";
let updateDemoScrollState = () => {};

onMounted(() => {
  updateDemoScrollState = () => {
    const currentScrollY = window.scrollY;
    const isAtTop = currentScrollY <= 24;

    document.body.classList.toggle(demoScrollClass, !isAtTop);
    document.body.classList.toggle(headerHiddenClass, !isAtTop);
  };

  updateDemoScrollState();
  window.addEventListener("scroll", updateDemoScrollState, { passive: true });
});

onUpdated(() => {
  updateDemoScrollState();
});

onBeforeUnmount(() => {
  window.removeEventListener("scroll", updateDemoScrollState);
  document.body.classList.remove(demoScrollClass);
  document.body.classList.remove(headerHiddenClass);
});
</script>

<template>
  <Layout>
    <template #nav-bar-content-after>
      <a class="nav-cta" :href="withBase('/guide/quick-start')">Get Started</a>
    </template>
    <template #layout-bottom>
      <SiteFooter />
    </template>
  </Layout>
</template>
