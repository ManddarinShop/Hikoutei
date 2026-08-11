<script setup>
import DefaultTheme from "vitepress/theme";

const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <template #nav-bar-content-after>
      <a class="nav-cta" href="/guide/quick-start">Get Started</a>
    </template>
  </Layout>
</template>
