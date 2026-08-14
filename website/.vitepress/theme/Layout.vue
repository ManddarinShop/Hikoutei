<script setup>
import DefaultTheme from "vitepress/theme";
import { withBase } from "vitepress";
import SiteFooter from "./components/SiteFooter.vue";

const { Layout } = DefaultTheme;
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
